import type { FastifyInstance } from 'fastify';
import { sql, desc } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { getEmailConfigVisible } from './service.js';
import { pollNow, getSchedulerStatus } from '../email/reader.js';
import { getSchedulerTiming } from '../email/scheduler.js';
import { audit } from '../../lib/audit.js';

export async function configRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAdmin);

  // La configuración del correo ya no se edita desde el panel: vive en las variables MAIL_* del
  // entorno. Acá solo se muestra qué casilla está en uso (sin la contraseña) y se puede forzar
  // una revisión del buzón.
  app.get('/email', async () => getEmailConfigVisible());

  // Forzar una revisión del buzón ahora.
  app.post('/email/revisar-ahora', async (req) => {
    audit({ userId: req.user!.id, accion: 'EMAIL_REVISION_MANUAL', ip: req.ip });
    return pollNow();
  });

  // Monitoreo: estado del procesamiento de emails.
  app.get('/monitor', async () => {
    const porEstado = db
      .select({ estado: schema.emailMessages.estado, n: sql<number>`count(*)` })
      .from(schema.emailMessages)
      .groupBy(schema.emailMessages.estado)
      .all();
    const ultimo = db.select().from(schema.emailMessages).orderBy(desc(schema.emailMessages.fechaRecibido)).limit(5).all();
    const jobsError = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.processingJobs)
      .where(sql`estado = 'ERROR'`)
      .get();
    return { scheduler: { ...getSchedulerStatus(), ...getSchedulerTiming() }, emailsPorEstado: porEstado, ultimosEmails: ultimo, jobsConError: jobsError?.n ?? 0 };
  });
}
