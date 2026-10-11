import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { eq, and, lt, isNotNull, notInArray } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { nowIso } from '../../lib/datetime.js';
import { getEmailConfig, type EmailConfig } from '../config/service.js';
import { processEmail } from '../processing/processor.js';

interface PollResult {
  ok: boolean;
  nuevos: number;
  procesados: number;
  error?: string;
}

let running = false;
let lastSyncAt: string | null = null;
let lastResult: PollResult | null = null;

export function getSchedulerStatus() {
  const c = getEmailConfig();
  return {
    configurado: !!c.imapHost,
    casilla: c.imapUser,
    pollMinutes: c.pollMinutes,
    running,
    lastSyncAt,
    lastResult,
  };
}

function buildClient(c: EmailConfig = getEmailConfig()) {
  return new ImapFlow({
    host: c.imapHost,
    port: c.imapPort,
    secure: c.imapSecure,
    auth: { user: c.imapUser, pass: c.imapPassword },
    logger: false,
    // Por defecto son 90 s. Con una casilla caída (pasa durante una mudanza) eso hace esperar
    // minuto y medio a cada revisión, y a quien apretó "Revisar buzón ahora".
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
  });
}

export async function verifyImap(cfg?: EmailConfig): Promise<{ ok: boolean; error?: string }> {
  const c = cfg ?? getEmailConfig();
  if (!c.imapHost) return { ok: false, error: 'Falta configurar el servidor IMAP (variables MAIL_IMAP_*).' };
  const client = buildClient(c);
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'No se pudo conectar.' };
  }
}

function safeMessageFile(messageId: string): string {
  const safe = messageId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return `${Date.now()}_${safe || 'msg'}.eml`;
}

/**
 * Identificador del mensaje para no procesarlo dos veces. Normalmente es el Message-ID —el mismo
 * en las dos casillas cuando el local manda una sola copia con las dos direcciones en el "Para".
 * Algunos correos llegan SIN ese header (formularios web, equipos mal configurados): antes se
 * salteaban para siempre y desaparecían sin dejar rastro. Para esos se arma una huella estable
 * con fecha + remitente + asunto, que da el mismo valor en cada revisión.
 */
export function claveMensaje(env2: any): string {
  const mid = env2?.messageId?.trim();
  if (mid) return mid;
  const huella = [env2?.date ? new Date(env2.date).toISOString() : '', env2?.from?.[0]?.address ?? '', env2?.subject ?? ''].join('|');
  return `<sin-message-id-${crypto.createHash('sha1').update(huella).digest('hex').slice(0, 24)}@local>`;
}

function yaGuardado(mid: string): boolean {
  return !!db.select({ id: schema.emailMessages.id }).from(schema.emailMessages).where(eq(schema.emailMessages.messageId, mid)).get();
}

/** Guarda el .eml crudo y crea la fila de email (estado RECEIVED). Devuelve el id, o null si falla. */
function persistirEmail(mid: string, env2: any, source: Buffer): number | null {
  // Recheck contra la base justo antes de escribir: message_id es UNIQUE y, si el buzón trae dos
  // copias del mismo mensaje, el INSERT explota. Antes esa excepción cortaba la revisión entera.
  if (yaGuardado(mid)) return null;
  fs.mkdirSync(env.emailsPath, { recursive: true });
  const rawPath = path.join(env.emailsPath, safeMessageFile(mid));
  fs.writeFileSync(rawPath, source);
  const remitente = env2?.from?.[0] ? `${env2.from[0].name ?? ''} <${env2.from[0].address ?? ''}>`.trim() : null;
  try {
    const row = db
      .insert(schema.emailMessages)
      .values({ messageId: mid, remitente, asunto: env2?.subject ?? null, fechaEmail: env2?.date ? new Date(env2.date).toISOString() : null, estado: 'RECEIVED', rawStoredPath: rawPath })
      .returning()
      .get();
    audit({ accion: 'EMAIL_RECIBIDO', entidad: 'email', entidadId: row.id, detalle: { remitente, asunto: env2?.subject } });
    return row.id;
  } catch (err) {
    // No dejar el .eml huérfano en disco si la fila no se pudo crear.
    try { fs.unlinkSync(rawPath); } catch { /* ignore */ }
    logger.warn({ err }, `No se pudo registrar el email ${mid}.`);
    return null;
  }
}

/**
 * Mensajes de un buzón que todavía no tenemos guardados, con su clave y su fecha. Descarta los
 * repetidos dentro de la misma vuelta. NO descarta por fecha: lo viejo se ingresa igual y después
 * se decide si se procesa o va al respaldo (ver `paraRevisar`), así nada se pierde en silencio.
 */
async function mensajesNuevos(client: ImapFlow): Promise<{ uid: number; mid: string; fecha: Date | null }[]> {
  const out: { uid: number; mid: string; fecha: Date | null }[] = [];
  const vistos = new Set<string>();
  for await (const msg of client.fetch('1:*', { uid: true, envelope: true })) {
    const f = msg.envelope?.date ? new Date(msg.envelope.date) : null;
    const mid = claveMensaje(msg.envelope);
    if (vistos.has(mid)) continue;
    vistos.add(mid);
    if (!yaGuardado(mid)) out.push({ uid: msg.uid, mid, fecha: f && !isNaN(f.getTime()) ? f : null });
  }
  return out;
}

/**
 * ¿Este correo tiene que ir al respaldo en vez de procesarse solo?
 *
 * Sí cuando es anterior a `MAIL_REVISAR_ANTES_DE`. Es para el arranque después de una caída del
 * correo: lo que llegó mientras el sistema no podía leer el buzón puede haberse cargado a mano, y
 * procesarlo automáticamente crearía la solicitud por segunda vez. Va al respaldo con el motivo
 * explicado, y desde ahí se decide de a uno: "Procesar igual" o "Descartar".
 */
export function paraRevisar(fecha: Date | null, revisarAntesDe: string): boolean {
  if (!revisarAntesDe) return false;
  const corte = new Date(`${revisarAntesDe}T00:00:00`);
  if (isNaN(corte.getTime())) return false;
  // Sin fecha en el sobre no se puede saber de cuándo es: mejor que lo mire una persona.
  if (!fecha) return true;
  return fecha < corte;
}

/** Nombre de la carpeta de spam/correo no deseado (por rol especial \Junk o por nombre común). */
async function carpetaSpam(client: ImapFlow): Promise<string | null> {
  const cajas = await client.list();
  for (const mb of cajas) if ((mb as any).specialUse === '\\Junk') return mb.path;
  const nombres = ['Spam', 'Junk', 'Junk Email', 'Bulk Mail', 'Correo no deseado', '[Gmail]/Spam', 'INBOX.Spam', 'INBOX.Junk'];
  const existentes = new Set(cajas.map((m) => m.path));
  return nombres.find((n) => existentes.has(n)) ?? null;
}

/** Cierra el job de procesamiento (antes quedaban todos en PROCESSING para siempre). */
function cerrarJob(jobId: number | undefined, estado: 'DONE' | 'ERROR', error?: string) {
  if (!jobId) return;
  try {
    db.update(schema.processingJobs).set({ estado, error: error ?? null, finishedAt: nowIso() }).where(eq(schema.processingJobs.id, jobId)).run();
  } catch { /* ignore */ }
}

/** Revisa el buzón: INBOX (procesa) y spam (deja en respaldo sin procesar). */
async function revisarBuzon(c: EmailConfig): Promise<PollResult> {
  const client = buildClient(c);
  let nuevos = 0;
  let procesados = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      for (const { uid, mid, fecha } of await mensajesNuevos(client)) {
        // Cada mensaje va en su propio try: uno que falle (adjunto ilegible, corte de red,
        // duplicado) no puede cortar la vuelta y dejar sin procesar a los que vienen atrás.
        try {
          const full = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
          if (!full || !full.source) continue;
          const rowId = persistirEmail(mid, full.envelope, full.source as Buffer);
          if (rowId == null) continue;
          nuevos++;

          // Llegó mientras el sistema no leía el buzón: no se procesa solo, va al respaldo.
          if (paraRevisar(fecha, c.revisarAntesDe)) {
            db.update(schema.emailMessages)
              .set({ estado: 'NEEDS_REVIEW', error: 'Llegó mientras el sistema no podía leer el buzón. Verificá si esta solicitud ya se cargó a mano; si no, usá "Procesar igual".', updatedAt: nowIso() })
              .where(eq(schema.emailMessages.id, rowId))
              .run();
            audit({ accion: 'EMAIL_A_RESPALDO', entidad: 'email', entidadId: rowId, detalle: { motivo: 'anterior al corte de revisión manual', fecha: fecha?.toISOString() ?? null } });
            continue;
          }

          // Job + procesamiento
          const job = db.insert(schema.processingJobs).values({ tipo: 'PROCESS_EMAIL', emailMessageId: rowId, estado: 'PROCESSING', startedAt: nowIso() }).returning().get();
          await processEmail(rowId);
          cerrarJob(job?.id, 'DONE');
          procesados++;

          // Mover a carpeta de procesados si está configurado (nunca borrar).
          if (c.processedFolder) {
            try {
              await client.messageMove(String(uid), c.processedFolder, { uid: true });
            } catch (err) {
              logger.warn({ err }, `No se pudo mover el email a ${c.processedFolder}`);
            }
          }
        } catch (err: any) {
          logger.error({ err }, `Fallo al ingresar el email uid ${uid} (${mid}); sigo con el resto.`);
        }
      }
    } finally {
      lock.release();
    }

    // Carpeta de SPAM: los correos que el proveedor marcó como no deseados NO se procesan
    // automáticamente. Se ingresan y quedan en respaldo (NEEDS_REVIEW) para revisarlos a mano.
    const spamPath = await carpetaSpam(client);
    if (spamPath) {
      const lockSpam = await client.getMailboxLock(spamPath);
      try {
        for (const { uid, mid, fecha } of await mensajesNuevos(client)) {
          try {
            const full = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
            if (!full || !full.source) continue;
            const rowId = persistirEmail(mid, full.envelope, full.source as Buffer);
            if (rowId == null) continue;
            nuevos++;
            db.update(schema.emailMessages)
              .set({ estado: 'NEEDS_REVIEW', error: 'Llegó a la carpeta de spam/correo no deseado. Revisá si es un pedido válido antes de procesarlo.', updatedAt: nowIso() })
              .where(eq(schema.emailMessages.id, rowId))
              .run();
            audit({ accion: 'EMAIL_SPAM_A_RESPALDO', entidad: 'email', entidadId: rowId });
          } catch (err: any) {
            logger.error({ err }, `Fallo al ingresar el email de spam uid ${uid} (${mid}); sigo con el resto.`);
          }
        }
      } finally {
        lockSpam.release();
      }
    }

    await client.logout();
    return { ok: true, nuevos, procesados };
  } catch (err: any) {
    logger.error({ err }, `Fallo al revisar el buzón IMAP (${c.imapUser}).`);
    try { await client.logout(); } catch { /* ignore */ }
    return { ok: false, nuevos, procesados, error: err?.message ?? 'Error de conexión.' };
  }
}

/** Solo se purga una vez por día; no hace falta más y así no se toca el disco en cada vuelta. */
let ultimaPurga = '';

/**
 * Borra del disco los `.eml` más viejos que la retención configurada.
 *
 * Los originales son el 97% del almacenamiento (1,9 MB por correo, unos 670 MB por mes) y crecen
 * para siempre, mientras que lo que el sistema usa —las personas, los adjuntos, quién autorizó—
 * ya está en la base y no se toca. Y el original no se pierde: el lector NO borra ni mueve nada
 * del buzón, así que sigue estando en la casilla.
 *
 * La fila del correo se conserva entera (remitente, asunto, fecha, cuántos adjuntos traía); lo
 * único que se pierde es poder abrirlo desde el sistema.
 *
 * No toca los que están en el respaldo ni los que quedaron con error: esos esperan que alguien
 * los mire, y para mirarlos hay que poder leerlos.
 */
export function purgarEmlViejos(meses = env.mail.retencionMeses): { borrados: number; mb: number } {
  if (!meses || meses <= 0) return { borrados: 0, mb: 0 };
  const corte = new Date();
  corte.setMonth(corte.getMonth() - meses);
  const corteIso = corte.toISOString();

  const viejos = db
    .select({ id: schema.emailMessages.id, ruta: schema.emailMessages.rawStoredPath })
    .from(schema.emailMessages)
    .where(and(
      isNotNull(schema.emailMessages.rawStoredPath),
      lt(schema.emailMessages.fechaRecibido, corteIso),
      notInArray(schema.emailMessages.estado, ['NEEDS_REVIEW', 'ERROR']),
    ))
    .all();

  let borrados = 0;
  let bytes = 0;
  for (const e of viejos) {
    try {
      if (e.ruta && fs.existsSync(e.ruta)) { bytes += fs.statSync(e.ruta).size; fs.unlinkSync(e.ruta); }
      db.update(schema.emailMessages).set({ rawStoredPath: null }).where(eq(schema.emailMessages.id, e.id)).run();
      borrados++;
    } catch (err) {
      logger.warn({ err }, `No se pudo borrar el .eml de #${e.id}`);
    }
  }

  const mb = Number((bytes / 1048576).toFixed(1));
  if (borrados > 0) {
    logger.info(`Purga de correos: ${borrados} .eml de más de ${meses} meses (${mb} MB liberados).`);
    audit({ accion: 'EMAILS_PURGADOS', entidad: 'email', detalle: { borrados, mb, meses, corte: corteIso.slice(0, 10) } });
  }
  return { borrados, mb };
}

/** Revisa el buzón una vez: descarga los emails nuevos, los guarda y los procesa. */
export async function pollNow(): Promise<PollResult> {
  // Nunca devolver `lastResult` acá: es el resultado de la vuelta ANTERIOR y se leía como si
  // fuera el de este click (con su error viejo, de una casilla que quizás ya se cambió).
  if (running) return { ok: false, nuevos: 0, procesados: 0, error: 'Ya hay una revisión en curso; esperá a que termine.' };
  const c = getEmailConfig();
  if (!c.imapHost || !c.imapPassword) {
    const r = { ok: false, nuevos: 0, procesados: 0, error: 'Falta configurar el correo (variables MAIL_IMAP_HOST / MAIL_IMAP_PASSWORD).' };
    lastResult = r;
    return r;
  }

  running = true;
  try {
    const r = await revisarBuzon(c);
    lastSyncAt = nowIso();
    const hoy = lastSyncAt.slice(0, 10);
    if (hoy !== ultimaPurga) { ultimaPurga = hoy; try { purgarEmlViejos(); } catch (err) { logger.warn({ err }, 'Falló la purga de .eml viejos.'); } }
    lastResult = r;
    logger.info(`Revisión de email: ${r.nuevos} nuevos, ${r.procesados} procesados${r.error ? ` (error: ${r.error})` : ''}.`);
    return r;
  } finally {
    running = false;
  }
}
