import crypto from 'node:crypto';
import fs from 'node:fs';
import { simpleParser } from 'mailparser';
import { eq, and, ne, gte, desc, isNotNull, like } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { nowIso } from '../../lib/datetime.js';
import { isZip } from '../../lib/files.js';
import { extractZip } from './zip.js';
import { findOrCreatePersona, normalizeCuil, normalizeDni, splitNombreCompleto, pareceNombreDePersona, interpretarDocumento } from '../personas/service.js';
import { getPlaceholderLocalId } from '../../db/migrate.js';
import { parsePersonasSpreadsheet } from '../../lib/xlsx.js';
import { findOrCreateLocal } from '../locales/service.js';
import { recomputeSolicitudEstado, asignarNroOrden } from '../solicitudes/service.js';
import { sendMail } from '../email/mailer.js';
import { parsePersonasFromBody } from './body-table.js';
import { env } from '../../config/env.js';

/** Extrae la dirección de un "Nombre <addr@dom>" o devuelve el texto si ya es una dirección. */
function extraerEmail(remitente: string | null | undefined): string {
  if (!remitente) return '';
  const m = remitente.match(/<([^>]+)>/);
  return (m ? m[1] : remitente).trim();
}

interface FileItem {
  filename: string;
  buffer: Buffer;
}

// Máximo de personas por solicitud que se procesan automáticamente. Por encima de esto no se
// crea la solicitud: se avisa al remitente y queda en respaldo. Es un límite operativo (alguien
// tiene que revisar la documentación de cada persona a mano) además de protección del sistema.
const MAX_PERSONAS_PLANILLA = 40;

function setEmailEstado(emailId: number, estado: string, error?: string | null) {
  db.update(schema.emailMessages).set({ estado, error: error ?? null, updatedAt: nowIso() }).where(eq(schema.emailMessages.id, emailId)).run();
}

/**
 * Extrae el nombre del local a partir del asunto. Es tolerante a los formatos que
 * mandan los encargados, no solo el estándar. Ejemplos que resuelve:
 *   "Solicitud FAO (Local) empresa"        -> "Local"
 *   "SOLICITUD DE FAO (PEQUES)-EMPRESA"     -> "PEQUES"
 *   "Solicitud de FAO Bensimon"             -> "Bensimon"
 *   "Solicitud de FAO Bensimon para ingreso y egreso de mercaderia" -> "Bensimon"
 * Acepta el "de" opcional, mayúsculas/minúsculas, nombre entre paréntesis o suelto,
 * y descarta el tipo (empresa/monotributista) y frases de relleno del asunto.
 */
export function parseLocalFromSubject(asunto: string | null): string | null {
  if (!asunto) return null;
  const s = asunto.trim();
  // Saca tokens de tipo y separadores/paréntesis; colapsa espacios.
  const limpiar = (x: string) =>
    x.replace(/\b(empresas?|monotributistas?|mono)\b/gi, '')
      .replace(/[()\-–—:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  // 1) Nombre entre paréntesis en un asunto de FAO: "... FAO (PEQUES) ...".
  if (/\bfao\b/i.test(s)) {
    const par = s.match(/\(([^)]+)\)/);
    if (par) { const n = limpiar(par[1]); if (n) return n; }
  }
  // 2) Lo que viene después de "FAO" (con "de" opcional ya incluido en el resto).
  const m = s.match(/\bfao\b\s*(.+)$/i);
  if (m) {
    // Cortar en frases típicas de asunto ("para...", "ingreso...") y en separadores.
    let rest = m[1].replace(/^[\s\-–—:]+/, '');
    rest = rest.split(/\b(?:para|de\s+ingreso|ingreso|egreso)\b|[-–—:|]/i)[0];
    const n = limpiar(rest);
    if (n) return n;
  }
  return null;
}

/** Detecta el tipo de contratista declarado en un texto (asunto o cuerpo): EMPRESA | MONOTRIBUTISTA | null. */
export function parseTipo(texto: string | null | undefined): 'EMPRESA' | 'MONOTRIBUTISTA' | null {
  if (!texto) return null;
  if (/monotrib/i.test(texto)) return 'MONOTRIBUTISTA';
  if (/empresa/i.test(texto)) return 'EMPRESA';
  return null;
}

/** Compatibilidad: tipo declarado en el asunto. */
export function parseTipoFromSubject(asunto: string | null): 'EMPRESA' | 'MONOTRIBUTISTA' | null {
  return parseTipo(asunto);
}

/**
 * Identifica el local declarado en el asunto. Si no coincide con ninguno cargado,
 * lo CREA automáticamente (el asunto es la fuente oficial del local).
 * Match aproximado: el nombre del asunto puede traer texto alrededor.
 */
function identifyLocal(asunto: string | null): number | null {
  const nombre = parseLocalFromSubject(asunto);
  if (!nombre) return null;
  return findOrCreateLocal(nombre, { origen: 'email', aproximado: true })?.local.id ?? null;
}

export function esExcel(filename: string, contentType?: string): boolean {
  return /\.(xlsx|xlsm|xls|ods|csv|tsv)$/i.test(filename) || /spreadsheet|excel|csv|opendocument\.spreadsheet/i.test(contentType ?? '');
}

type Parsed = Awaited<ReturnType<typeof simpleParser>>;

/** Aplana adjuntos (expandiendo ZIPs) y extrae las personas del Excel o del cuerpo. */
export function leerPersonasDelCorreo(parsed: Parsed): { filas: ReturnType<typeof parsePersonasSpreadsheet>; huboExcel: boolean } {
  const items: FileItem[] = [];
  for (const att of parsed.attachments ?? []) {
    const name = att.filename ?? 'adjunto';
    const buf = att.content as Buffer;
    if (isZip(name, att.contentType)) {
      try { for (const f of extractZip(buf).files) items.push({ filename: f.filename, buffer: f.buffer }); continue; } catch { /* zip ilegible */ }
    }
    items.push({ filename: name, buffer: buf });
  }
  const excel = items.find((it) => esExcel(it.filename));
  let filas = excel ? parsePersonasSpreadsheet(excel.filename, excel.buffer) : [];
  if (filas.length === 0) {
    const desdeCuerpo = parsePersonasFromBody(parsed.html || undefined, parsed.text || undefined);
    if (desdeCuerpo.length) filas = desdeCuerpo;
  }
  return { filas, huboExcel: !!excel };
}

/** Convierte una fila de planilla a { nombre, apellido } (dos columnas o "nombre completo"). */
function filaANombre(fila: { nombre?: string; apellido?: string; nombreCompleto: string }) {
  return (fila.nombre !== undefined || fila.apellido !== undefined) && (fila.nombre || fila.apellido)
    ? { nombre: (fila.nombre || '').trim() || '(a completar)', apellido: (fila.apellido || '').trim() || '(a completar)' }
    : splitNombreCompleto(fila.nombreCompleto);
}

/**
 * Coletilla con el número de orden, para que la respuesta del local vuelva a la MISMA solicitud
 * en vez de abrir una nueva.
 */
function nroOrdenDe(email: { replySolicitudId?: number | null }): string {
  if (!email.replySolicitudId) return '';
  const sol = db.select({ nroOrden: schema.solicitudes.nroOrden }).from(schema.solicitudes).where(eq(schema.solicitudes.id, email.replySolicitudId)).get();
  return sol?.nroOrden ? `

Al responder, deje el número de orden ${sol.nroOrden} en el asunto o en el texto: así la documentación se agrega a la solicitud que ya existe.` : '';
}

/** Ventana para considerar que dos correos con el mismo contenido son el mismo pedido. */
const DIAS_DUPLICADO = 7;

/**
 * Adjuntos "de verdad": excluye los embebidos en el cuerpo (típicamente el logo de la firma del
 * remitente). El descarte va por `related` —que mailparser marca cuando el adjunto está
 * referenciado desde el HTML— y NO por tener Content-ID: hay clientes de correo que le ponen uno a
 * todos los adjuntos, también a los archivos comunes (varios locales escriben desde Gmail, que hace
 * exactamente eso), y con ese criterio se descartaba la documentación entera.
 */
function adjuntosDocumento(parsed: Parsed) {
  return (parsed.attachments ?? []).filter((a) => a.contentDisposition !== 'inline' && a.related !== true && !!a.filename);
}

/**
 * Cuántos archivos de DOCUMENTACIÓN trae el correo. Es el número que se muestra (el 📎 del
 * respaldo, los adjuntos de la solicitud).
 *
 * No cuenta la planilla de personas: no es documentación, es la entrada con la que se dan de alta
 * las personas de la solicitud, y contarla hacía que el correo dijera "4 archivos" cuando había 3
 * para mirar. Tampoco cuenta los embebidos del cuerpo (el logo de la firma).
*/
function contarDocumentacion(parsed: Parsed): number {
  return adjuntosDocumento(parsed).filter((a) => !esExcel(a.filename ?? '', a.contentType)).length;
}

/**
 * Firma del contenido de un correo: mismo remitente + mismo asunto + mismos adjuntos.
 * Sirve para reconocer el MISMO pedido cuando el local lo manda por separado a las dos casillas
 * (la vieja y la nueva) y así no crear dos solicitudes. Si el correo llega una sola vez con las
 * dos direcciones en el "Para", alcanza con el Message-ID y ni se llega hasta acá.
 */
export function huellaContenido(email: { remitente?: string | null; asunto?: string | null }, parsed: Parsed): string {
  const de = extraerEmail(email.remitente).toLowerCase();
  const asunto = (email.asunto ?? '')
    .replace(/^\s*((re|rv|fw|fwd|reenv[ií]ar?)\s*:\s*)+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const adj = adjuntosDocumento(parsed)
    .map((a) => crypto.createHash('sha256').update(a.content as Buffer).digest('hex'))
    .sort();
  // Sin adjuntos la firma se apoya en el cuerpo: si no, dos correos distintos del mismo remitente
  // con el mismo asunto (los locales repiten "SOLICITUD DE FAO (X)") se tomarian por duplicados.
  const base = adj.length ? adj.join(',') : (parsed.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  return crypto.createHash('sha256').update(`${de}|${asunto}|${base}`).digest('hex');
}

/** Correo anterior con el mismo contenido dentro de la ventana. Null si es un pedido nuevo. */
function buscarDuplicado(emailId: number, huella: string) {
  const desde = new Date(Date.now() - DIAS_DUPLICADO * 86400000).toISOString();
  const previo = db
    .select()
    .from(schema.emailMessages)
    .where(and(eq(schema.emailMessages.huella, huella), ne(schema.emailMessages.id, emailId), gte(schema.emailMessages.fechaRecibido, desde)))
    .orderBy(desc(schema.emailMessages.id))
    .get();
  if (!previo) return null;
  const propia = db.select({ id: schema.solicitudes.id }).from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, previo.id)).get();
  return { previo, solicitudId: propia?.id ?? previo.replySolicitudId ?? null };
}

/**
 * De qué local escribe habitualmente una dirección de correo, si se puede saber con certeza.
 *
 * Devuelve el local solo cuando TODO el historial de esa dirección apunta al mismo. Si nunca
 * escribió, o si escribió por varios locales (pasa con las casillas que reenvían por todos), no
 * se puede afirmar nada y devuelve null: es preferible no opinar a opinar mal.
 */
export function localDelRemitente(remitente: string | null | undefined): { id: number; nombre: string } | null {
  const addr = extraerEmail(remitente).toLowerCase();
  if (!addr) return null;
  const placeholder = getPlaceholderLocalId();
  const locales = [...new Set(
    db.select({ localId: schema.emailMessages.localId })
      .from(schema.emailMessages)
      .where(and(isNotNull(schema.emailMessages.localId), like(schema.emailMessages.remitente, `%${addr}%`)))
      .all()
      .map((r) => r.localId!)
      .filter((id) => id !== placeholder),
  )];
  if (locales.length !== 1) return null;
  const l = db.select({ id: schema.locales.id, nombre: schema.locales.nombre }).from(schema.locales).where(eq(schema.locales.id, locales[0])).get();
  return l ?? null;
}

/**
 * El correo cita el número de orden de OTRO local.
 *
 * El número de orden es la señal más fuerte para saber a qué solicitud pertenece un correo, pero
 * nadie verifica que quien lo cita sea el dueño de esa orden. Un número mal tipeado o copiado del
 * mail equivocado mete la documentación —y la gente— en la solicitud de otro local, y esa gente
 * queda habilitada a entrar bajo un local que no la contrató.
 *
 * Cuando pasa no se adivina: el correo queda en el respaldo con los dos locales a la vista para
 * que una persona decida. Solo se detecta si de los dos lados hay certeza; ante la duda, se sigue
 * de largo y el número manda como antes.
 */
export function conflictoDeLocal(email: typeof schema.emailMessages.$inferSelect, solicitudId: number): { remitente: string; direccion: string; orden: string; nroOrden: string | null } | null {
  const sol = db.select({ localId: schema.solicitudes.localId, nroOrden: schema.solicitudes.nroOrden })
    .from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get();
  if (!sol || sol.localId === getPlaceholderLocalId()) return null;

  const suyo = localDelRemitente(email.remitente);
  if (!suyo || suyo.id === sol.localId) return null;

  const dela = db.select({ nombre: schema.locales.nombre }).from(schema.locales).where(eq(schema.locales.id, sol.localId)).get();
  // La dirección va también: el dominio suele decir de qué local es (@tienda.com.ar), y es lo
  // que permite resolverlo de un vistazo cuando el nombre del local no alcanza.
  return { remitente: suyo.nombre, direccion: extraerEmail(email.remitente), orden: dela?.nombre ?? '(desconocido)', nroOrden: sol.nroOrden };
}
/**
 * Busca un número de orden en un texto y lo devuelve en su forma canónica `OA-AAAA-NNNN`.
 *
 * Tolera cómo lo escribe la gente cuando lo retipea en vez de copiarlo: con espacios, con punto,
 * sin separador, en minúscula, y sin los ceros de adelante ("OA-2026-181" es OA-2026-0181). Antes
 * se exigía el formato exacto, así que cualquiera de esas variantes hacía que la documentación
 * abriera una solicitud nueva en vez de sumarse a la que el remitente estaba citando.
 *
 * Lo que NO se afloja es el prefijo OA ni los 4 dígitos del año: sin eso, cualquier número de 8
 * cifras suelto en el cuerpo (un CUIL, un teléfono) pasaría por número de orden.
 */
export function buscarNroOrden(texto: string | null | undefined): string | null {
  const m = (texto ?? '').match(/\bOA[\s._-]*(\d{4})[\s._-]*(\d{1,4})\b/i);
  if (!m) return null;
  return `OA-${m[1]}-${m[2].padStart(4, '0')}`;
}
/**
 * Determina si el correo pertenece a una solicitud EXISTENTE:
 *  - número de orden (OA-AAAA-NNNN) en el asunto, o
 *  - responde (In-Reply-To / References) a un correo que enviamos o a uno que ya tiene solicitud.
 * Devuelve el id de la solicitud, o null si es un pedido nuevo.
 */
/**
 * La solicitud existe y no está en la papelera.
 *
 * Una solicitud borrada NO es destino: el correo que la cita es un pedido nuevo, no una respuesta
 * a algo que ya no está. Antes se devolvía igual y el correo moría en el respaldo con "responde a
 * una solicitud que ya no está disponible" —un callejón sin salida, porque el botón "Crear
 * solicitud" volvía a caer en la misma rama y repetía el error—. Caso real: 47 Avenida contestó el
 * 05/10 en el hilo de la OA-2026-0221, que se había borrado en septiembre por haber salido vacía;
 * sus 6 PDF quedaron sin entrar a ninguna solicitud. Devolviendo null, el correo sigue el camino
 * normal y el botón del respaldo le crea la solicitud.
 */
function solicitudVigente(solId: number | null | undefined): number | null {
  if (!solId) return null;
  const s = db.select({ id: schema.solicitudes.id, deletedAt: schema.solicitudes.deletedAt })
    .from(schema.solicitudes).where(eq(schema.solicitudes.id, solId)).get();
  return s && !s.deletedAt ? s.id : null;
}

export function detectarSolicitudDestino(email: typeof schema.emailMessages.$inferSelect, parsed: Parsed, ignorarHilo?: boolean): number | null {
  if (ignorarHilo) return null;

  // 1) Número de orden, en el asunto O en el cuerpo. El aviso que manda el sistema pide citarlo
  //    "EN EL ASUNTO", pero en la práctica la gente contesta y lo deja en el texto, o abre un
  //    correo nuevo y lo escribe en el cuerpo. Si está, es la señal más explícita de a qué
  //    solicitud pertenece: vale igual donde aparezca.
  const nro = buscarNroOrden(email.asunto) ?? buscarNroOrden(parsed.text);
  if (nro) {
    const sol = db.select({ id: schema.solicitudes.id }).from(schema.solicitudes).where(eq(schema.solicitudes.nroOrden, nro)).get();
    const vigente = solicitudVigente(sol?.id);
    if (vigente) return vigente;
  }

  // 2) Hilo de conversación (respuesta a un correo conocido).
  const refs = new Set<string>();
  if (parsed.inReplyTo) parsed.inReplyTo.split(/\s+/).forEach((r) => r && refs.add(r.trim()));
  const rawRefs = parsed.references;
  if (rawRefs) (Array.isArray(rawRefs) ? rawRefs : [rawRefs]).forEach((r) => r && refs.add(String(r).trim()));
  for (const r of refs) {
    if (r === email.messageId) continue;
    // 2a) Responde a un correo que NOSOTROS mandamos por esa solicitud: nos está contestando.
    //     No hay ambigüedad posible, vale siempre.
    const enviado = db.select({ solId: schema.sentEmails.solicitudId }).from(schema.sentEmails).where(eq(schema.sentEmails.messageId, r)).get();
    const nuestra = solicitudVigente(enviado?.solId);
    if (nuestra) return nuestra;
    // 2b) Está en el hilo de un correo que YA generó (o se sumó a) una solicitud. Acá sí hay
    //     ambigüedad: ver `esPedidoNuevoEnElHilo`.
    const recibido = db.select({ id: schema.emailMessages.id, solId: schema.emailMessages.replySolicitudId, asunto: schema.emailMessages.asunto })
      .from(schema.emailMessages).where(eq(schema.emailMessages.messageId, r)).get();
    const destino = recibido?.solId
      ?? (recibido?.id ? db.select({ id: schema.solicitudes.id }).from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, recibido.id)).get()?.id : undefined);
    // Si la solicitud del hilo está borrada se sigue con las otras referencias: puede haber otra
    // viva más arriba en la cadena, y si no la hay el correo entra como pedido nuevo.
    const vigente = solicitudVigente(destino);
    if (vigente) {
      if (esPedidoNuevoEnElHilo(email, vigente)) return null;
      if (esOtroGrupoDeGente(parsed, vigente)) return null;
      return vigente;
    }
  }
  return null;
}

/** Asunto sin los "RE:"/"RV:"/"Fwd:" ni el ruido de puntuación, para comparar dos asuntos. */
function asuntoNormalizado(asunto: string | null | undefined): string {
  return (asunto ?? '')
    .replace(/^\s*((re|rv|fw|fwd|reenv[ií]ar?)\s*:\s*)+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * ¿Este correo es un PEDIDO NUEVO escrito dentro de un hilo viejo?
 *
 * Caso real (ZENIT, 04/09): en agosto el local mandó "Ejemplo. SOLICITUD DE FAO (ZENIT) —
 * Comercial x2", que generó OA-2026-0026. El 04/09 escribió un pedido distinto —"SOLICITUD DE FAO
 * (ZENIT) — INSTALACION WIFI", 6 personas— pero lo redactó dentro de la MISMA conversación de
 * Outlook y le cambió el asunto. Outlook conserva la cadena de References al editar el asunto, así
 * que por el hilo parecía documentación del pedido de agosto: las 6 personas de la instalación de
 * wifi se colgaron de una solicitud de otro trabajo, ya autorizada y con vigencia al 20/09.
 *
 * El discriminador es el asunto. Si el correo trae un asunto de pedido de FAO y ese asunto es
 * DISTINTO del asunto con el que se abrió la solicitud a la que apunta el hilo, entonces el
 * remitente cambió de tema: es otro pedido. Si el asunto es el mismo (un "RE:" del mismo hilo), es
 * la misma gestión y se suma.
 *
 * Ojo: esto NO se aplica cuando el correo responde a uno que mandó el sistema (2a) ni cuando trae
 * el número de orden (1). Esas dos señales son explícitas y siguen mandando.
 */
function esPedidoNuevoEnElHilo(email: typeof schema.emailMessages.$inferSelect, solicitudId: number): boolean {
  const propio = asuntoNormalizado(email.asunto);
  // Sin un asunto de pedido de FAO no hay razón para dudar: es correspondencia del hilo.
  if (!propio || !/\bfao\b/i.test(propio) || !parseLocalFromSubject(email.asunto)) return false;

  const sol = db.select({ emailMessageId: schema.solicitudes.emailMessageId }).from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get();
  if (!sol?.emailMessageId) return false;
  const origen = db.select({ asunto: schema.emailMessages.asunto }).from(schema.emailMessages).where(eq(schema.emailMessages.id, sol.emailMessageId)).get();
  if (!origen) return false;

  return asuntoNormalizado(origen.asunto) !== propio;
}

/**
 * Segunda red para el hilo: ¿la planilla que trae el correo es de OTRA gente?
 *
 * El asunto no siempre delata el pedido nuevo. Hay locales que usan el mismo asunto para todo
 * ("SOLICITUD DE FAO (PEQUES) EMPRESA", sin decir de qué trabajo se trata) y contestan siempre
 * dentro del mismo hilo. Ahí lo que distingue un pedido nuevo de la documentación que faltaba es
 * la GENTE: si la solicitud ya se cerró y la planilla trae un grupo que no tiene una sola persona
 * en común con ella, es otro trabajo.
 *
 * Dos condiciones, las dos necesarias:
 *
 *  - La solicitud destino ya está TERMINADA (tiene número de orden informado al local). Mientras
 *    está abierta, que llegue gente nueva es lo normal: el local está completando su pedido.
 *  - NINGUNA de las personas de la planilla está en esa solicitud. Con una sola en común se
 *    considera la misma gestión (mandaron la nómina corregida, agregaron un ayudante). Es la
 *    versión conservadora a propósito: preferimos sumar de más —que eso deja el correo en el
 *    respaldo avisando "re-revisá"— antes que partir en dos un pedido que era uno solo.
 *
 * No se aplica cuando el correo trae el número de orden ni cuando responde un correo nuestro: en
 * el segundo caso justamente le pedimos la nómina, y esa gente todavía no está en la solicitud.
 */
function esOtroGrupoDeGente(parsed: Parsed, solicitudId: number): boolean {
  if (!yaSeInformo(solicitudId)) return false; // todavía en trámite: sumar gente es parte del trámite

  const { filas } = leerPersonasDelCorreo(parsed);
  // Solo filas que son una persona de verdad: un teléfono de la firma no define un pedido nuevo.
  const documentos = filas
    .filter((f) => { const n = filaANombre(f); return pareceNombreDePersona(n.nombre, n.apellido); })
    .map((f) => interpretarDocumento(f.cuil ?? '', f.dni ?? ''))
    .filter((d) => d.cuil || d.dni);
  if (documentos.length === 0) return false; // sin planilla legible no hay nada que comparar

  // Documentos de la gente que YA está en la solicitud. Se indexa por CUIL y por DNI, porque la
  // misma persona puede venir identificada de las dos formas.
  const claves = new Set<string>();
  for (const p of db
    .select({ cuil: schema.personas.cuil, dni: schema.personas.dni })
    .from(schema.solicitudPersonas)
    .innerJoin(schema.personas, eq(schema.personas.id, schema.solicitudPersonas.personaId))
    .where(eq(schema.solicitudPersonas.solicitudId, solicitudId))
    .all()) {
    if (p.cuil) claves.add(p.cuil);
    if (p.dni) claves.add(p.dni);
  }
  if (claves.size === 0) return false; // solicitud sin gente: no hay con qué comparar

  const algunaEnComun = documentos.some((d) => (d.cuil && claves.has(d.cuil)) || (d.dni && claves.has(d.dni)));
  return !algunaEnComun;
}

/**
 * ¿A esta solicitud ya se le informó el resultado al local?
 *
 * Antes esto se preguntaba con `!!sol.nroOrden`, y el número de orden se asigna AL CREARLA (114
 * de 115 lo tienen), así que daba verdadero siempre: cualquier correo que se sumara a una
 * solicitud quedaba marcado "ya terminada: re-revisá" y caía en el respaldo, incluso cuando la
 * solicitud se había creado diez minutos antes y nadie la había mirado todavía.
 *
 * La señal real es haberle mandado el resultado de la revisión: a partir de ahí el local tiene una
 * respuesta en la mano y una autorización que se apoya en documentación que alguien aprobó, así que
 * lo que llegue después tiene que volver a revisarse. Antes de eso, que llegue documentación es el
 * curso normal del trámite y no hay nada que avisar.
 */
function yaSeInformo(solicitudId: number): boolean {
  return !!db.select({ id: schema.sentEmails.id }).from(schema.sentEmails)
    .where(and(eq(schema.sentEmails.solicitudId, solicitudId), eq(schema.sentEmails.tipo, 'RESULTADO_REVISION'), eq(schema.sentEmails.ok, true)))
    .get();
}
/**
 * Suma la documentación / personas de un correo a una solicitud EXISTENTE (respuesta con
 * documentación faltante, o mail con el número de orden en el asunto). No duplica personas
 * (mismo CUIL) ni requiere intervención. Deja un comentario y, si la solicitud ya estaba
 * terminada, la marca para re-revisar (aparece en la campanita/respaldo).
 */
export async function sumarASolicitud(email: typeof schema.emailMessages.$inferSelect, emailId: number, solId: number, parsed: Parsed): Promise<void> {
  const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solId)).get();
  if (!sol || sol.deletedAt) {
    // Red de seguridad: `detectarSolicitudDestino` ya no devuelve solicitudes borradas, así que por
    // el camino normal no se llega acá. Si se llega igual (una llamada directa, o la solicitud
    // borrada entre la detección y esto), el correo va al respaldo CON la cuenta de su
    // documentación: el 📎 del respaldo sale de este campo, y dejarlo sin escribir mostraba 0
    // adjuntos en un correo que traía 6 PDF. Quien mira la lista lo descarta como si fuera
    // correspondencia vacía, que es exactamente lo que pasó con el de 47 Avenida del 05/10.
    const nAdjuntos = contarDocumentacion(parsed);
    db.update(schema.emailMessages).set({
      estado: 'NEEDS_REVIEW',
      error: nAdjuntos > 0
        ? `Responde a una solicitud que ya no está disponible, y trae ${nAdjuntos} documento(s). Creá una solicitud nueva desde el respaldo para no perderlos.`
        : 'Responde a una solicitud que ya no está disponible. Revisá a mano.',
      attachmentsCount: nAdjuntos,
      updatedAt: nowIso(),
    }).where(eq(schema.emailMessages.id, emailId)).run();
    return;
  }

  const { filas } = leerPersonasDelCorreo(parsed);
  let descartadasPorNombre = 0;
  // Tipo declarado en el asunto/cuerpo de la respuesta; si no viene, se hereda del tipo de la
  // solicitud (si todas sus personas ya son del mismo tipo). Así las personas que llegan en una
  // respuesta quedan con el mismo tipo que el resto y no hay que definirlo a mano.
  const tipoDeclarado = parseTipo(email.asunto) ?? parseTipo(parsed.text);
  const catsSolicitud = [...new Set(
    db.select({ categoria: schema.personas.categoria })
      .from(schema.solicitudPersonas)
      .innerJoin(schema.personas, eq(schema.personas.id, schema.solicitudPersonas.personaId))
      .where(eq(schema.solicitudPersonas.solicitudId, solId))
      .all().map((r) => r.categoria).filter((c): c is string => !!c),
  )];
  const categoriaHeredada = catsSolicitud.length === 1 ? catsSolicitud[0] : null;
  let agregadas = 0;
  for (const fila of filas) {
    const cuil = normalizeCuil(fila.cuil ?? '');
    const dni = normalizeDni(fila.dni ?? '');
    if (cuil.length < 10 && dni.length < 7) continue;
    const nc = filaANombre(fila);
    // Sin un nombre plausible no se crea la persona: casi siempre es un pedazo de la firma del
    // remitente (un telefono, una direccion) que el parser del cuerpo tomo por una fila de la tabla.
    if (!pareceNombreDePersona(nc.nombre, nc.apellido)) { descartadasPorNombre++; continue; }
    const { persona } = findOrCreatePersona({ cuil, dni, nombre: nc.nombre, apellido: nc.apellido });
    // El tipo declarado manda; si no hay, y la persona no tiene tipo, hereda el de la solicitud.
    const nuevoTipo = tipoDeclarado ?? (persona.categoria ? null : categoriaHeredada);
    if (nuevoTipo && persona.categoria !== nuevoTipo) db.update(schema.personas).set({ categoria: nuevoTipo, updatedAt: nowIso() }).where(eq(schema.personas.id, persona.id)).run();
    const ya = db.select({ id: schema.solicitudPersonas.id }).from(schema.solicitudPersonas).where(and(eq(schema.solicitudPersonas.solicitudId, solId), eq(schema.solicitudPersonas.personaId, persona.id))).get();
    if (!ya) { db.insert(schema.solicitudPersonas).values({ solicitudId: solId, personaId: persona.id }).run(); agregadas++; }
  }

  const nAdjuntos = contarDocumentacion(parsed);
  const terminada = yaSeInformo(solId);
  // ¿El correo TRAE algo, o es correspondencia? Un "gracias", un "recibido" o una consulta
  // pertenecen a la solicitud y se guardan, pero no hay nada nuevo que revisar.
  const aporta = agregadas > 0 || nAdjuntos > 0;

  const partes = aporta
    ? [`📎 Llegó documentación por email (asunto: "${email.asunto ?? '—'}").`]
    : [`💬 Respuesta del local por email (asunto: "${email.asunto ?? '—'}"), sin documentación nueva.`];
  if (agregadas > 0) partes.push(`${agregadas} persona(s) nueva(s) agregada(s).`);
  if (nAdjuntos > 0) partes.push(`${nAdjuntos} adjunto(s) disponibles en la revisión (incluye lo que venga en ZIP).`);
  if (aporta) partes.push('Re-revisá la documentación.');
  db.insert(schema.comentarios).values({ solicitudId: solId, contenido: partes.join(' ') }).run();

  // Se marca para re-revisar solo si el correo TRAE algo y la solicitud ya se le informó al local.
  // Antes bastaba con que llegara cualquier correo: un "gracias" al mail del resultado dejaba la
  // solicitud en revisión, y para sacarle el cartel había que mandarla a la papelera —con lo cual
  // desaparecía la FAO entera—. Ese aviso va EN LA SOLICITUD y no en el respaldo, porque el correo
  // se procesó bien: su documentación, si trajo, ya está adentro.
  const marcarParaRevisar = terminada && aporta;
  if (marcarParaRevisar) db.update(schema.solicitudes).set({ docNuevaAt: nowIso() }).where(eq(schema.solicitudes.id, solId)).run();

  // Vincular el correo a la solicitud (para ver sus adjuntos en la revisión).
  db.update(schema.emailMessages).set({
    estado: 'PROCESSED',
    error: marcarParaRevisar ? `Se sumó a la solicitud ${sol.nroOrden}, que ya estaba informada: quedó marcada para re-revisar.` : null,
    replySolicitudId: solId,
    localId: sol.localId,
    // Se guarda acá también: es lo que muestra el 📎 del respaldo, y los correos que se sumaban a
    // una solicitud quedaban en 0 adjuntos aunque trajeran la documentación que se estaba esperando.
    attachmentsCount: nAdjuntos,
    updatedAt: nowIso(),
  }).where(eq(schema.emailMessages.id, emailId)).run();

  recomputeSolicitudEstado(solId);
  audit({ accion: 'EMAIL_SUMADO_A_SOLICITUD', entidad: 'solicitud', entidadId: solId, detalle: { emailId, personasAgregadas: agregadas, adjuntos: nAdjuntos, terminada, aporta, descartadasPorNombre } });
}

/**
 * Procesa un email entrante según el protocolo nuevo:
 *  - El asunto declara el local: "Solicitud FAO (Local) ...".
 *  - Un Excel adjunto OPCIONAL (columnas CUIL y Nombre completo) lista a las personas.
 *    Sin Excel la solicitud se crea vacía y las personas se cargan a mano.
 *  - Se crea UNA solicitud (un local) con VARIAS personas.
 * La documentación se revisa manualmente desde el email embebido en la solicitud.
 */
/**
 * `force`: crea la solicitud aunque no se pueda leer la lista de personas (es lo que hace
 * "Procesar igual" desde el respaldo).
 * `nuevaSolicitud`: además ignora a qué solicitud pertenece el correo y crea una aparte. Es para
 * el caso raro en que la detección de hilo se equivoca. Antes "Procesar igual" hacía las DOS
 * cosas, y por eso una respuesta que ya estaba vinculada a una solicitud terminaba creando una
 * solicitud duplicada y vacía.
 */
/**
 * Le pide al remitente la lista de personas en un formato legible.
 *
 * Sale de acá y no del flujo de procesamiento porque ahora se manda en dos momentos distintos:
 * automáticamente al rechazar el correo (si MAIL_AVISO_SIN_PERSONAS está en 1) o a mano desde el
 * respaldo, cuando quien revisa mira el PDF y decide que no le alcanza para cargarla él.
 */
export async function pedirListaAlRemitente(emailId: number): Promise<boolean> {
  const email = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, emailId)).get();
  if (!email) return false;
  const to = extraerEmail(email.remitente);
  if (!to) return false;

  // El malentendido más común: mandan la nómina como foto o PDF y dan por hecho que se procesó
  // ("la nómina fue enviada en el primer mail"). Conviene decirlo con todas las letras, porque si
  // no reenvían lo mismo en el mismo formato.
  const texto = `Recibimos su correo${email.asunto ? ` ("${email.asunto}")` : ''}, pero no pudimos leer la lista de personas a autorizar.

IMPORTANTE: el sistema NO puede leer la nómina si viene como imagen (foto, captura, .png, .jpg) ni dentro de un PDF. Necesitamos el texto, de una de estas dos formas:

  1) Un archivo Excel adjunto, con una columna de CUIL o DNI y el nombre y apellido de cada persona.
  2) O la lista escrita en el cuerpo de este correo, una persona por línea, con su DNI.

Si ya nos mandó la nómina en una foto o un PDF, por favor reenvíela en alguna de esas dos formas.${nroOrdenDe(email)}`;

  const r = await sendMail({
    to, subject: 'No procesada — falta la lista de personal', text: texto,
    inReplyTo: email.messageId, meta: { tipo: 'SIN_PERSONAS', emailMessageId: emailId },
  });
  return r.enviado;
}

export async function processEmail(emailId: number, opts: { force?: boolean; nuevaSolicitud?: boolean } = {}): Promise<void> {
  const email = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, emailId)).get();
  if (!email) return;
  if (email.estado === 'PROCESSED') return;

  setEmailEstado(emailId, 'PROCESSING');
  try {
    if (!email.rawStoredPath || !fs.existsSync(email.rawStoredPath)) {
      setEmailEstado(emailId, 'ERROR', 'No se encontró el email guardado.');
      return;
    }
    const parsed = await simpleParser(fs.readFileSync(email.rawStoredPath));

    // Huella del contenido: se guarda siempre, aunque el correo termine rechazado, para poder
    // reconocer después la copia que llegue por la otra casilla.
    const huella = huellaContenido(email, parsed);
    db.update(schema.emailMessages).set({ huella, updatedAt: nowIso() }).where(eq(schema.emailMessages.id, emailId)).run();

    // ¿Es el MISMO pedido que ya entró por la otra casilla? Pasa mientras conviven la dirección
    // vieja y la nueva: el local manda dos correos separados (Message-ID distinto) con el mismo
    // asunto y los mismos adjuntos. Se engancha al pedido original en vez de duplicarlo.
    if (!opts.force && !opts.nuevaSolicitud) {
      const dup = buscarDuplicado(emailId, huella);
      if (dup) {
        const detalle = `Copia del correo #${dup.previo.id} del ${(dup.previo.fechaEmail ?? '').slice(0, 10)} (el mismo pedido llegó a las dos casillas).`;
        db.update(schema.emailMessages).set({
          estado: 'PROCESSED',
          error: dup.solicitudId ? `${detalle} No se creó otra solicitud.` : `${detalle} El original tampoco generó solicitud: revisalo a mano.`,
          replySolicitudId: dup.solicitudId,
          localId: email.localId ?? dup.previo.localId,
          attachmentsCount: contarDocumentacion(parsed),
          updatedAt: nowIso(),
        }).where(eq(schema.emailMessages.id, emailId)).run();
        audit({ accion: 'EMAIL_DUPLICADO', entidad: 'email', entidadId: emailId, detalle: { originalId: dup.previo.id, solicitudId: dup.solicitudId } });
        return;
      }
    }

    // ¿Pertenece a una solicitud EXISTENTE? (número de orden en el asunto, o respuesta a un
    // correo que enviamos / a uno que ya generó una solicitud). En ese caso la documentación y
    // las personas nuevas se SUMAN a esa solicitud (no se crea otra ni se duplica).
    const solDestino = detectarSolicitudDestino(email, parsed, opts.nuevaSolicitud);
    if (solDestino != null) {
      // Si la orden que cita es de otro local, no se decide solo: queda en el respaldo con los dos
      // locales a la vista. `force` es el botón "Procesar" del respaldo, o sea alguien que ya miró.
      const conflicto = opts.force ? null : conflictoDeLocal(email, solDestino);
      if (conflicto) {
        const motivo = `Cita la orden ${conflicto.nroOrden ?? `#${solDestino}`}, que es de ${conflicto.orden}, pero ${conflicto.direccion} siempre escribió por ${conflicto.remitente}. No se sumó a ninguna solicitud: revisá cuál corresponde.`;
        setEmailEstado(emailId, 'NEEDS_REVIEW', motivo);
        db.update(schema.emailMessages).set({ attachmentsCount: contarDocumentacion(parsed), updatedAt: nowIso() }).where(eq(schema.emailMessages.id, emailId)).run();
        audit({ accion: 'EMAIL_LOCAL_CRUZADO', entidad: 'email', entidadId: emailId, detalle: { solicitudId: solDestino, ...conflicto } });
        return;
      }
      await sumarASolicitud(email, emailId, solDestino, parsed);
      return;
    }

    // Aplanar adjuntos (expandir ZIPs) para poder ubicar el Excel.
    const items: FileItem[] = [];
    for (const att of parsed.attachments ?? []) {
      const name = att.filename ?? 'adjunto';
      const buf = att.content as Buffer;
      if (isZip(name, att.contentType)) {
        for (const f of extractZip(buf).files) items.push({ filename: f.filename, buffer: f.buffer });
      } else {
        items.push({ filename: name, buffer: buf });
      }
    }
    db.update(schema.emailMessages).set({ attachmentsCount: contarDocumentacion(parsed) }).where(eq(schema.emailMessages.id, emailId)).run();

    // Identificar el local por el asunto. Si no coincide, queda "(Sin asignar)".
    const detectedLocalId = email.localId ?? identifyLocal(email.asunto);
    const localFinal = detectedLocalId ?? getPlaceholderLocalId();
    if (detectedLocalId && !email.localId) db.update(schema.emailMessages).set({ localId: detectedLocalId }).where(eq(schema.emailMessages.id, emailId)).run();

    // El Excel de personas es OPCIONAL. Si no viene (o no se puede leer), la solicitud
    // se crea igual y el admin carga las personas a mano desde el detalle.
    const excel = items.find((it) => esExcel(it.filename));
    let filas = excel ? parsePersonasSpreadsheet(excel.filename, excel.buffer) : [];
    // Si no hubo Excel (o no se pudo leer), buscar la lista de personas en el CUERPO del email
    // (tabla HTML o texto plano con CUIL + nombre).
    let origenPersonas: 'excel' | 'cuerpo' | null = filas.length ? 'excel' : null;
    if (filas.length === 0) {
      const desdeCuerpo = parsePersonasFromBody(parsed.html || undefined, parsed.text || undefined);
      if (desdeCuerpo.length) { filas = desdeCuerpo; origenPersonas = 'cuerpo'; }
    }

    // Quedarse con las filas que de verdad son una persona, ANTES de decidir nada.
    //
    // No es un detalle de orden: decidiendo con las filas crudas, un correo sin nómina pasaba el
    // control y recién se descartaban las filas al darlas de alta, con la solicitud ya creada y sin
    // avisarle al local. Caso real (OA-2026-0221): en un reenvío de 47 Avenida el parser del cuerpo
    // leyó 3 "personas" de los encabezados del mail —"De:", "Para:", con el 47985775 sacado de los
    // teléfonos de la marca—, así que `filas.length` era 3 y el rechazo no se disparó. Las 3 se
    // descartaron después y quedó una solicitud vacía para borrar a mano.
    const filasValidas = filas.filter((f) => {
      if (normalizeCuil(f.cuil ?? '').length < 10 && normalizeDni(f.dni ?? '').length < 7) return false;
      const nc = (f.nombre !== undefined || f.apellido !== undefined) && (f.nombre || f.apellido)
        ? { nombre: (f.nombre || '').trim(), apellido: (f.apellido || '').trim() }
        : splitNombreCompleto(f.nombreCompleto);
      return pareceNombreDePersona(nc.nombre, nc.apellido);
    });
    const descartadasAntesDeDecidir = filas.length - filasValidas.length;
    filas = filasValidas;
    if (filas.length === 0) origenPersonas = null;

    // Límite operativo/anti-sobrecarga: una planilla con demasiadas personas no se puede revisar
    // a mano (y una enorme, ej. 3300, cuelga el sistema). No se crea la solicitud: se avisa al
    // remitente por email y el correo queda en respaldo con una notificación en el sistema.
    if (filas.length > MAX_PERSONAS_PLANILLA) {
      const motivo = `La planilla tiene ${filas.length} personas (máximo permitido: ${MAX_PERSONAS_PLANILLA}). No se procesó automáticamente: se avisó al remitente para que la divida.`;
      const to = extraerEmail(email.remitente);
      const asunto = `No procesada — supera el máximo de ${MAX_PERSONAS_PLANILLA} personas`;
      const texto = `Recibimos su solicitud${email.asunto ? ` ("${email.asunto}")` : ''}, pero incluye ${filas.length} personas y el máximo por solicitud es ${MAX_PERSONAS_PLANILLA}.

Por favor divida el pedido en solicitudes de hasta ${MAX_PERSONAS_PLANILLA} personas y reenvíelas. Cada envío se procesa por separado.`;
      let avisoEnviado = false;
      if (to) { avisoEnviado = (await sendMail({ to, subject: asunto, text: texto, inReplyTo: email.messageId, meta: { tipo: 'PLANILLA_EXCESIVA', emailMessageId: emailId } })).enviado; }
      setEmailEstado(emailId, 'NEEDS_REVIEW', avisoEnviado
        ? `${motivo}`
        : `La planilla tiene ${filas.length} personas (máximo ${MAX_PERSONAS_PLANILLA}). No se pudo avisar al remitente automáticamente${to ? '' : ' (el correo no tiene remitente)'}; avisale a mano.`);
      audit({ accion: 'EMAIL_PLANILLA_EXCESIVA', entidad: 'email', entidadId: emailId, detalle: { personas: filas.length, max: MAX_PERSONAS_PLANILLA, avisoEnviado, to } });
      return;
    }

    // Rechazo automático: no se pudo leer NINGUNA persona (no vino Excel ni una tabla legible en
    // el cuerpo). No se crea la solicitud aunque el correo traiga documentación: se le pide la
    // lista al remitente para que reenvíe el pedido completo y el sistema lo procese solo. Dar de
    // alta la solicitud vacía y cargar las personas a mano no escala.
    // El admin puede forzar el alta igual desde el respaldo con "Procesar igual".
    if (filas.length === 0 && !opts.force) {
      const to = extraerEmail(email.remitente);
      // El aviso al remitente es OPCIONAL: muchas veces la nómina está en el PDF y se carga a mano,
      // y en ese caso pedirle la lista al local es ruido. Con MAIL_AVISO_SIN_PERSONAS=0 el correo
      // igual queda frenado en el respaldo, pero no sale nada; desde ahí hay un botón para pedirla
      // cuando sí corresponde.
      const avisoEnviado = env.mail.avisoSinPersonas && to ? await pedirListaAlRemitente(emailId) : false;
      setEmailEstado(emailId, 'NEEDS_REVIEW', avisoEnviado
        ? 'No trae la lista de personas (ni Excel ni tabla legible en el cuerpo). Se avisó al remitente para que la reenvíe.'
        : `No trae la lista de personas${to ? '' : ' y el correo no tiene remitente'}: cargala a mano o pedísela al remitente desde el respaldo.`);
      audit({ accion: 'EMAIL_SIN_PERSONAS', entidad: 'email', entidadId: emailId, detalle: { avisoEnviado, to, adjuntos: adjuntosDocumento(parsed).length, rechazado: true, descartadasPorNombre: descartadasAntesDeDecidir } });
      return;
    }

    // Si llegó acá forzado y sin personas, se crea igual (el admin las cargará a mano).
    const avisoPersonas = filas.length > 0 ? null : 'Sin personas legibles: cargalas a mano en la solicitud.';

    // Reusar la solicitud de este email si ya existe (idempotencia); si no, crearla.
    let sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, emailId)).get();
    if (!sol) {
      // personaId (contacto principal) es legacy y opcional: las personas reales van en solicitud_personas.
      const nueva = db.insert(schema.solicitudes).values({ localId: localFinal, emailMessageId: emailId, estado: 'PENDIENTE' }).returning().get();
      if (!nueva) throw new Error('No se pudo crear la solicitud del email.');
      sol = nueva;
      audit({ accion: 'SOLICITUD_CREADA', entidad: 'solicitud', entidadId: sol.id, detalle: { origen: 'email', personas: filas.length } });
    } else if (detectedLocalId && sol.localId !== localFinal) {
      db.update(schema.solicitudes).set({ localId: localFinal, updatedAt: nowIso() }).where(eq(schema.solicitudes.id, sol.id)).run();
    }

    // Tipo de contratista declarado en el asunto o, si no está, en el cuerpo del email
    // (define qué documentación se exige). Si no aparece, el admin lo define a mano.
    const tipo = parseTipo(email.asunto) ?? parseTipo(parsed.text);

    // Alta/asociación de cada persona del Excel.
    const personaIds: number[] = [];
    let descartadasPorNombre = 0;
    for (const fila of filas) {
      const cuil = normalizeCuil(fila.cuil ?? '');
      const dni = normalizeDni(fila.dni ?? '');
      if (cuil.length < 10 && dni.length < 7) continue;
      // Dos columnas (apellido + nombre) => se usan directo; una sola => se separa.
      const nc = (fila.nombre !== undefined || fila.apellido !== undefined) && (fila.nombre || fila.apellido)
        ? { nombre: (fila.nombre || '').trim() || '(a completar)', apellido: (fila.apellido || '').trim() || '(a completar)' }
        : splitNombreCompleto(fila.nombreCompleto);
      // Sin un nombre plausible no se crea la persona: casi siempre es un pedazo de la firma del
      // remitente (un telefono, una direccion) que el parser del cuerpo tomo por una fila de la tabla.
      if (!pareceNombreDePersona(nc.nombre, nc.apellido)) { descartadasPorNombre++; continue; }
      const { persona, created } = findOrCreatePersona({ cuil, dni, nombre: nc.nombre, apellido: nc.apellido });
      if (created) audit({ accion: 'PERSONA_CREADA', entidad: 'persona', entidadId: persona.id, detalle: { origen: 'email', emailId } });
      // El asunto declara Empresa/Monotributista => se asigna la categoría (para exigir sus documentos).
      if (tipo && persona.categoria !== tipo) {
        db.update(schema.personas).set({ categoria: tipo, updatedAt: nowIso() }).where(eq(schema.personas.id, persona.id)).run();
      }
      db.insert(schema.solicitudPersonas).values({ solicitudId: sol.id, personaId: persona.id }).onConflictDoNothing().run();
      personaIds.push(persona.id);
    }

    // Reenvíos: si una persona ya tenía una solicitud ABIERTA del mismo local en OTRO email
    // (típicamente OBSERVADA), esa queda "reemplazada" por ésta (la documentación corregida).
    for (const personaId of personaIds) {
      const previas = db
        .select({ spId: schema.solicitudPersonas.id, solicitudId: schema.solicitudPersonas.solicitudId })
        .from(schema.solicitudPersonas)
        .innerJoin(schema.solicitudes, eq(schema.solicitudPersonas.solicitudId, schema.solicitudes.id))
        .where(and(
          eq(schema.solicitudPersonas.personaId, personaId),
          eq(schema.solicitudes.localId, localFinal),
        ))
        .all()
        .filter((r) => r.solicitudId !== sol!.id);
      for (const p of previas) {
        const spRow = db.select().from(schema.solicitudPersonas).where(eq(schema.solicitudPersonas.id, p.spId)).get();
        if (!spRow || ['AUTORIZADA', 'RECHAZADA', 'REVOCADA', 'REEMPLAZADA'].includes(spRow.estado)) continue;
        db.update(schema.solicitudPersonas).set({ estado: 'REEMPLAZADA', updatedAt: nowIso() }).where(eq(schema.solicitudPersonas.id, p.spId)).run();
        recomputeSolicitudEstado(p.solicitudId);
        audit({ accion: 'SOLICITUD_REEMPLAZADA', entidad: 'solicitud', entidadId: p.solicitudId, detalle: { personaId, reemplazadaPor: sol.id } });
      }
    }

    recomputeSolicitudEstado(sol.id);
    // El número de orden se asigna al entrar el mail (identifica la solicitud desde el minuto cero).
    // Es idempotente y compartido por todo el grupo del email.
    asignarNroOrden(sol.id);
    // Siempre PROCESSED: si el local no se identificó, la solicitud queda "(Sin asignar)"
    // y el admin la reasigna desde Solicitudes (ya no existe la bandeja de Revisión manual).
    setEmailEstado(emailId, 'PROCESSED', avisoPersonas);
    audit({ accion: 'EMAIL_PROCESADO', entidad: 'email', entidadId: emailId, detalle: { personas: personaIds.length, origenPersonas, localDetectado: detectedLocalId, aviso: avisoPersonas, descartadasPorNombre } });
  } catch (err: any) {
    logger.error({ err }, `Error procesando email ${emailId}`);
    setEmailEstado(emailId, 'ERROR', err?.message ?? 'Error desconocido.');
  }
}
