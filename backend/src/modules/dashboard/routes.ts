import type { FastifyInstance } from 'fastify';
import { sql, eq, desc, isNull } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { agruparPorEmail } from '../solicitudes/service.js';

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAuth);

  app.get('/', async () => {
    // Documentos aprobados que ya vencieron o están por vencer (dentro de 15 días).
    const vencimientos = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.documentos)
      .where(sql`verificacion = 'VERIFICADO' AND fecha_vencimiento IS NOT NULL AND date(fecha_vencimiento) <= date('now','+15 day')`)
      .get();

    // Solicitudes agrupadas POR EMAIL (igual que la lista). Los contadores cuentan GRUPOS, no filas.
    const solRows = db
      .select({
        id: schema.solicitudes.id,
        estado: schema.solicitudes.estado,
        updatedAt: schema.solicitudes.updatedAt,
        localId: schema.locales.id,
        local: schema.locales.nombre,
        emailMessageId: schema.solicitudes.emailMessageId,
        personasCount: sql<number>`count(${schema.solicitudPersonas.id})`,
        personasLabel: sql<string>`group_concat(${schema.personas.apellido} || ', ' || ${schema.personas.nombre}, ' · ')`,
        categorias: sql<string>`group_concat(distinct ${schema.personas.categoria})`,
      })
      .from(schema.solicitudes)
      .innerJoin(schema.locales, eq(schema.solicitudes.localId, schema.locales.id))
      .leftJoin(schema.solicitudPersonas, eq(schema.solicitudPersonas.solicitudId, schema.solicitudes.id))
      .leftJoin(schema.personas, eq(schema.personas.id, schema.solicitudPersonas.personaId))
      // Excluir las que están en la papelera (borrado lógico), igual que la lista de Solicitudes.
      .where(isNull(schema.solicitudes.deletedAt))
      .groupBy(schema.solicitudes.id)
      .orderBy(desc(schema.solicitudes.updatedAt))
      .all();
    const grupos = agruparPorEmail(solRows as any);
    const contador = (e: string) => grupos.filter((g) => g.estado === e).length;
    const recientes = grupos.slice(0, 10).map(({ cuils, ...x }) => x);

    const dentro = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.entradas)
      .where(isNull(schema.entradas.fechaHoraSalida))
      .get();

    return {
      contadores: {
        pendientes: contador('PENDIENTE'),
        enRevision: contador('EN_REVISION'),
        autorizados: contador('AUTORIZADA'),
        observados: contador('OBSERVADA'),
        rechazados: contador('RECHAZADA'),
        vencidos: contador('VENCIDA'),
        revocados: contador('REVOCADA'),
        vencimientos: vencimientos?.n ?? 0,
        dentro: dentro?.n ?? 0,
      },
      recientes,
    };
  });
}
