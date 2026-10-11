import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { z } from 'zod';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { simpleParser } from 'mailparser';
import { db, schema } from '../../db/client.js';
import { env } from '../../config/env.js';
import { analizarSolicitud } from '../ai/analisis-adjuntos.js';
import { extractPeople } from '../ai/classifier.js';
import { extractPdfText } from '../ocr/service.js';
import { normalizeCuil, normalizeDni, esCuilValido } from '../personas/service.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { contentDisposition, isZip } from '../../lib/files.js';
import { audit } from '../../lib/audit.js';
import { nowIso } from '../../lib/datetime.js';
import { processEmail, parseLocalFromSubject, parseTipo, leerPersonasDelCorreo, detectarSolicitudDestino, esExcel, conflictoDeLocal, buscarNroOrden } from '../processing/processor.js';
import { pareceNombreDePersona, splitNombreCompleto } from '../personas/service.js';
import { buscarLocal } from '../locales/service.js';
import { sendMail } from '../email/mailer.js';
import { extractZip } from '../processing/zip.js';

/** Adjuntos "planos": expande los ZIP para mostrar los archivos de adentro (PDF, etc.). */
function flattenAttachments(parsed: ParsedEmail): { filename: string; contentType?: string; content: Buffer }[] {
  const out: { filename: string; contentType?: string; content: Buffer }[] = [];
  for (const a of parsed.attachments ?? []) {
    const name = a.filename ?? 'adjunto';
    const buf = a.content as Buffer;
    if (isZip(name, a.contentType)) {
      try {
        for (const f of extractZip(buf).files) out.push({ filename: f.filename, content: f.buffer });
        continue;
      } catch { /* si no se puede abrir el zip, se muestra el zip tal cual */ }
    }
    out.push({ filename: name, contentType: a.contentType, content: buf });
  }
  return out;
}

// Estados de email que quedan en el "respaldo" (no terminaron en una solicitud automática).
const ESTADOS_RESPALDO = ['NEEDS_REVIEW', 'ERROR'];

const MIME: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

// Cache del email parseado. Parsear un .eml (con sus adjuntos) es caro; el visor pide
// la lista y después cada PDF por separado, así que sin cache se re-parsea el mismo mail
// muchas veces seguidas. Guardamos los últimos por id+mtime, con TTL corto.
type ParsedEmail = Awaited<ReturnType<typeof simpleParser>>;
const parseCache = new Map<number, { mtimeMs: number; parsed: ParsedEmail; at: number }>();
const CACHE_MAX = 4;
const CACHE_TTL_MS = 3 * 60 * 1000;

async function parseEmail(emailId: number) {
  const email = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, emailId)).get();
  if (!email) throw notFound('Email no encontrado.');
  // Los .eml se borran del disco pasada la retención (el original queda en la casilla). El mensaje
  // tiene que decir eso y no un "no disponible" que suena a que se perdió algo.
  if (!email.rawStoredPath || !fs.existsSync(email.rawStoredPath)) {
    throw notFound(`El correo original ya no se conserva en el sistema (se guardan ${env.mail.retencionMeses} meses). Sigue estando en la casilla ${env.mail.imapUser}.`);
  }

  const mtimeMs = fs.statSync(email.rawStoredPath).mtimeMs;
  const hit = parseCache.get(emailId);
  if (hit && hit.mtimeMs === mtimeMs && Date.now() - hit.at < CACHE_TTL_MS) {
    hit.at = Date.now();
    return { email, parsed: hit.parsed };
  }

  const parsed = await simpleParser(fs.readFileSync(email.rawStoredPath));
  parseCache.set(emailId, { mtimeMs, parsed, at: Date.now() });
  // Evitar que el cache crezca: descartar el más viejo.
  if (parseCache.size > CACHE_MAX) {
    let oldestId = -1;
    let oldestAt = Infinity;
    for (const [id, v] of parseCache) if (v.at < oldestAt) { oldestAt = v.at; oldestId = id; }
    if (oldestId >= 0) parseCache.delete(oldestId);
  }
  return { email, parsed };
}

/**
 * Todos los correos que aportan documentación a una solicitud: el que la originó, los de sus
 * solicitudes hermanas (las que salieron del mismo correo) y las respuestas que se le sumaron.
 */
function correosDeSolicitud(solicitudId: number): { emailIds: number[]; originales: number[] } {
  const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get();
  if (!sol) return { emailIds: [], originales: [] };
  const hermanas = sol.emailMessageId != null
    ? db.select({ id: schema.solicitudes.id, emailMessageId: schema.solicitudes.emailMessageId }).from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, sol.emailMessageId)).all()
    : [{ id: sol.id, emailMessageId: sol.emailMessageId }];
  const hermanaIds = [...new Set(hermanas.map((h) => h.id))];
  const originales = hermanas.map((h) => h.emailMessageId).filter((x): x is number => x != null);
  const respuestas = db.select({ id: schema.emailMessages.id })
    .from(schema.emailMessages)
    .where(inArray(schema.emailMessages.replySolicitudId, hermanaIds))
    .all().map((r) => r.id);
  return { emailIds: [...new Set([...originales, ...respuestas])], originales };
}

export async function emailsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAuth);

  // Lista de adjuntos de un email (para el visor "Ver email").
  app.get('/:id/adjuntos', async (req) => {
    const id = Number((req.params as any).id);
    const { email, parsed } = await parseEmail(id);
    const adjuntos = flattenAttachments(parsed).map((a, i) => ({
      index: i,
      filename: a.filename ?? `adjunto-${i + 1}`,
      contentType: a.contentType,
      size: a.content?.length ?? 0,
    }));
    return {
      remitente: email.remitente,
      asunto: email.asunto,
      fecha: email.fechaEmail,
      cuerpo: parsed.text ?? '',
      adjuntos,
    };
  });

  // Sirve un adjunto puntual (inline) de forma protegida.
  app.get('/:id/adjuntos/:index', async (req, reply) => {
    const id = Number((req.params as any).id);
    const index = Number((req.params as any).index);
    const { parsed } = await parseEmail(id);
    const att = flattenAttachments(parsed)[index];
    if (!att) throw notFound('Adjunto no encontrado.');
    const ext = (att.filename ?? '').split('.').pop()?.toLowerCase() ?? '';
    reply.header('Content-Type', att.contentType || MIME[ext] || 'application/octet-stream');
    reply.header('Content-Disposition', contentDisposition('inline', att.filename ?? 'adjunto'));
    return reply.send(att.content);
  });

  // Qué dice cada papel y de quién habla. No aprueba ni cambia nada: es información al costado,
  // para no abrir nueve PDF buscando los CUIL a ojo. Se apaga con ANALISIS_ADJUNTOS=0.
  app.get('/solicitud/:solicitudId/analisis', { onRequest: app.requireAdmin }, async (req) => {
    const solicitudId = Number((req.params as any).solicitudId);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    if (!env.analisisAdjuntos) return { activo: false, adjuntos: [], cubiertas: [], sinCubrir: [], ajenas: [], sinLeer: 0 };

    const { emailIds } = correosDeSolicitud(solicitudId);
    const items: { emailId: number; index: number; filename: string; contentType?: string; content: Buffer }[] = [];
    for (const emailId of emailIds) {
      let parsed;
      try { ({ parsed } = await parseEmail(emailId)); } catch { continue; }
      flattenAttachments(parsed).forEach((a, index) => {
        if (esExcel(a.filename ?? '', a.contentType)) return;
        items.push({ emailId, index, filename: a.filename ?? `adjunto-${index + 1}`, contentType: a.contentType, content: a.content });
      });
    }
    return analizarSolicitud(solicitudId, items);
  });

  /**
   * Las personas que NOMBRAN los PDF de la solicitud, para poder importarlas en vez de tipearlas.
   *
   * El 43% de las solicitudes no trae planilla, pero la gente suele estar igual: la nómina va
   * dentro del certificado de cobertura de la ART, que el local manda como documentación
   * obligatoria. Esto sólo LEE y propone; quién entra a la solicitud lo decide el que revisa.
   */
  app.get('/solicitud/:solicitudId/personas-detectadas', { onRequest: app.requireAdmin }, async (req) => {
    const solicitudId = Number((req.params as any).solicitudId);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');

    const yaEstan = new Set<string>();
    for (const p of db
      .select({ dni: schema.personas.dni, cuil: schema.personas.cuil })
      .from(schema.solicitudPersonas)
      .innerJoin(schema.personas, eq(schema.personas.id, schema.solicitudPersonas.personaId))
      .where(eq(schema.solicitudPersonas.solicitudId, solicitudId))
      .all()) {
      const dni = normalizeDni(p.dni ?? '').replace(/^0+/, '');
      if (dni.length >= 7 && dni.length <= 8) yaEstan.add(dni);
      const cuil = normalizeCuil(p.cuil ?? '');
      if (esCuilValido(cuil)) yaEstan.add(cuil.slice(2, 10).replace(/^0+/, ''));
    }

    const { emailIds } = correosDeSolicitud(solicitudId);
    const vistos = new Set<string>();
    const detectadas: { dni: string; nombre: string | null; apellido: string | null; archivo: string; yaEsta: boolean }[] = [];
    for (const emailId of emailIds) {
      let parsed;
      try { ({ parsed } = await parseEmail(emailId)); } catch { continue; }
      for (const [index, a] of flattenAttachments(parsed).entries()) {
        const filename = a.filename ?? `adjunto-${index + 1}`;
        if (esExcel(filename, a.contentType)) continue;
        if (!/pdf/i.test(a.contentType ?? '') && !/\.pdf$/i.test(filename)) continue;
        const t = await extractPdfText(a.content);
        if (!t.ok || !t.text) continue;
        for (const g of extractPeople(t.text)) {
          const dni = g.dni.replace(/^0+/, '');
          if (vistos.has(dni)) continue;
          vistos.add(dni);
          detectadas.push({ dni, nombre: g.nombre, apellido: g.apellido, archivo: filename, yaEsta: yaEstan.has(dni) });
        }
      }
    }
    detectadas.sort((a, b) => (a.apellido ?? 'zzz').localeCompare(b.apellido ?? 'zzz'));
    return { detectadas, nuevas: detectadas.filter((d) => !d.yaEsta).length };
  });

  // Documentación de una solicitud: adjuntos (PDF, etc.) de TODOS los correos vinculados
  // —el original del email y las respuestas que sumaron documentación— deduplicados por nombre.
  app.get('/solicitud/:solicitudId/documentacion', async (req) => {
    const solicitudId = Number((req.params as any).solicitudId);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    const { emailIds, originales } = correosDeSolicitud(solicitudId);

    // Se deduplica por nombre + tamaño, no por nombre solo. El local casi siempre reenvía la
    // documentación corregida CON EL MISMO NOMBRE ("F931.pdf"), y deduplicando por nombre el
    // archivo nuevo quedaba oculto detrás del viejo: el que revisaba seguía viendo el que había
    // rechazado. Mismo nombre y mismo tamaño sí es el mismo archivo (reenvío del hilo completo).
    const vistos = new Set<string>();
    const out: { emailId: number; index: number; filename: string; contentType?: string; size: number; deReenvio: boolean }[] = [];
    for (const emailId of emailIds) {
      let parsed;
      try { ({ parsed } = await parseEmail(emailId)); } catch { continue; }
      const flat = flattenAttachments(parsed);
      flat.forEach((a, index) => {
        // La planilla de personas no es documentación: sirvió para dar de alta a las personas y
        // ya está reflejada en la lista de la solicitud. Mostrarla acá es ruido para quien revisa.
        if (esExcel(a.filename ?? '', a.contentType)) return;
        const size = a.content?.length ?? 0;
        const clave = `${(a.filename ?? '').toLowerCase().trim()}|${size}`;
        if (vistos.has(clave)) return;
        vistos.add(clave);
        out.push({ emailId, index, filename: a.filename ?? `adjunto-${index + 1}`, contentType: a.contentType, size, deReenvio: !originales.includes(emailId) });
      });
    }
    return { adjuntos: out };
  });

  const soloAdmin = { onRequest: app.requireAdmin };

  // Cantidad de correos en respaldo (para la campanita del encabezado).
  app.get('/respaldo/count', async () => {
    const rows = db.select({ id: schema.emailMessages.id }).from(schema.emailMessages)
      .where(inArray(schema.emailMessages.estado, ESTADOS_RESPALDO)).all();
    return { count: rows.length };
  });

  // Respaldo: correos que no terminaron en una solicitud automática (errores, sin planilla
  // legible, planillas excesivas, respuestas/reenvíos). Se revisan a mano.
  app.get('/respaldo', async () => {
    const rows = db.select({
      id: schema.emailMessages.id,
      remitente: schema.emailMessages.remitente,
      asunto: schema.emailMessages.asunto,
      fecha: schema.emailMessages.fechaEmail,
      fechaRecibido: schema.emailMessages.fechaRecibido,
      estado: schema.emailMessages.estado,
      motivo: schema.emailMessages.error,
      attachmentsCount: schema.emailMessages.attachmentsCount,
      replySolicitudId: schema.emailMessages.replySolicitudId,
    }).from(schema.emailMessages)
      .where(inArray(schema.emailMessages.estado, ESTADOS_RESPALDO))
      .orderBy(desc(schema.emailMessages.fechaRecibido)).all();

    // A qué solicitud iría cada correo. Sale del vínculo ya guardado o, si no hay, del número de
    // orden del asunto: es lo que decide si el botón ofrece sumarlo a una solicitud existente o
    // crear una nueva. No se abre el .eml —sería leer un archivo por fila— así que un número que
    // solo esté en el cuerpo no se ve acá; para eso está el panel de detección de cada fila.
    const destinoPorAsunto = new Map<number, number>();
    for (const r of rows) {
      if (r.replySolicitudId) continue;
      const nro = buscarNroOrden(r.asunto);
      if (!nro) continue;
      const s = db.select({ id: schema.solicitudes.id }).from(schema.solicitudes).where(eq(schema.solicitudes.nroOrden, nro)).get();
      if (s) destinoPorAsunto.set(r.id, s.id);
    }

    const solIds = [...new Set([...rows.map((r) => r.replySolicitudId), ...destinoPorAsunto.values()].filter((x): x is number => !!x))];
    const sols = solIds.length
      ? db.select({ id: schema.solicitudes.id, nroOrden: schema.solicitudes.nroOrden, local: schema.locales.nombre })
          .from(schema.solicitudes).innerJoin(schema.locales, eq(schema.solicitudes.localId, schema.locales.id))
          .where(inArray(schema.solicitudes.id, solIds)).all()
      : [];
    const solMap = new Map(sols.map((s) => [s.id, s]));
    // Último aviso que el sistema ya le mandó al remitente por este correo. Sin esto, el botón de
    // responder ofrece el mismo texto que ya salió automáticamente y el local lo recibe dos veces.
    const avisos = rows.length
      ? db.select({ emailMessageId: schema.sentEmails.emailMessageId, fecha: schema.sentEmails.createdAt, tipo: schema.sentEmails.tipo })
          .from(schema.sentEmails)
          .where(and(inArray(schema.sentEmails.emailMessageId, rows.map((r) => r.id)), eq(schema.sentEmails.ok, true)))
          .orderBy(desc(schema.sentEmails.id)).all()
      : [];
    const avisoMap = new Map<number, { fecha: string; tipo: string | null }>();
    for (const a of avisos) if (a.emailMessageId != null && !avisoMap.has(a.emailMessageId)) avisoMap.set(a.emailMessageId, { fecha: a.fecha, tipo: a.tipo });

    // El local que se deduce del asunto: sirve para saber de quién es el correo aunque no haya
    // llegado a crear la solicitud.
    return rows.map((r) => ({
      ...r,
      solicitud: r.replySolicitudId ? solMap.get(r.replySolicitudId) ?? null : null,
      // A dónde iría al procesarlo: null = no pertenece a ninguna, así que se crea una nueva.
      destino: solMap.get(r.replySolicitudId ?? destinoPorAsunto.get(r.id) ?? -1) ?? null,
      localDetectado: parseLocalFromSubject(r.asunto),
      aviso: avisoMap.get(r.id) ?? null,
    }));
  });

  /**
   * Qué va a poder leer el sistema de este correo: el local, el tipo de contratista y la lista de
   * personas. Sirve para saber, ANTES de tocar "Procesar igual", si el alta automática va a salir
   * bien o si la solicitud va a quedar sin local o sin gente.
   */
  app.get('/:id/deteccion', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const email = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, id)).get();
    if (!email) throw notFound('Email no encontrado.');

    const nombreLocal = parseLocalFromSubject(email.asunto);
    const localExistente = nombreLocal ? buscarLocal(nombreLocal, { aproximado: true }) : null;

    let personas = 0;
    let descartadas = 0;
    let origen: 'excel' | 'cuerpo' | null = null;
    let adjuntos = 0;
    let tipo = parseTipo(email.asunto);
    let solicitudDestino: { id: number; nroOrden: string | null; local: string } | null = null;
    let desglose: { pdfs: number; imagenes: number; otros: number } | null = null;
    let conflicto: { remitente: string; direccion: string; orden: string; nroOrden: string | null } | null = null;

    if (email.rawStoredPath && fs.existsSync(email.rawStoredPath)) {
      try {
        const parsed = await simpleParser(fs.readFileSync(email.rawStoredPath));
        const { filas, huboExcel } = leerPersonasDelCorreo(parsed);
        // Se cuentan las que REALMENTE se van a dar de alta. El procesamiento descarta las filas
        // cuyo nombre no parece un nombre (un teléfono de la firma, por ejemplo), así que contar
        // las crudas hacía que acá dijera "1 persona" y después la solicitud quedara en cero.
        for (const f of filas) {
          const nc = (f.nombre !== undefined || f.apellido !== undefined) && (f.nombre || f.apellido)
            ? { nombre: (f.nombre || '').trim(), apellido: (f.apellido || '').trim() }
            : splitNombreCompleto(f.nombreCompleto);
          if (pareceNombreDePersona(nc.nombre, nc.apellido)) personas++;
          else descartadas++;
        }
        origen = personas ? (huboExcel ? 'excel' : 'cuerpo') : null;
        // Solo DOCUMENTACIÓN: la planilla de personas no se cuenta ni se muestra. No es un papel
        // para revisar, es la entrada con la que se dan de alta las personas de la solicitud —eso
        // ya se informa en "Personas"—. Contándola, el correo decía "4 archivos" y había 3 para ver.
        const reales = (parsed.attachments ?? [])
          .filter((a) => a.contentDisposition !== 'inline' && a.related !== true && !!a.filename)
          .filter((a) => !esExcel(a.filename ?? '', a.contentType));
        adjuntos = reales.length;
        const esPdf = (a: typeof reales[number]) => /pdf/i.test(a.contentType ?? '') || /\.pdf$/i.test(a.filename ?? '');
        const esImg = (a: typeof reales[number]) => /^image\//i.test(a.contentType ?? '');
        desglose = {
          pdfs: reales.filter(esPdf).length,
          imagenes: reales.filter(esImg).length,
          otros: reales.filter((a) => !esPdf(a) && !esImg(a)).length,
        };
        tipo = tipo ?? parseTipo(parsed.text);

        // ¿Pertenece a una solicitud que ya existe? Es lo que va a pasar al procesarlo, así que
        // conviene verlo ANTES: la documentación se suma ahí en vez de crear una solicitud nueva.
        const destinoId = detectarSolicitudDestino(email, parsed);
        // Si la orden citada es de otro local, esto es lo que hay que comparar antes de decidir.
        if (destinoId) conflicto = conflictoDeLocal(email, destinoId);
        if (destinoId) {
          const d = db.select({ id: schema.solicitudes.id, nroOrden: schema.solicitudes.nroOrden, local: schema.locales.nombre })
            .from(schema.solicitudes).innerJoin(schema.locales, eq(schema.locales.id, schema.solicitudes.localId))
            .where(eq(schema.solicitudes.id, destinoId)).get();
          if (d) solicitudDestino = d;
        }
      } catch { /* el .eml puede no ser legible: se informa lo que se pudo */ }
    }
    return {
      local: nombreLocal,
      localExistente: localExistente ? { id: localExistente.id, nombre: localExistente.nombre } : null,
      tipo,
      personas,
      descartadas,
      origen,
      adjuntos,
      desglose,
      solicitudDestino,
      conflicto,
    };
  });

  // Reprocesar un correo del respaldo forzando el alta de solicitud (ignora la detección de respuesta).
  app.post('/:id/procesar', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const email = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, id)).get();
    if (!email) throw notFound('Email no encontrado.');
    // Volver a un estado no-terminal para que processEmail lo tome.
    db.update(schema.emailMessages).set({ estado: 'RECEIVED', error: null, updatedAt: nowIso() }).where(eq(schema.emailMessages.id, id)).run();
    // `nuevaSolicitud` solo si lo piden explícitamente: por defecto, si el correo pertenece a una
    // solicitud existente (responde a su hilo o cita su número de orden), la documentación se
    // suma AHÍ en vez de crear una solicitud nueva y vacía.
    const nuevaSolicitud = (req.body as any)?.nuevaSolicitud === true;
    await processEmail(id, { force: true, nuevaSolicitud });
    audit({ userId: req.user!.id, accion: 'EMAIL_REPROCESADO', entidad: 'email', entidadId: id, ip: req.ip });
    const after = db.select({ estado: schema.emailMessages.estado, error: schema.emailMessages.error }).from(schema.emailMessages).where(eq(schema.emailMessages.id, id)).get();
    return { ok: true, estado: after?.estado, motivo: after?.error };
  });

  // Descartar un correo del respaldo (ya resuelto a mano). Sale de la bandeja.
  app.post('/:id/descartar', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const email = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, id)).get();
    if (!email) throw notFound('Email no encontrado.');
    db.update(schema.emailMessages).set({ estado: 'REVISADO', updatedAt: nowIso() }).where(eq(schema.emailMessages.id, id)).run();
    audit({ userId: req.user!.id, accion: 'EMAIL_RESPALDO_DESCARTADO', entidad: 'email', entidadId: id, ip: req.ip });
    return { ok: true };
  });

  // Registro de correos ENVIADOS por el sistema. Filtros: por solicitud, por texto libre
  // (asunto/destinatario/N° de orden) y por tipo. Incluye el N° de orden de la solicitud.
  app.get('/enviados', async (req) => {
    const q = req.query as any;
    const solicitudId = Number(q?.solicitudId) || null;
    const term = String(q?.q ?? '').trim().toLowerCase();
    const tipo = String(q?.tipo ?? '').trim();
    const base = db.select({
      id: schema.sentEmails.id,
      fecha: schema.sentEmails.createdAt,
      destinatario: schema.sentEmails.destinatario,
      asunto: schema.sentEmails.asunto,
      cuerpo: schema.sentEmails.cuerpo,
      tipo: schema.sentEmails.tipo,
      ok: schema.sentEmails.ok,
      error: schema.sentEmails.error,
      solicitudId: schema.sentEmails.solicitudId,
      nroOrden: schema.solicitudes.nroOrden,
    }).from(schema.sentEmails).leftJoin(schema.solicitudes, eq(schema.sentEmails.solicitudId, schema.solicitudes.id));
    let rows = solicitudId
      ? base.where(eq(schema.sentEmails.solicitudId, solicitudId)).orderBy(desc(schema.sentEmails.createdAt)).all()
      : base.orderBy(desc(schema.sentEmails.createdAt)).limit(500).all();
    if (tipo) rows = rows.filter((r) => r.tipo === tipo);
    if (term) rows = rows.filter((r) =>
      (r.nroOrden ?? '').toLowerCase().includes(term) ||
      (r.asunto ?? '').toLowerCase().includes(term) ||
      (r.destinatario ?? '').toLowerCase().includes(term));
    return rows;
  });
}
