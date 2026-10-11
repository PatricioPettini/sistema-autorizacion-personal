import type { FastifyRequest } from 'fastify';
import type { ZodSchema } from 'zod';
import { unauthorized, forbidden } from './errors.js';
import type { SessionUser } from './session.js';

export function parse<T>(schema: ZodSchema<T>, data: unknown): T {
  return schema.parse(data);
}

export function currentUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireRole(req: FastifyRequest, ...roles: string[]): SessionUser {
  const u = currentUser(req);
  if (!roles.includes(u.rol)) throw forbidden();
  return u;
}

export function clientIp(req: FastifyRequest): string {
  return req.ip;
}
