import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql, isNull, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { nowIso, todayLocal } from '../../lib/datetime.js';
import { formatCuil, findOrCreatePersona, findPersonaByDocumento, normalizeCuil, normalizeDni, splitNombreCompleto } from '../personas/service.js';
import { leerPersonasDeImagen, visionDisponible } from '../ai/vision.js';
import { pedirListaAlRemitente, parseTipo } from '../processing/processor.js';
import { env } from '../../config/env.js';
import { getPersonaDocStatus, getSolicitudDocStatus, personaAutorizableEnSolicitud, docsSinDecidir } from '../documentos/service.js';
import { getVigencia, recomputeAutorizacionPersona, recomputeAutorizacionesDePersona } from '../autorizaciones/service.js';
import { recomputeSolicitudEstado, aggEstado, agruparPorEmail, asignarNroOrden } from './service.js';
import { findOrCreateLocal } from '../locales/service.js';
import { notifyObservacion, notifyRechazo, notifyResultadoRevision } from '../notifications/service.js';

const TIPOS = ['EMPRESA', 'MONOTRIBUTISTA'] as const;

// Una persona se puede cargar como nombre + apellido, o como un solo "nombre completo".
// El documento puede venir como CUIL o como DNI: con uno alcanza. Muchas planillas de los locales
// traen solo el DNI, y antes había que buscar el CUIL a mano para poder cargar a la persona.
const personaInput = z
  .object({
    cuil: z.string().optional(),
    dni: z.string().optional(),
    nombre: z.string().optional(),
    apellido: z.string().optional(),
    nombreCompleto: z.string().optional(),
    categoria: z.enum(TIPOS).optional(),
  })
  .refine((p) => !!(p.nombreCompleto?.trim() || p.nombre?.trim()), { message: 'Ingresá el nombre de la persona.' })
  .refine((p) => documentoUtil(p.cuil, p.dni), { message: 'Ingresá el CUIL (11 dígitos) o el DNI (7 u 8).' });

/** ¿Alcanza para identificar a la persona? Un CUIL de 11 o un DNI de 7 u 8. */
function documentoUtil(cuil?: string, dni?: string): boolean {
  return normalizeCuil(cuil ?? '').length >= 10 || [7, 8].includes(normalizeDni(dni ?? '').length);
}

const manualSchema = z
  .object({
    // El local se elige de los cargados (localId) o se escribe uno nuevo (localNombre),
    // que se crea en el momento. Igual que hace el lector de emails con el asunto.
    localId: z.number().int().optional(),
    localNombre: z.string().optional(),
    // Puede venir vacío: la solicitud se crea y las personas se cargan después.
    personas: z.array(personaInput).default([]),
    // Tipo de contratista para todo el grupo (define qué documentación se exige).
    categoria: z.enum(TIPOS).optional(),
  })
  .refine((d) => d.localId != null || !!d.localNombre?.trim(), { message: 'Elegí o escribí un local.' });

type PersonaInputParsed = z.infer<typeof personaInput>;

/** Normaliza una persona de entrada a { cuil, nombre, apellido, categoria }. */
function normalizarPersona(p: PersonaInputParsed, categoriaGrupo?: string) {
  // Los documentos van crudos: quien los interpreta es `findOrCreatePersona`, y una sola vez.
  // Interpretarlos acá también marcaría como confiable un DNI que en realidad se dedujo del CUIL.
  const cuil = normalizeCuil(p.cuil ?? '');
  const dni = normalizeDni(p.dni ?? '');
  let nombre = (p.nombre ?? '').trim();
  let apellido = (p.apellido ?? '').trim();
  if (!nombre || !apellido) {
    // Vino un solo campo (o un "nombre completo"): se parte en nombre + apellido.
    const nc = splitNombreCompleto(p.nombreCompleto?.trim() || `${nombre} ${apellido}`.trim());
    nombre = nc.nombre;
    apellido = nc.apellido;
  }
  return { cuil, dni, nombre, apellido, categoria: p.categoria ?? categoriaGrupo };
}

/**
 * El tipo de contratista que le corresponde a una solicitud cuando el alta no lo trae.
 *
 * El tipo no es un campo de la solicitud: vive en cada persona. Así que cuando un correo entra sin
 * nómina legible, el "Empresa" que el local escribió en el asunto se lee bien y se tira, porque no
 * hay ninguna persona a la que estampárselo —y el que las carga a mano después tiene que volver a
 * elegirlo, mirando un asunto que ya lo decía (caso OA-2026-0299, "Solicitud de Fao (Surfistas)
 * Empresa")—.
 *
 * Dos fuentes, en este orden: lo que DECLARÓ el correo, y si no, el tipo que comparten las personas
 * que ya están en la solicitud. Si las que hay tienen tipos distintos no se infiere nada.
 */
function tipoHeredadoDeLaSolicitud(solicitudId: number): string | null {
  const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get();
  if (!sol) return null;
  if (sol.emailMessageId != null) {
    const email = db.select({ asunto: schema.emailMessages.asunto, cuerpo: schema.emailMessages.cuerpo })
      .from(schema.emailMessages).where(eq(schema.emailMessages.id, sol.emailMessageId)).get();
    const declarado = parseTipo(email?.asunto) ?? parseTipo(email?.cuerpo);
    if (declarado) return declarado;
  }
  const cats = [...new Set(
    db.select({ categoria: schema.personas.categoria })
      .from(schema.solicitudPersonas)
      .innerJoin(schema.personas, eq(schema.personas.id, schema.solicitudPersonas.personaId))
      .where(eq(schema.solicitudPersonas.solicitudId, solicitudId))
      .all().map((r) => r.categoria).filter((c): c is string => !!c),
  )];
  return cats.length === 1 ? cats[0] : null;
}

/**
 * Alta/asociación de una persona en una solicitud. Devuelve el id y si es nueva.
 *
 * `heredada` es el tipo que sale del contexto (ver `tipoHeredadoDeLaSolicitud`) y SOLO rellena: si
 * la ficha ya tiene tipo de otra solicitud, no se lo toca. Deducir un tipo es una cosa y cambiarle
 * el tipo a una persona sin que nadie lo haya pedido es otra. El que viene explícito en el alta sí
 * manda, como hasta ahora.
 */
function agregarPersonaASolicitud(solicitudId: number, p: ReturnType<typeof normalizarPersona>, heredada?: string | null) {
  const { persona, created } = findOrCreatePersona({ cuil: p.cuil, dni: p.dni, nombre: p.nombre, apellido: p.apellido });
  const categoria = p.categoria ?? (persona.categoria ? null : heredada);
  if (categoria && persona.categoria !== categoria) {
    db.update(schema.personas).set({ categoria, updatedAt: nowIso() }).where(eq(schema.personas.id, persona.id)).run();
  }
  db.insert(schema.solicitudPersonas).values({ solicitudId, personaId: persona.id }).onConflictDoNothing().run();
  return { persona, created };
}

export async function solicitudesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAuth);
  const soloAdmin = { onRequest: app.requireAdmin };

  // Listado agrupado POR EMAIL: una fila por email (varias personas adentro).
  // Las solicitudes creadas a mano (sin email) se muestran individualmente.
  app.get('/', async (req) => {
    const q = req.query as any;
    // Excluir las que están en la papelera (borrado lógico).
    const conds = [isNull(schema.solicitudes.deletedAt)] as any[];
    if (q.localId) conds.push(eq(schema.solicitudes.localId, Number(q.localId)));

    // Búsqueda por persona / CUIL / DNI / nº de orden: se aplica EN SQL (no después de un tope),
    // así siempre encuentra la solicitud aunque no esté entre las más recientes.
    const term = String(q.q ?? '').trim().toLowerCase();
    const termDigits = term.replace(/\D/g, '');
    if (term) {
      const like = `%${term}%`;
      const likeDigits = `%${termDigits}%`;
      const porCuilDni = termDigits
        ? sql` OR replace(replace(replace(p2.cuil,'-',''),' ',''),'.','') LIKE ${likeDigits} OR p2.dni LIKE ${likeDigits}`
        : sql``;
      conds.push(sql`(
        EXISTS (
          SELECT 1 FROM solicitud_personas sp2
          JOIN personas p2 ON p2.id = sp2.persona_id
          WHERE sp2.solicitud_id = ${schema.solicitudes.id}
            AND ( lower(p2.apellido || ' ' || p2.nombre) LIKE ${like}
               OR lower(p2.nombre || ' ' || p2.apellido) LIKE ${like}${porCuilDni} )
        )
        OR lower(coalesce(${schema.solicitudes.nroOrden}, '')) LIKE ${like}
      )`);
    }

    const rows = db
      .select({
        id: schema.solicitudes.id,
        estado: schema.solicitudes.estado,
        updatedAt: schema.solicitudes.updatedAt,
        nroOrden: schema.solicitudes.nroOrden,
        docNuevaAt: schema.solicitudes.docNuevaAt,
        localId: schema.locales.id,
        local: schema.locales.nombre,
        emailMessageId: schema.solicitudes.emailMessageId,
        emailAsunto: schema.emailMessages.asunto,
        fecha: sql<string>`coalesce(${schema.emailMessages.fechaEmail}, ${schema.emailMessages.fechaRecibido}, ${schema.solicitudes.createdAt})`,
        personasCount: sql<number>`count(${schema.solicitudPersonas.id})`,
        personasLabel: sql<string>`group_concat(${schema.personas.apellido} || ', ' || ${schema.personas.nombre}, ' · ')`,
        cuils: sql<string>`group_concat(${schema.personas.cuil}, ',')`,
        categorias: sql<string>`group_concat(distinct ${schema.personas.categoria})`,
      })
      .from(schema.solicitudes)
      .innerJoin(schema.locales, eq(schema.solicitudes.localId, schema.locales.id))
      .leftJoin(schema.emailMessages, eq(schema.solicitudes.emailMessageId, schema.emailMessages.id))
      .leftJoin(schema.solicitudPersonas, eq(schema.solicitudPersonas.solicitudId, schema.solicitudes.id))
      .leftJoin(schema.personas, eq(schema.personas.id, schema.solicitudPersonas.personaId))
      .where(conds.length ? and(...conds) : undefined)
      .groupBy(schema.solicitudes.id)
      .orderBy(desc(schema.solicitudes.updatedAt))
      .limit(term || q.localId ? 5000 : 2000)
      .all();

    // Agrupar por email (o por solicitud si es manual/sin email).
    let list = agruparPorEmail(rows as any);

    if (q.estado) list = list.filter((x) => x.estado === String(q.estado));
    // Filtro por fecha de envío (día). Se compara la parte YYYY-MM-DD de la fecha del email.
    if (q.desde) list = list.filter((x) => (x.fecha ?? '').slice(0, 10) >= String(q.desde));
    if (q.hasta) list = list.filter((x) => (x.fecha ?? '').slice(0, 10) <= String(q.hasta));
    return list.map(({ cuils, ...x }) => x);
  });

  // Detalle: agrupa TODAS las personas del mismo email (varias solicitudes del mismo correo
  // se ven como una sola). Cada persona conserva su solicitudId para las acciones.
  app.get('/:id', async (req) => {
    const id = Number((req.params as any).id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');

    // Hermanas: mismas solicitudes del mismo email; si es manual, solo ésta.
    const hermanas = sol.emailMessageId != null
      ? db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, sol.emailMessageId)).all()
      : [sol];
    const solIds = hermanas.map((s) => s.id);
    const localIdPorSol = new Map(hermanas.map((s) => [s.id, s.localId] as const));

    // Local a mostrar: preferir uno real por sobre "(Sin asignar)".
    const localesGrupo = db.select().from(schema.locales).where(inArray(schema.locales.id, [...new Set(hermanas.map((s) => s.localId))])).all();
    const local = localesGrupo.find((l) => l.nombre !== '(Sin asignar)') ?? localesGrupo[0]
      ?? db.select().from(schema.locales).where(eq(schema.locales.id, sol.localId)).get()!;

    const email = sol.emailMessageId
      ? db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, sol.emailMessageId)).get()
      : null;

    const comentarios = db
      .select({
        id: schema.comentarios.id,
        contenido: schema.comentarios.contenido,
        createdAt: schema.comentarios.createdAt,
        userNombre: schema.users.nombre,
      })
      .from(schema.comentarios)
      .leftJoin(schema.users, eq(schema.comentarios.userId, schema.users.id))
      .where(inArray(schema.comentarios.solicitudId, solIds))
      .orderBy(schema.comentarios.createdAt)
      .all();

    const sps = db
      .select({
        spId: schema.solicitudPersonas.id,
        solicitudId: schema.solicitudPersonas.solicitudId,
        estado: schema.solicitudPersonas.estado,
        motivoRechazo: schema.solicitudPersonas.motivoRechazo,
        fechaVencimiento: schema.solicitudPersonas.fechaVencimiento,
        personaId: schema.personas.id,
        cuil: schema.personas.cuil,
        nombre: schema.personas.nombre,
        apellido: schema.personas.apellido,
      })
      .from(schema.solicitudPersonas)
      .innerJoin(schema.personas, eq(schema.solicitudPersonas.personaId, schema.personas.id))
      .where(inArray(schema.solicitudPersonas.solicitudId, solIds))
      .orderBy(schema.personas.apellido)
      .all();

    const personas = sps.map((p) => {
      const localId = localIdPorSol.get(p.solicitudId) ?? sol.localId;
      const docStatus = getPersonaDocStatus(p.personaId);
      // Autorizable = docs por-persona + docs de la solicitud (según su categoría) verificados.
      const autoriz = personaAutorizableEnSolicitud(p.solicitudId, p.personaId);
      const vig = getVigencia(p.personaId, localId);
      const ingresoAbierto = db
        .select()
        .from(schema.entradas)
        .where(and(eq(schema.entradas.personaId, p.personaId), isNull(schema.entradas.fechaHoraSalida)))
        .get() ?? null;
      return {
        spId: p.spId,
        solicitudId: p.solicitudId,
        personaId: p.personaId,
        cuil: p.cuil,
        cuilFormat: p.cuil ? formatCuil(p.cuil) : '—',
        nombre: p.nombre,
        apellido: p.apellido,
        estado: p.estado,
        motivoRechazo: p.motivoRechazo,
        docStatus,
        autorizable: autoriz.ok,
        faltantesTotales: autoriz.faltantes,
        vigencia: vig.estado,
        autorizacionVigente: vig.autorizacion,
        ingresoAbierto,
        // La propia si la tiene; si no, null y rige la de la solicitud.
        fechaVencimiento: p.fechaVencimiento,
      };
    });

    return {
      solicitud: { ...sol, localId: local.id, estado: aggEstado(personas.map((p) => p.estado)) },
      local,
      email: email ? { id: email.id, remitente: email.remitente, asunto: email.asunto, fecha: email.fechaEmail, adjuntos: email.attachmentsCount, aviso: email.estado === 'PROCESSED' ? email.error : null } : null,
      comentarios,
      personas,
      solicitudDocs: getSolicitudDocStatus(id),
    };
  });

  // Crear solicitud a mano: un local + una o más personas (por CUIL).
  app.post('/manual', soloAdmin, async (req) => {
    const data = manualSchema.parse(req.body);

    // Local existente por id, o uno nuevo a partir del nombre escrito.
    let local: typeof schema.locales.$inferSelect | undefined;
    let localCreado = false;
    if (data.localId != null) {
      local = db.select().from(schema.locales).where(eq(schema.locales.id, data.localId)).get();
      if (!local) throw badRequest('Local inexistente.');
    } else {
      const r = findOrCreateLocal(data.localNombre!, { origen: 'manual', userId: req.user!.id, ip: req.ip });
      if (!r) throw badRequest('Nombre de local inválido.');
      local = r.local;
      localCreado = r.created;
    }

    // CUILs repetidos dentro del mismo formulario: se cargan una sola vez.
    const vistos = new Set<string>();
    const personas = data.personas
      .map((p) => normalizarPersona(p, data.categoria))
      .filter((p) => (vistos.has(p.cuil) ? false : (vistos.add(p.cuil), true)));

    const sol = db.insert(schema.solicitudes).values({ localId: local.id, estado: 'PENDIENTE', createdByUserId: req.user!.id }).returning().get();
    for (const p of personas) {
      const { persona, created } = agregarPersonaASolicitud(sol.id, p);
      if (created) audit({ userId: req.user!.id, accion: 'PERSONA_CREADA', entidad: 'persona', entidadId: persona.id, ip: req.ip });
    }
    recomputeSolicitudEstado(sol.id);
    asignarNroOrden(sol.id); // número desde el alta (igual que las que entran por email)
    audit({ userId: req.user!.id, accion: 'SOLICITUD_CREADA_MANUAL', entidad: 'solicitud', entidadId: sol.id, detalle: { personas: personas.length, categoria: data.categoria, localId: local.id, localCreado }, ip: req.ip });
    return { solicitudId: sol.id, personas: personas.length, local: { id: local.id, nombre: local.nombre, creado: localCreado } };
  });

  // Agregar una persona a una solicitud existente.
  app.post('/:id/personas', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const p = normalizarPersona(personaInput.parse(req.body));
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    // Se busca por documento, no por la columna CUIL: si la persona se identifica solo con el DNI
    // esa comparación no encontraba nada y la dejaba entrar dos veces a la misma solicitud.
    const existente = findPersonaByDocumento(p.cuil || p.dni);
    if (existente) {
      const yaEsta = db
        .select()
        .from(schema.solicitudPersonas)
        .where(and(eq(schema.solicitudPersonas.solicitudId, id), eq(schema.solicitudPersonas.personaId, existente.id)))
        .get();
      if (yaEsta) throw badRequest('Esa persona ya está en la solicitud.');
    }
    const { persona, created } = agregarPersonaASolicitud(id, p, tipoHeredadoDeLaSolicitud(id));
    if (created) audit({ userId: req.user!.id, accion: 'PERSONA_CREADA', entidad: 'persona', entidadId: persona.id, ip: req.ip });
    recomputeSolicitudEstado(id);
    audit({ userId: req.user!.id, accion: 'SOLICITUD_PERSONA_AGREGADA', entidad: 'solicitud', entidadId: id, detalle: { personaId: persona.id }, ip: req.ip });
    return { personaId: persona.id };
  });

  /**
   * Lee una CAPTURA de pantalla y devuelve la gente que nombra. NO da de alta a nadie: la lista va
   * a la misma tabla de revisión que el importador de PDF, y se confirma con `/personas/importar`.
   *
   * Es el único camino del sistema que sale a Internet. Si no hay API key configurada, el endpoint
   * contesta que no está disponible y la pantalla ni siquiera muestra el botón.
   */
  app.post('/:id/personas/desde-imagen', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    if (!visionDisponible()) throw badRequest('La lectura de capturas no está configurada en este servidor.');

    let imagen: Buffer | null = null;
    let mime = '';
    let instruccion = '';
    for await (const part of (req as any).parts()) {
      if (part.type === 'file') { mime = part.mimetype; imagen = await part.toBuffer(); }
      else if (part.fieldname === 'instruccion') instruccion = String(part.value ?? '');
    }
    if (!imagen) throw badRequest('No llegó ninguna imagen.');

    let lectura;
    try {
      lectura = await leerPersonasDeImagen(imagen, mime, instruccion);
    } catch (err: any) {
      throw badRequest(err?.message ?? 'No se pudo leer la captura.');
    }

    // Se marca quién ya está en la solicitud, igual que en el importador de PDF, para no ofrecer
    // dos veces a la misma persona.
    const yaEstan = new Set<string>();
    for (const p of db
      .select({ dni: schema.personas.dni, cuil: schema.personas.cuil })
      .from(schema.solicitudPersonas)
      .innerJoin(schema.personas, eq(schema.personas.id, schema.solicitudPersonas.personaId))
      .where(eq(schema.solicitudPersonas.solicitudId, id))
      .all()) {
      const d = normalizeDni(p.dni ?? '').replace(/^0+/, '');
      if (d.length >= 7 && d.length <= 8) yaEstan.add(d);
      const c = normalizeCuil(p.cuil ?? '');
      if (c.length === 11) yaEstan.add(c.slice(2, 10).replace(/^0+/, ''));
    }

    const detectadas = lectura.personas.map((p) => {
      const cuil = normalizeCuil(p.cuil ?? '');
      const dni = normalizeDni(p.dni ?? '').replace(/^0+/, '');
      const clave = dni.length >= 7 ? dni : cuil.length === 11 ? cuil.slice(2, 10).replace(/^0+/, '') : '';
      return {
        dni: clave || cuil,
        cuil: cuil || null,
        nombre: p.nombre?.trim() || null,
        apellido: p.apellido?.trim() || null,
        archivo: 'captura',
        yaEsta: !!clave && yaEstan.has(clave),
      };
    }).filter((p) => p.dni);

    audit({
      userId: req.user!.id, accion: 'SOLICITUD_CAPTURA_LEIDA', entidad: 'solicitud', entidadId: id,
      detalle: { detectadas: detectadas.length, tokens: lectura.tokens, modelo: env.ia.modelo }, ip: req.ip,
    });
    return { detectadas, nota: lectura.nota, nuevas: detectadas.filter((d) => !d.yaEsta).length };
  });

  /**
   * Alta en bloque de las personas que se leyeron de un PDF y el que revisa confirmó.
   *
   * Existe porque el 43% de las solicitudes no trae planilla y la nómina viene dentro del
   * certificado de la ART: cargar quince personas a mano son varios minutos y el mismo riesgo de
   * tipear mal un documento. Las que ya están en la solicitud se saltean sin romper el resto, así
   * que se puede volver a importar sin miedo a duplicar.
   */
  app.post('/:id/personas/importar', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    const entradas = z.array(personaInput).min(1).parse((req.body as any)?.personas);

    const agregadas: number[] = [];
    const salteadas: string[] = [];
    const heredada = tipoHeredadoDeLaSolicitud(id);
    for (const entrada of entradas) {
      const p = normalizarPersona(entrada);
      const existente = findPersonaByDocumento(p.cuil || p.dni);
      if (existente) {
        const yaEsta = db
          .select()
          .from(schema.solicitudPersonas)
          .where(and(eq(schema.solicitudPersonas.solicitudId, id), eq(schema.solicitudPersonas.personaId, existente.id)))
          .get();
        if (yaEsta) { salteadas.push(p.cuil || p.dni); continue; }
      }
      const { persona, created } = agregarPersonaASolicitud(id, p, heredada);
      if (created) audit({ userId: req.user!.id, accion: 'PERSONA_CREADA', entidad: 'persona', entidadId: persona.id, ip: req.ip });
      agregadas.push(persona.id);
    }
    recomputeSolicitudEstado(id);
    audit({
      userId: req.user!.id, accion: 'SOLICITUD_PERSONAS_IMPORTADAS', entidad: 'solicitud', entidadId: id,
      detalle: { agregadas: agregadas.length, salteadas: salteadas.length, origen: 'PDF' }, ip: req.ip,
    });
    return { agregadas: agregadas.length, salteadas: salteadas.length };
  });

  // Enviar una solicitud a la PAPELERA (borrado lógico, admin). No borra nada físicamente:
  // se puede restaurar. NO toca las autorizaciones: la papelera solo la saca del listado
  // (una persona puede seguir autorizada por esta u otra solicitud).
  app.delete('/:id', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    if (sol.deletedAt) return { ok: true, yaEnPapelera: true };

    const personas = db
      .select({ apellido: schema.personas.apellido, nombre: schema.personas.nombre })
      .from(schema.solicitudPersonas)
      .innerJoin(schema.personas, eq(schema.personas.id, schema.solicitudPersonas.personaId))
      .where(eq(schema.solicitudPersonas.solicitudId, id))
      .all();
    const local = db.select({ nombre: schema.locales.nombre }).from(schema.locales).where(eq(schema.locales.id, sol.localId)).get();

    db.update(schema.solicitudes).set({ deletedAt: nowIso(), updatedAt: nowIso() }).where(eq(schema.solicitudes.id, id)).run();

    audit({ userId: req.user!.id, accion: 'SOLICITUD_ELIMINADA', entidad: 'solicitud', entidadId: id,
      detalle: { local: local?.nombre, nroOrden: sol.nroOrden, personas: personas.map((p) => `${p.apellido}, ${p.nombre}`) }, ip: req.ip });
    return { ok: true, personasEliminadas: 0, papelera: true };
  });

  // Papelera: solicitudes borradas (recuperables).
  app.get('/papelera', soloAdmin, async () => {
    return db
      .select({
        id: schema.solicitudes.id,
        nroOrden: schema.solicitudes.nroOrden,
        estado: schema.solicitudes.estado,
        deletedAt: schema.solicitudes.deletedAt,
        local: schema.locales.nombre,
        asunto: schema.emailMessages.asunto,
        personasCount: sql<number>`count(${schema.solicitudPersonas.id})`,
        personasLabel: sql<string>`group_concat(${schema.personas.apellido} || ', ' || ${schema.personas.nombre}, ' · ')`,
      })
      .from(schema.solicitudes)
      .innerJoin(schema.locales, eq(schema.solicitudes.localId, schema.locales.id))
      .leftJoin(schema.emailMessages, eq(schema.solicitudes.emailMessageId, schema.emailMessages.id))
      .leftJoin(schema.solicitudPersonas, eq(schema.solicitudPersonas.solicitudId, schema.solicitudes.id))
      .leftJoin(schema.personas, eq(schema.personas.id, schema.solicitudPersonas.personaId))
      .where(sql`${schema.solicitudes.deletedAt} IS NOT NULL`)
      .groupBy(schema.solicitudes.id)
      .orderBy(desc(schema.solicitudes.deletedAt))
      .all();
  });

  // Restaurar una solicitud de la papelera.
  app.post('/:id/restaurar', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    db.update(schema.solicitudes).set({ deletedAt: null, updatedAt: nowIso() }).where(eq(schema.solicitudes.id, id)).run();
    const sps = db.select({ personaId: schema.solicitudPersonas.personaId }).from(schema.solicitudPersonas).where(eq(schema.solicitudPersonas.solicitudId, id)).all();
    for (const sp of sps) recomputeAutorizacionesDePersona(sp.personaId, req.user!.id);
    recomputeSolicitudEstado(id);
    audit({ userId: req.user!.id, accion: 'SOLICITUD_RESTAURADA', entidad: 'solicitud', entidadId: id, ip: req.ip });
    return { ok: true };
  });

  // Borrar DEFINITIVAMENTE una solicitud (solo desde la papelera). Físico e irreversible.
  // Limpia sus vínculos y las personas que queden huérfanas. Los correos enviados y el email
  // de origen se conservan (se les quita el vínculo).
  app.delete('/:id/purgar', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    if (!sol.deletedAt) throw badRequest('Primero enviala a la papelera; el borrado definitivo es solo desde ahí.');
    const personaIds = db.select({ personaId: schema.solicitudPersonas.personaId }).from(schema.solicitudPersonas).where(eq(schema.solicitudPersonas.solicitudId, id)).all().map((r) => r.personaId);

    // Soltar vínculos que conservamos (no romper el historial de correos ni el email de origen).
    db.update(schema.sentEmails).set({ solicitudId: null }).where(eq(schema.sentEmails.solicitudId, id)).run();
    db.update(schema.emailMessages).set({ replySolicitudId: null }).where(eq(schema.emailMessages.replySolicitudId, id)).run();
    db.update(schema.requisitosPersona).set({ solicitudId: null }).where(eq(schema.requisitosPersona.solicitudId, id)).run();
    // Borrar hijas de la solicitud.
    db.delete(schema.solicitudDocumentos).where(eq(schema.solicitudDocumentos.solicitudId, id)).run();
    db.delete(schema.autorizaciones).where(eq(schema.autorizaciones.solicitudId, id)).run();
    db.delete(schema.aiAnalyses).where(eq(schema.aiAnalyses.solicitudId, id)).run();
    db.delete(schema.comentarios).where(eq(schema.comentarios.solicitudId, id)).run();
    db.delete(schema.solicitudPersonas).where(eq(schema.solicitudPersonas.solicitudId, id)).run();
    db.delete(schema.solicitudes).where(eq(schema.solicitudes.id, id)).run();

    // Personas que quedaron sin ninguna solicitud ni ingresos.
    for (const personaId of personaIds) {
      const enOtra = db.select({ n: sql<number>`count(*)` }).from(schema.solicitudPersonas).where(eq(schema.solicitudPersonas.personaId, personaId)).get()?.n ?? 0;
      const conIngreso = db.select({ n: sql<number>`count(*)` }).from(schema.entradas).where(eq(schema.entradas.personaId, personaId)).get()?.n ?? 0;
      if (enOtra === 0 && conIngreso === 0) {
        db.delete(schema.requisitosPersona).where(eq(schema.requisitosPersona.personaId, personaId)).run();
        const docs = db.select({ id: schema.documentos.id }).from(schema.documentos).where(eq(schema.documentos.personaId, personaId)).all();
        for (const d of docs) db.delete(schema.documentVersions).where(eq(schema.documentVersions.documentoId, d.id)).run();
        db.delete(schema.documentos).where(eq(schema.documentos.personaId, personaId)).run();
        db.delete(schema.autorizaciones).where(eq(schema.autorizaciones.personaId, personaId)).run();
        db.delete(schema.personas).where(eq(schema.personas.id, personaId)).run();
      }
    }
    audit({ userId: req.user!.id, accion: 'SOLICITUD_PURGADA', entidad: 'solicitud', entidadId: id, detalle: { local: sol.localId, nroOrden: sol.nroOrden, personas: personaIds.length }, ip: req.ip });
    return { ok: true, personasEliminadas: personaIds.length };
  });

  // Quitar una persona de la solicitud (no borra a la persona ni su documentación).
  app.delete('/:id/personas/:personaId', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const personaId = Number((req.params as any).personaId);
    db.delete(schema.solicitudPersonas)
      .where(and(eq(schema.solicitudPersonas.solicitudId, id), eq(schema.solicitudPersonas.personaId, personaId)))
      .run();
    recomputeSolicitudEstado(id);
    audit({ userId: req.user!.id, accion: 'SOLICITUD_PERSONA_QUITADA', entidad: 'solicitud', entidadId: id, detalle: { personaId }, ip: req.ip });
    return { ok: true };
  });

  // Agregar comentario a la solicitud (a nivel solicitud, común a todas las personas).
  app.post('/:id/comentarios', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const contenido = String((req.body as any)?.contenido ?? '').trim();
    if (!contenido) throw badRequest('El comentario no puede estar vacío.');
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    db.insert(schema.comentarios).values({ solicitudId: id, userId: req.user!.id, contenido }).run();
    audit({ userId: req.user!.id, accion: 'COMENTARIO_AGREGADO', entidad: 'solicitud', entidadId: id, ip: req.ip });
    return { ok: true };
  });

  // Reasignar el local de una solicitud (ej. cuando quedó "Sin asignar").
  app.post('/:id/local', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const localId = Number((req.body as any)?.localId);
    if (!localId) throw badRequest('Falta el local.');
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    const local = db.select().from(schema.locales).where(eq(schema.locales.id, localId)).get();
    if (!local) throw badRequest('Local inexistente.');
    db.update(schema.solicitudes).set({ localId, updatedAt: nowIso() }).where(eq(schema.solicitudes.id, id)).run();
    audit({ userId: req.user!.id, accion: 'SOLICITUD_LOCAL_ASIGNADO', entidad: 'solicitud', entidadId: id, detalle: { localId }, ip: req.ip });
    return { ok: true };
  });

  // Cargar/editar el trabajo o tarea a realizar (lo ve Seguridad al consultar la persona).
  app.patch('/:id/trabajo', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const trabajo = String((req.body as any)?.trabajo ?? '').trim().slice(0, 2000) || null;
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    db.update(schema.solicitudes).set({ trabajo, updatedAt: nowIso() }).where(eq(schema.solicitudes.id, id)).run();
    audit({ userId: req.user!.id, accion: 'SOLICITUD_TRABAJO_EDITADO', entidad: 'solicitud', entidadId: id, ip: req.ip });
    return { ok: true, trabajo };
  });

  // Fijar el tipo de contratista (EMPRESA | MONOTRIBUTISTA) de toda la solicitud.
  // Útil cuando el asunto/cuerpo no lo declaró. Define qué documentación se exige.
  // Se aplica a todas las personas del grupo del email.
  app.post('/:id/tipo', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const categoria = String((req.body as any)?.categoria ?? '').toUpperCase();
    if (!TIPOS.includes(categoria as any)) throw badRequest('Tipo inválido (EMPRESA o MONOTRIBUTISTA).');
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    const hermanas = sol.emailMessageId != null
      ? db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, sol.emailMessageId)).all()
      : [sol];
    const solIds = hermanas.map((s) => s.id);
    const sps = db.select({ personaId: schema.solicitudPersonas.personaId }).from(schema.solicitudPersonas).where(inArray(schema.solicitudPersonas.solicitudId, solIds)).all();
    for (const sp of sps) {
      db.update(schema.personas).set({ categoria, updatedAt: nowIso() }).where(eq(schema.personas.id, sp.personaId)).run();
      recomputeAutorizacionesDePersona(sp.personaId, req.user!.id);
    }
    audit({ userId: req.user!.id, accion: 'SOLICITUD_TIPO_ASIGNADO', entidad: 'solicitud', entidadId: id, detalle: { categoria, personas: sps.length }, ip: req.ip });
    return { ok: true, categoria, personas: sps.length };
  });

  // Fijar la fecha de vencimiento ÚNICA de la solicitud (se aplica a todo el grupo del email).
  // Al cargarla, se autoriza automáticamente a quienes ya tienen la documentación completa.
  app.post('/:id/vencimiento', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const raw = String((req.body as any)?.fechaVencimiento ?? '').trim();
    const fechaVencimiento = raw || null;
    if (fechaVencimiento && !/^\d{4}-\d{2}-\d{2}$/.test(fechaVencimiento)) throw badRequest('Fecha inválida (YYYY-MM-DD).');
    // Una vigencia ya pasada autoriza a nadie: la autorización nace vencida y el local no se entera.
    if (fechaVencimiento && fechaVencimiento < todayLocal()) {
      throw badRequest(`La vigencia no puede ser anterior a hoy (${todayLocal()}). Revisá la fecha del documento.`);
    }
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    const hermanas = sol.emailMessageId != null
      ? db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, sol.emailMessageId)).all()
      : [sol];
    for (const h of hermanas) {
      db.update(schema.solicitudes).set({ fechaVencimiento, updatedAt: nowIso() }).where(eq(schema.solicitudes.id, h.id)).run();
      const sps = db.select({ personaId: schema.solicitudPersonas.personaId }).from(schema.solicitudPersonas).where(eq(schema.solicitudPersonas.solicitudId, h.id)).all();
      for (const sp of sps) recomputeAutorizacionPersona(h.id, sp.personaId, req.user!.id);
    }
    audit({ userId: req.user!.id, accion: 'SOLICITUD_VENCIMIENTO', entidad: 'solicitud', entidadId: id, detalle: { fechaVencimiento }, ip: req.ip });
    return { ok: true, fechaVencimiento };
  });

  // Terminar la revisión: manda un email al remitente con el resultado por persona.
  // Sacar la marca de "llegó documentación nueva" sin tener que rehacer la revisión.
  //
  // Antes la marca solo se limpiaba al terminar la revisión, así que para una solicitud ya
  // autorizada no había forma de sacarla: la única salida era mandarla a la papelera, y con eso
  // desaparecía la FAO entera del listado. Esto no cambia ninguna autorización, solo apaga el aviso.
  /**
   * Vigencia propia de UNA persona de la solicitud. Mandar `null` la devuelve a la general.
   *
   * La vigencia normal es del grupo —un pedido, una fecha—, pero a veces uno entra por menos días
   * o tiene la documentación venciendo antes que el resto. Sin esto había que partir el pedido en
   * dos solicitudes.
   */
  app.post('/:id/personas/:personaId/vencimiento', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const personaId = Number((req.params as any).personaId);
    const raw = String((req.body as any)?.fechaVencimiento ?? '').trim();
    const fechaVencimiento = raw || null;
    if (fechaVencimiento && !/^\d{4}-\d{2}-\d{2}$/.test(fechaVencimiento)) throw badRequest('Fecha inválida (YYYY-MM-DD).');
    // Mismo criterio que la vigencia general: una fecha ya pasada autoriza a nadie.
    if (fechaVencimiento && fechaVencimiento < todayLocal()) {
      throw badRequest(`La vigencia no puede ser anterior a hoy (${todayLocal()}).`);
    }
    const sp = db.select().from(schema.solicitudPersonas)
      .where(and(eq(schema.solicitudPersonas.solicitudId, id), eq(schema.solicitudPersonas.personaId, personaId))).get();
    if (!sp) throw notFound('Esa persona no está en la solicitud.');

    db.update(schema.solicitudPersonas).set({ fechaVencimiento, updatedAt: nowIso() })
      .where(eq(schema.solicitudPersonas.id, sp.id)).run();
    recomputeAutorizacionPersona(id, personaId, req.user!.id);
    audit({
      userId: req.user!.id, accion: 'SOLICITUD_PERSONA_VENCIMIENTO', entidad: 'solicitud', entidadId: id,
      detalle: { personaId, fechaVencimiento }, ip: req.ip,
    });
    return { ok: true, fechaVencimiento };
  });

  /**
   * Pedirle al local la nómina en un formato legible, desde la solicitud.
   *
   * El aviso automático se sacó a pedido del cliente: la mayoría de las veces la nómina está en el
   * PDF y se carga a mano, y ese correo quedaba mal porque el local ya la había mandado. Ahora se
   * manda desde acá, después de haber mirado la documentación y no haberla encontrado.
   */
  app.post('/:id/pedir-nomina', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    if (!sol.emailMessageId) throw badRequest('Esta solicitud es manual (sin correo), así que no hay a quién pedirle la nómina.');

    const enviado = await pedirListaAlRemitente(sol.emailMessageId);
    if (!enviado) throw badRequest('No se pudo enviar el correo (¿el remitente no tiene dirección, o falla el envío?).');

    db.insert(schema.comentarios).values({
      solicitudId: id, userId: req.user!.id,
      contenido: 'Se le pidió al remitente que reenvíe la nómina en Excel o escrita en el cuerpo del correo.',
    }).run();
    audit({ userId: req.user!.id, accion: 'SOLICITUD_NOMINA_PEDIDA', entidad: 'solicitud', entidadId: id, detalle: { emailId: sol.emailMessageId }, ip: req.ip });
    return { ok: true };
  });

  app.post('/:id/visto', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    db.update(schema.solicitudes).set({ docNuevaAt: null }).where(eq(schema.solicitudes.id, id)).run();
    audit({ userId: req.user!.id, accion: 'SOLICITUD_DOC_NUEVA_VISTA', entidad: 'solicitud', entidadId: id, detalle: { nroOrden: sol.nroOrden }, ip: req.ip });
    return { ok: true };
  });

  app.post('/:id/terminar-revision', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');

    // No se puede terminar la revisión (ni avisar por email) si no está definido el
    // tipo de contratista de cada persona: sin eso no sabemos qué documentación exigir.
    const sinTipo = db
      .select({ nombre: schema.personas.nombre, apellido: schema.personas.apellido })
      .from(schema.solicitudPersonas)
      .innerJoin(schema.personas, eq(schema.personas.id, schema.solicitudPersonas.personaId))
      .where(and(eq(schema.solicitudPersonas.solicitudId, id), isNull(schema.personas.categoria)))
      .all();
    if (sinTipo.length > 0) {
      const quienes = sinTipo.slice(0, 5).map((p) => `${p.apellido}, ${p.nombre}`).join('; ');
      const extra = sinTipo.length > 5 ? ` y ${sinTipo.length - 5} más` : '';
      throw badRequest(`Falta definir si es Empresa o Monotributista en: ${quienes}${extra}. Asigná el tipo de contratista antes de terminar la revisión.`);
    }

    // No se puede terminar si quedó algún documento sin decidir (ni aprobado ni marcado como falta).
    const hermanasIds = (sol.emailMessageId != null
      ? db.select({ id: schema.solicitudes.id }).from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, sol.emailMessageId)).all().map((r) => r.id)
      : [id]);
    if (hermanasIds.some((sid) => docsSinDecidir(sid))) {
      throw badRequest('La revisión está incompleta: quedan documentos sin decidir. Aprobá o marcá como falta cada documento antes de terminar y enviar el email.');
    }

    // Tampoco se puede terminar si hay gente con toda la documentación aprobada y la solicitud no
    // tiene vigencia cargada: el local recibiría "aprobado" y esa persona no quedaría autorizada,
    // que es exactamente la contradicción que el sistema tiene que evitar.
    if (!sol.fechaVencimiento) {
      const listos = hermanasIds.flatMap((sid) =>
        db.select({ personaId: schema.solicitudPersonas.personaId }).from(schema.solicitudPersonas)
          .where(eq(schema.solicitudPersonas.solicitudId, sid)).all()
          .filter((sp) => personaAutorizableEnSolicitud(sid, sp.personaId).ok));
      if (listos.length > 0) {
        throw badRequest(`Hay ${listos.length} persona(s) con toda la documentación aprobada y la solicitud no tiene "Vigencia hasta". Cargá la fecha antes de avisarle al remitente: si no, quedarían aprobadas pero sin autorización.`);
      }
    }

    // El número se asigna al cerrar la revisión, aunque el email no se pueda enviar:
    // identifica la revisión igual. Si ya tenía uno (reenvío), se conserva.
    const nroOrden = asignarNroOrden(id);
    // Se re-revisó y se vuelve a informar: la marca de "llegó documentación nueva" ya no aplica.
    db.update(schema.solicitudes).set({ docNuevaAt: null }).where(eq(schema.solicitudes.id, id)).run();
    const res = await notifyResultadoRevision(id);
    audit({ userId: req.user!.id, accion: 'REVISION_TERMINADA', entidad: 'solicitud', entidadId: id, detalle: { emailEnviado: res.enviado, to: res.to, nroOrden }, ip: req.ip });
    return {
      ok: true,
      nroOrden,
      emailEnviado: res.enviado,
      to: res.to,
      motivo: res.enviado ? null : (res.to ? 'No se pudo enviar el email (revisá la configuración de SMTP).' : 'El correo original no tiene un remitente para responderle.'),
    };
  });

  // Observar a una persona (documentación faltante / inconsistencia).
  app.post('/:id/personas/:personaId/observar', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const personaId = Number((req.params as any).personaId);
    const comentario = String((req.body as any)?.comentario ?? '').trim();
    const sp = setEstadoPersona(id, personaId, 'OBSERVADA', req.user!.id, req.ip);
    if (comentario) db.insert(schema.comentarios).values({ solicitudId: id, userId: req.user!.id, contenido: comentario }).run();
    recomputeSolicitudEstado(id);
    notifyObservacion(id, personaId, comentario).catch(() => {});
    return { ok: true, estado: sp.estado };
  });

  // Rechazar a una persona — motivo obligatorio.
  app.post('/:id/personas/:personaId/rechazar', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const personaId = Number((req.params as any).personaId);
    const motivo = String((req.body as any)?.motivo ?? '').trim();
    if (!motivo) throw badRequest('El motivo de rechazo es obligatorio.');
    const sp = db
      .select()
      .from(schema.solicitudPersonas)
      .where(and(eq(schema.solicitudPersonas.solicitudId, id), eq(schema.solicitudPersonas.personaId, personaId)))
      .get();
    if (!sp) throw notFound('La persona no pertenece a esta solicitud.');
    db.update(schema.solicitudPersonas).set({ estado: 'RECHAZADA', motivoRechazo: motivo, updatedAt: nowIso() }).where(eq(schema.solicitudPersonas.id, sp.id)).run();
    db.insert(schema.comentarios).values({ solicitudId: id, userId: req.user!.id, contenido: `RECHAZO: ${motivo}` }).run();
    recomputeSolicitudEstado(id);
    audit({ userId: req.user!.id, accion: 'RECHAZO_REALIZADO', entidad: 'solicitud', entidadId: id, detalle: { personaId, motivo }, ip: req.ip });
    notifyRechazo(id, personaId, motivo).catch(() => {});
    return { ok: true };
  });
}

function setEstadoPersona(solicitudId: number, personaId: number, estado: string, userId: number, ip: string) {
  const sp = db
    .select()
    .from(schema.solicitudPersonas)
    .where(and(eq(schema.solicitudPersonas.solicitudId, solicitudId), eq(schema.solicitudPersonas.personaId, personaId)))
    .get();
  if (!sp) throw notFound('La persona no pertenece a esta solicitud.');
  db.update(schema.solicitudPersonas).set({ estado, updatedAt: nowIso() }).where(eq(schema.solicitudPersonas.id, sp.id)).run();
  audit({ userId, accion: 'ESTADO_MODIFICADO', entidad: 'solicitud', entidadId: solicitudId, detalle: { personaId, estado }, ip });
  return { ...sp, estado };
}
