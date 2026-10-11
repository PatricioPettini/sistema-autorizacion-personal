import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { nowIso, todayLocal } from '../../lib/datetime.js';
import { notifyAutorizacion } from '../notifications/service.js';
import { getPersonaDocStatus } from '../documentos/service.js';
import { recomputeSolicitudEstado } from '../solicitudes/service.js';

const autorizarSchema = z.object({
  solicitudId: z.number().int(),
  personaId: z.number().int(),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD).').default(todayLocal()),
  // Fin del rango (opcional). Si no viene, la autorización vale solo el día 'fecha'.
  fechaHasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD).').optional(),
  horaDesde: z.string().regex(/^\d{2}:\d{2}$/, 'Hora inválida (HH:mm).'),
  horaHasta: z.string().regex(/^\d{2}:\d{2}$/, 'Hora inválida (HH:mm).'),
  comentario: z.string().optional(),
});

export async function autorizacionesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAuth);
  const soloAdmin = { onRequest: app.requireAdmin };

  // Autorizar a UNA persona de una solicitud (decisión humana).
  app.post('/', soloAdmin, async (req) => {
    const data = autorizarSchema.parse(req.body);
    if (data.horaHasta <= data.horaDesde) throw badRequest('La hora de fin debe ser posterior a la de inicio.');
    const fechaHasta = data.fechaHasta ?? data.fecha;
    if (fechaHasta < data.fecha) throw badRequest('La fecha de fin no puede ser anterior a la de inicio.');
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, data.solicitudId)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');
    const sp = db
      .select()
      .from(schema.solicitudPersonas)
      .where(and(eq(schema.solicitudPersonas.solicitudId, data.solicitudId), eq(schema.solicitudPersonas.personaId, data.personaId)))
      .get();
    if (!sp) throw notFound('La persona no pertenece a esta solicitud.');

    // Regla: solo se puede autorizar cuando TODA la documentación obligatoria está verificada (aprobada).
    const docStatus = getPersonaDocStatus(data.personaId);
    if (!docStatus.todosVerificados) {
      throw badRequest('No se puede autorizar: falta verificar toda la documentación obligatoria de esta persona.');
    }

    const aut = db
      .insert(schema.autorizaciones)
      .values({
        solicitudId: sol.id,
        personaId: data.personaId,
        localId: sol.localId,
        fecha: data.fecha,
        fechaHasta,
        horaDesde: data.horaDesde,
        horaHasta: data.horaHasta,
        estado: 'AUTORIZADA',
        comentario: data.comentario || null,
        autorizadaPorUserId: req.user!.id,
      })
      .returning()
      .get();
    db.update(schema.solicitudPersonas).set({ estado: 'AUTORIZADA', updatedAt: nowIso() }).where(eq(schema.solicitudPersonas.id, sp.id)).run();
    recomputeSolicitudEstado(sol.id);
    audit({ userId: req.user!.id, accion: 'AUTORIZACION_REALIZADA', entidad: 'autorizacion', entidadId: aut.id, detalle: { solicitudId: sol.id, personaId: data.personaId }, ip: req.ip });
    notifyAutorizacion(aut.id).catch(() => {});
    return aut;
  });

  // Revocar una autorización (motivo obligatorio).
  app.post('/:id/revocar', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const motivo = String((req.body as any)?.motivo ?? '').trim();
    if (!motivo) throw badRequest('El motivo de la revocación es obligatorio.');
    const aut = db.select().from(schema.autorizaciones).where(eq(schema.autorizaciones.id, id)).get();
    if (!aut) throw notFound('Autorización no encontrada.');
    if (aut.estado === 'REVOCADA') throw badRequest('La autorización ya estaba revocada.');

    db.update(schema.autorizaciones)
      .set({ estado: 'REVOCADA', motivoRevocacion: motivo, revocadaPorUserId: req.user!.id, fechaRevocacion: nowIso() })
      .where(eq(schema.autorizaciones.id, id))
      .run();
    if (aut.solicitudId) {
      const sp = db
        .select()
        .from(schema.solicitudPersonas)
        .where(and(eq(schema.solicitudPersonas.solicitudId, aut.solicitudId), eq(schema.solicitudPersonas.personaId, aut.personaId)))
        .get();
      if (sp) db.update(schema.solicitudPersonas).set({ estado: 'REVOCADA', motivoRechazo: motivo, updatedAt: nowIso() }).where(eq(schema.solicitudPersonas.id, sp.id)).run();
      db.insert(schema.comentarios).values({ solicitudId: aut.solicitudId, userId: req.user!.id, contenido: `REVOCACIÓN: ${motivo}` }).run();
      recomputeSolicitudEstado(aut.solicitudId);
    }
    audit({ userId: req.user!.id, accion: 'AUTORIZACION_REVOCADA', entidad: 'autorizacion', entidadId: id, detalle: { motivo }, ip: req.ip });
    return { ok: true };
  });
}
