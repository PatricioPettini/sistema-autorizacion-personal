import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { hashPassword } from '../../lib/password.js';
import { createSession, SESSION_COOKIE } from '../../lib/session.js';
import { badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';

function userCount(): number {
  return db.select({ n: sql<number>`count(*)` }).from(schema.users).get()?.n ?? 0;
}

const adminSchema = z.object({
  nombre: z.string().min(2, 'Ingresá un nombre.'),
  email: z.string().email('Email inválido.'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres.'),
});

export async function setupRoutes(app: FastifyInstance) {
  // ¿Necesita configuración inicial? (no hay usuarios todavía)
  app.get('/status', async () => {
    const count = userCount();
    return { needsSetup: count === 0, usuarios: count };
  });

  // Crear el primer administrador (solo si el sistema está vacío).
  app.post('/admin', async (req, reply) => {
    if (userCount() > 0) throw badRequest('El sistema ya fue configurado.');
    const data = adminSchema.parse(req.body);
    const passwordHash = await hashPassword(data.password);
    const user = db
      .insert(schema.users)
      .values({ nombre: data.nombre, email: data.email.toLowerCase(), passwordHash, rol: 'ADMIN', activo: true })
      .returning()
      .get();
    audit({ userId: user.id, accion: 'SETUP_ADMIN_CREADO', entidad: 'user', entidadId: user.id, ip: req.ip });

    const token = createSession(user.id, req.ip, req.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.isProd,
      path: '/',
      maxAge: 12 * 3600,
    });
    return { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol };
  });
}
