import { nanoid } from 'nanoid';
import { eq, and, gt } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { nowIso } from './datetime.js';

export const SESSION_COOKIE = 'sap_session';
const SESSION_HOURS = 12;

export interface SessionUser {
  id: number;
  nombre: string;
  email: string;
  rol: string;
}

export function createSession(userId: number, ip?: string, userAgent?: string): string {
  const token = nanoid(40);
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  db.insert(schema.sessions).values({ token, userId, ip: ip ?? null, userAgent: userAgent ?? null, expiresAt }).run();
  return token;
}

export function getSessionUser(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const row = db
    .select({
      id: schema.users.id,
      nombre: schema.users.nombre,
      email: schema.users.email,
      rol: schema.users.rol,
      activo: schema.users.activo,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(and(eq(schema.sessions.token, token), gt(schema.sessions.expiresAt, nowIso())))
    .get();
  if (!row || !row.activo) return null;
  return { id: row.id, nombre: row.nombre, email: row.email, rol: row.rol };
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  db.delete(schema.sessions).where(eq(schema.sessions.token, token)).run();
}
