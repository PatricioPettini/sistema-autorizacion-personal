import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { nowIso } from '../../lib/datetime.js';

const schemaIn = z.object({
  codigo: z.string().min(2).regex(/^[A-Z0-9_]+$/, 'Código: solo mayúsculas, números y guión bajo.'),
  nombre: z.string().min(2),
  obligatorio: z.boolean().default(true),
  tieneVencimiento: z.boolean().default(false),
  orden: z.number().int().default(0),
  activo: z.boolean().default(true),
});

export async function documentTypesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAuth);

  app.get('/', async () => db.select().from(schema.documentTypes).orderBy(schema.documentTypes.orden).all());

  app.post('/', async (req) => {
    await app.requireAdmin(req, undefined as any);
    const data = schemaIn.parse(req.body);
    const row = db.insert(schema.documentTypes).values(data).returning().get();
    audit({ userId: req.user!.id, accion: 'TIPO_DOC_CREADO', entidad: 'document_type', entidadId: row.id, detalle: { codigo: row.codigo }, ip: req.ip });
    return row;
  });

  app.patch('/:id', async (req) => {
    await app.requireAdmin(req, undefined as any);
    const id = Number((req.params as any).id);
    const data = schemaIn.partial().parse(req.body);
    const existing = db.select().from(schema.documentTypes).where(eq(schema.documentTypes.id, id)).get();
    if (!existing) throw notFound('Tipo de documento no encontrado.');
    db.update(schema.documentTypes).set({ ...data, updatedAt: nowIso() }).where(eq(schema.documentTypes.id, id)).run();
    audit({ userId: req.user!.id, accion: 'TIPO_DOC_MODIFICADO', entidad: 'document_type', entidadId: id, ip: req.ip });
    return { ok: true };
  });
}
