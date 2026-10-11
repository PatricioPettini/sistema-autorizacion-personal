import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { hashPassword } from '../../lib/password.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { nowIso } from '../../lib/datetime.js';

const createSchema = z.object({
  nombre: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres.'),
  rol: z.enum(['ADMIN', 'SEGURIDAD']),
});

const updateSchema = z.object({
  nombre: z.string().min(2).optional(),
  rol: z.enum(['ADMIN', 'SEGURIDAD']).optional(),
  activo: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

export async function usersRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAdmin);

  app.get('/', async () => {
    const rows = db
      .select({
        id: schema.users.id,
        nombre: schema.users.nombre,
        email: schema.users.email,
        rol: schema.users.rol,
        activo: schema.users.activo,
        lastLoginAt: schema.users.lastLoginAt,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .all();
    return rows;
  });

  app.post('/', async (req) => {
    const data = createSchema.parse(req.body);
    const passwordHash = await hashPassword(data.password);
    const user = db
      .insert(schema.users)
      .values({ nombre: data.nombre, email: data.email.toLowerCase(), passwordHash, rol: data.rol, activo: true })
      .returning()
      .get();
    audit({ userId: req.user!.id, accion: 'USUARIO_CREADO', entidad: 'user', entidadId: user.id, detalle: { rol: user.rol }, ip: req.ip });
    return { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol, activo: user.activo };
  });

  app.patch('/:id', async (req) => {
    const id = Number((req.params as any).id);
    const data = updateSchema.parse(req.body);
    const existing = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
    if (!existing) throw notFound('Usuario no encontrado.');

    // No permitir que un admin se auto-desactive o se quite el rol y quede el sistema sin admin.
    if (existing.id === req.user!.id && (data.activo === false || data.rol === 'SEGURIDAD')) {
      throw badRequest('No podés quitarte a vos mismo el acceso de administrador.');
    }

    const patch: Record<string, unknown> = { updatedAt: nowIso() };
    if (data.nombre !== undefined) patch.nombre = data.nombre;
    if (data.rol !== undefined) patch.rol = data.rol;
    if (data.activo !== undefined) patch.activo = data.activo;
    if (data.password !== undefined) patch.passwordHash = await hashPassword(data.password);

    db.update(schema.users).set(patch).where(eq(schema.users.id, id)).run();
    audit({ userId: req.user!.id, accion: 'USUARIO_MODIFICADO', entidad: 'user', entidadId: id, detalle: { campos: Object.keys(data) }, ip: req.ip });
    return { ok: true };
  });
}
