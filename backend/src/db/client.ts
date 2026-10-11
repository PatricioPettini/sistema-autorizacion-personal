import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env, ensureStorageDirs } from '../config/env.js';
import * as schema from './schema.js';

ensureStorageDirs();

const sqlite = new Database(env.dbPath);
// Rendimiento y robustez para uso local de una sola PC.
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

export const rawDb = sqlite;
export const db = drizzle(sqlite, { schema });
export { schema };

/** Ejecuta el esquema (idempotente: CREATE TABLE IF NOT EXISTS). */
export function runSchema(): void {
  const schemaFile = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'schema.sql');
  // Resolución robusta en Windows/Unix:
  const candidates = [
    path.join(env.projectRoot, 'backend', 'src', 'db', 'schema.sql'),
    path.join(env.projectRoot, 'backend', 'dist', 'db', 'schema.sql'),
    schemaFile,
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error('No se encontró schema.sql');
  const ddl = fs.readFileSync(found, 'utf8');
  sqlite.exec(ddl);
}
