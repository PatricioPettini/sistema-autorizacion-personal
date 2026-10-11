import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { notFound, badRequest, conflict } from '../../lib/errors.js';
import { nowIso } from '../../lib/datetime.js';

const LOCAL_SIN_ASIGNAR = '(Sin asignar)';

/** Cantidad total de usos de un local (solicitudes —incl. papelera—, emails, autorizaciones, ingresos). */
function usosDeLocal(localId: number): number {
  const n = (t: any, col: any) => db.select({ n: sql<number>`count(*)` }).from(t).where(eq(col, localId)).get()?.n ?? 0;
  return n(schema.solicitudes, schema.solicitudes.localId)
    + n(schema.emailMessages, schema.emailMessages.localId)
    + n(schema.autorizaciones, schema.autorizaciones.localId)
    + n(schema.entradas, schema.entradas.localId);
}

const localeSchema = z.object({
  nombre: z.string().min(1, 'Ingresá el nombre del local.'),
  email: z.string().email('Email inválido.').optional().or(z.literal('')),
  estado: z.enum(['ACTIVO', 'INACTIVO']).default('ACTIVO'),
  observaciones: z.string().optional(),
});

export async function localesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAuth);

  app.get('/', async () => {
    const rows = db.select().from(schema.locales).orderBy(desc(schema.locales.estado), schema.locales.nombre).all();
    // `usos` = referencias del local; `eliminable` = sin usos y no es el placeholder.
    return rows.map((l) => {
      const usos = usosDeLocal(l.id);
      return { ...l, usos, eliminable: usos === 0 && l.nombre !== LOCAL_SIN_ASIGNAR };
    });
  });

  app.get('/:id', async (req) => {
    const id = Number((req.params as any).id);
    const row = db.select().from(schema.locales).where(eq(schema.locales.id, id)).get();
    if (!row) throw notFound('Local no encontrado.');
    return row;
  });

  app.post('/', async (req) => {
    await app.requireAdmin(req, undefined as any);
    const data = localeSchema.parse(req.body);
    const row = db
      .insert(schema.locales)
      .values({ nombre: data.nombre, email: data.email || null, estado: data.estado, observaciones: data.observaciones || null })
      .returning()
      .get();
    audit({ userId: req.user!.id, accion: 'LOCAL_CREADO', entidad: 'local', entidadId: row.id, detalle: { nombre: row.nombre }, ip: req.ip });
    return row;
  });

  app.patch('/:id', async (req) => {
    await app.requireAdmin(req, undefined as any);
    const id = Number((req.params as any).id);
    const data = localeSchema.partial().parse(req.body);
    const existing = db.select().from(schema.locales).where(eq(schema.locales.id, id)).get();
    if (!existing) throw notFound('Local no encontrado.');
    db.update(schema.locales)
      .set({
        nombre: data.nombre ?? existing.nombre,
        email: data.email !== undefined ? data.email || null : existing.email,
        estado: data.estado ?? existing.estado,
        observaciones: data.observaciones !== undefined ? data.observaciones || null : existing.observaciones,
        updatedAt: nowIso(),
      })
      .where(eq(schema.locales.id, id))
      .run();
    audit({ userId: req.user!.id, accion: 'LOCAL_MODIFICADO', entidad: 'local', entidadId: id, ip: req.ip });
    return { ok: true };
  });

  // Borrar un local. Solo si NO tiene ningún uso (ni solicitudes —incluida la papelera—,
  // ni emails, ni autorizaciones, ni ingresos). Nunca borra el placeholder "(Sin asignar)".
  app.delete('/:id', async (req) => {
    await app.requireAdmin(req, undefined as any);
    const id = Number((req.params as any).id);
    const local = db.select().from(schema.locales).where(eq(schema.locales.id, id)).get();
    if (!local) throw notFound('Local no encontrado.');
    if (local.nombre === LOCAL_SIN_ASIGNAR) throw badRequest('No se puede borrar el local "(Sin asignar)".');
    const usos = usosDeLocal(id);
    if (usos > 0) throw conflict(`No se puede borrar "${local.nombre}": tiene ${usos} uso(s) (solicitudes, emails o ingresos). Reasignalos o dejalo inactivo.`);
    db.delete(schema.locales).where(eq(schema.locales.id, id)).run();
    audit({ userId: req.user!.id, accion: 'LOCAL_BORRADO', entidad: 'local', entidadId: id, detalle: { nombre: local.nombre }, ip: req.ip });
    return { ok: true };
  });

  // Borrar TODOS los locales vacíos de una (limpieza de duplicados). Devuelve cuántos borró.
  app.post('/limpiar-vacios', async (req) => {
    await app.requireAdmin(req, undefined as any);
    const todos = db.select().from(schema.locales).all();
    const borrados: string[] = [];
    for (const l of todos) {
      if (l.nombre === LOCAL_SIN_ASIGNAR) continue;
      if (usosDeLocal(l.id) === 0) {
        db.delete(schema.locales).where(eq(schema.locales.id, l.id)).run();
        borrados.push(l.nombre);
      }
    }
    if (borrados.length) audit({ userId: req.user!.id, accion: 'LOCALES_VACIOS_LIMPIADOS', entidad: 'local', detalle: { borrados }, ip: req.ip });
    return { ok: true, borrados };
  });
}
