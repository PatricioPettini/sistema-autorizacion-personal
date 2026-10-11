import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { SESSION_COOKIE, getSessionUser, type SessionUser } from '../lib/session.js';
import { unauthorized, forbidden } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

async function plugin(app: FastifyInstance) {
  app.decorateRequest('user', null);

  // Resuelve el usuario en cada request (si hay cookie de sesión válida).
  app.addHook('onRequest', async (req) => {
    const token = req.cookies?.[SESSION_COOKIE];
    req.user = getSessionUser(token);
  });

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
  });

  app.decorate('requireAdmin', async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
    if (req.user.rol !== 'ADMIN') throw forbidden('Requiere rol Administrador.');
  });
}

export default fp(plugin);
