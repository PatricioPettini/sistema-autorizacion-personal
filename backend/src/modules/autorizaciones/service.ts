import { eq, and, desc } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { todayLocal, nowIso } from '../../lib/datetime.js';
import { env } from '../../config/env.js';
import { personaAutorizableEnSolicitud } from '../documentos/service.js';
import { recomputeSolicitudEstado } from '../solicitudes/service.js';
import { audit } from '../../lib/audit.js';

export interface VigenciaInfo {
  autorizacion: typeof schema.autorizaciones.$inferSelect | null;
  estado: 'AUTORIZADO' | 'NO_AUTORIZADO' | 'VENCIDO' | 'REVOCADO';
  vigenteHoy: boolean;
}

/** Determina si una persona tiene autorización vigente hoy (opcionalmente para un local). */
export function getVigencia(personaId: number, localId?: number): VigenciaInfo {
  const today = todayLocal();
  // La papelera NO afecta la autorización de la persona: una persona puede estar en varias
  // solicitudes, así que mandar una a la papelera no la desautoriza. Se consideran todas sus
  // autorizaciones (la vigencia depende solo de su estado y fechas).
  const conds: any[] = [eq(schema.autorizaciones.personaId, personaId)];
  if (localId) conds.push(eq(schema.autorizaciones.localId, localId));
  const auts = db
    .select()
    .from(schema.autorizaciones)
    .where(and(...conds))
    .orderBy(desc(schema.autorizaciones.fecha), desc(schema.autorizaciones.fechaDecision))
    .all();

  if (auts.length === 0) return { autorizacion: null, estado: 'NO_AUTORIZADO', vigenteHoy: false };

  // Fin efectivo del rango: si no hay fechaHasta, la autorización vale solo el día 'fecha'.
  const finRango = (a: typeof schema.autorizaciones.$inferSelect) => a.fechaHasta ?? a.fecha;

  // Autorización vigente HOY y no revocada.
  const vigente = auts.find((a) => a.estado === 'AUTORIZADA' && a.fecha <= today && finRango(a) >= today);
  if (vigente) return { autorizacion: vigente, estado: 'AUTORIZADO', vigenteHoy: true };

  const ultima = auts[0];
  if (ultima.estado === 'REVOCADA') return { autorizacion: ultima, estado: 'REVOCADO', vigenteHoy: false };
  // Autorizada pero con la fecha de vencimiento ya pasada.
  const autorizada = auts.find((a) => a.estado === 'AUTORIZADA');
  if (autorizada && finRango(autorizada) < today) return { autorizacion: autorizada, estado: 'VENCIDO', vigenteHoy: false };
  // Autorizada para una fecha futura (o sin coincidir con hoy): no habilita el ingreso todavía.
  return { autorizacion: autorizada ?? ultima, estado: autorizada ? 'AUTORIZADO' : 'NO_AUTORIZADO', vigenteHoy: false };
}

/**
 * TODAS las autorizaciones vigentes hoy de una persona, una por local.
 *
 * `getVigencia` devuelve una sola —la primera que encuentra— y eso alcanza para responder "puede
 * entrar o no". No alcanza para registrar el ingreso: una misma persona puede estar autorizada
 * por DOS locales a la vez (el electricista que atiende dos negocios, el repositor de una marca
 * con dos puntos de venta), y ahí hay que saber a cuál entra. Con una sola autorización, el
 * ingreso se le imputaba siempre al mismo local y el otro quedaba sin registro.
 */
export function getVigenciasPorLocal(personaId: number): (typeof schema.autorizaciones.$inferSelect)[] {
  const today = todayLocal();
  const auts = db
    .select()
    .from(schema.autorizaciones)
    .where(and(eq(schema.autorizaciones.personaId, personaId), eq(schema.autorizaciones.estado, 'AUTORIZADA')))
    .orderBy(desc(schema.autorizaciones.fecha), desc(schema.autorizaciones.fechaDecision))
    .all()
    .filter((a) => a.fecha <= today && (a.fechaHasta ?? a.fecha) >= today);
  // Una por local: si el mismo local tiene dos autorizaciones solapadas, vale la más reciente.
  const porLocal = new Map<number, typeof schema.autorizaciones.$inferSelect>();
  for (const a of auts) if (!porLocal.has(a.localId)) porLocal.set(a.localId, a);
  return [...porLocal.values()];
}

/**
 * Recalcula la autorización automática de una persona dentro de una solicitud:
 * - Si TODA la documentación obligatoria está verificada Y la solicitud tiene fecha de
 *   vencimiento cargada → la persona queda AUTORIZADA (vigente hasta esa fecha, todo el día).
 * - Si deja de estar completa (se rechazó/reabrió un documento) y estaba auto-autorizada →
 *   se revierte a EN_REVISION y se revoca la autorización.
 * No toca personas finalizadas manualmente (RECHAZADA).
 */
export function recomputeAutorizacionPersona(solicitudId: number, personaId: number, userId: number): void {
  const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get();
  if (!sol) return;
  const sp = db
    .select()
    .from(schema.solicitudPersonas)
    .where(and(eq(schema.solicitudPersonas.solicitudId, solicitudId), eq(schema.solicitudPersonas.personaId, personaId)))
    .get();
  if (!sp) return;
  if (sp.estado === 'RECHAZADA') return; // decisión manual: no auto-modificar

  const autorizable = personaAutorizableEnSolicitud(solicitudId, personaId).ok;
  // La vigencia es del grupo, pero cada persona puede tener la suya: pasa cuando a uno le vence la
  // documentación antes, o entra por menos días que el resto. La de la persona manda; si no tiene,
  // rige la de la solicitud.
  const venc = sp.fechaVencimiento ?? sol.fechaVencimiento ?? null;
  const activa = db
    .select()
    .from(schema.autorizaciones)
    .where(and(eq(schema.autorizaciones.solicitudId, solicitudId), eq(schema.autorizaciones.personaId, personaId), eq(schema.autorizaciones.estado, 'AUTORIZADA')))
    .orderBy(desc(schema.autorizaciones.fechaDecision))
    .get();

  if (autorizable && venc) {
    // Documentación completa + fecha de vencimiento cargada => AUTORIZADA hasta esa fecha.
    if (!activa) {
      const aut = db
        .insert(schema.autorizaciones)
        .values({
          solicitudId, personaId, localId: sol.localId,
          fecha: todayLocal(), fechaHasta: venc, horaDesde: '00:00', horaHasta: '23:59',
          estado: 'AUTORIZADA', comentario: 'Autorización automática (documentación completa).',
          autorizadaPorUserId: userId,
        })
        .returning()
        .get();
      audit({ userId, accion: 'AUTORIZACION_REALIZADA', entidad: 'autorizacion', entidadId: aut.id, detalle: { solicitudId, personaId, automatica: true } });
    } else if ((activa.fechaHasta ?? null) !== venc) {
      db.update(schema.autorizaciones).set({ fechaHasta: venc }).where(eq(schema.autorizaciones.id, activa.id)).run();
    }
    if (sp.estado !== 'AUTORIZADA') {
      db.update(schema.solicitudPersonas).set({ estado: 'AUTORIZADA', updatedAt: nowIso() }).where(eq(schema.solicitudPersonas.id, sp.id)).run();
    }
  } else {
    // Falta documentación o falta la fecha de vencimiento. Si estaba auto-autorizada, revertir.
    if (sp.estado === 'AUTORIZADA') {
      db.update(schema.solicitudPersonas).set({ estado: 'EN_REVISION', updatedAt: nowIso() }).where(eq(schema.solicitudPersonas.id, sp.id)).run();
      if (activa) {
        db.update(schema.autorizaciones)
          .set({ estado: 'REVOCADA', motivoRevocacion: 'Documentación incompleta o sin fecha de vencimiento.', revocadaPorUserId: userId, fechaRevocacion: nowIso() })
          .where(eq(schema.autorizaciones.id, activa.id))
          .run();
      }
    }
  }
  recomputeSolicitudEstado(solicitudId);
}

/** Recalcula la autorización de una persona en TODAS las solicitudes donde participa. */
export function recomputeAutorizacionesDePersona(personaId: number, userId: number): void {
  const sps = db.select({ solicitudId: schema.solicitudPersonas.solicitudId }).from(schema.solicitudPersonas).where(eq(schema.solicitudPersonas.personaId, personaId)).all();
  for (const sp of sps) recomputeAutorizacionPersona(sp.solicitudId, personaId, userId);
}

/** Recalcula la autorización de TODAS las personas de una solicitud (ej. al cambiar un
 *  documento de alcance SOLICITUD, que las afecta a todas). */
export function recomputeAutorizacionesDeSolicitud(solicitudId: number, userId: number): void {
  const sps = db.select({ personaId: schema.solicitudPersonas.personaId }).from(schema.solicitudPersonas).where(eq(schema.solicitudPersonas.solicitudId, solicitudId)).all();
  for (const sp of sps) recomputeAutorizacionPersona(solicitudId, sp.personaId, userId);
}

export { env };
