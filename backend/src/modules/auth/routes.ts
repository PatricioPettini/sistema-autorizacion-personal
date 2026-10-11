import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { verifyPassword } from '../../lib/password.js';
import { createSession, destroySession, SESSION_COOKIE } from '../../lib/session.js';
import { unauthorized, tooManyRequests } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { nowIso } from '../../lib/datetime.js';
import { env } from '../../config/env.js';
import { tooManyAttempts, clearAttempts } from '../../lib/rate-limit.js';
import { visionDisponible } from '../ai/vision.js';

const loginSchema = z.object({
  email: z.string().email('Email inválido.'),
  password: z.string().min(1, 'Ingresá la contraseña.'),
});

// Antifuerza-bruta: máx. 10 intentos de login por IP cada 15 minutos.
const LOGIN_MAX = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export async function authRoutes(app: FastifyInstance) {
  app.post('/login', async (req, reply) => {
    const ipKey = `login:${req.ip}`;
    if (tooManyAttempts(ipKey, LOGIN_MAX, LOGIN_WINDOW_MS)) {
      audit({ accion: 'LOGIN_BLOQUEADO', entidad: 'user', detalle: { ip: req.ip }, ip: req.ip });
      throw tooManyRequests('Demasiados intentos de inicio de sesión. Esperá unos minutos e intentá de nuevo.');
    }
    const { email, password } = loginSchema.parse(req.body);
    const user = db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase())).get();
    if (!user || !user.activo || !(await verifyPassword(password, user.passwordHash))) {
      throw unauthorized('Email o contraseña incorrectos.');
    }
    clearAttempts(ipKey); // login correcto: se limpia el contador de esa IP
    const token = createSession(user.id, req.ip, req.headers['user-agent']);
    db.update(schema.users).set({ lastLoginAt: nowIso() }).where(eq(schema.users.id, user.id)).run();
    audit({ userId: user.id, accion: 'LOGIN', entidad: 'user', entidadId: user.id, ip: req.ip });

    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.isProd,
      path: '/',
      maxAge: 12 * 3600,
    });
    return { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol };
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (req.user) audit({ userId: req.user.id, accion: 'LOGOUT', entidad: 'user', entidadId: req.user.id, ip: req.ip });
    destroySession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (req) => {
    if (!req.user) return { user: null };
    // `capturaIA` le dice al front si mostrar la lectura de capturas: depende de que el servidor
    // tenga API key, no del usuario. Sin key, el botón no existe en vez de fallar al apretarlo.
    return { user: req.user, capturaIA: visionDisponible() };
  });
}
