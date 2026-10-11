import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { LOCAL_SIN_ASIGNAR } from '../../db/migrate.js';

/** Normaliza para comparar nombres de local: sin mayúsculas, sin acentos, sin espacios de más. */
export function normalizarNombreLocal(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function localesReales() {
  return db.select().from(schema.locales).all().filter((l) => l.nombre && l.nombre !== LOCAL_SIN_ASIGNAR);
}

/**
 * Busca un local por nombre.
 *  - exacto (default): ignora mayúsculas, acentos y espacios de más.
 *  - aproximado: además acepta que uno contenga al otro (para el asunto de un email,
 *    donde el nombre puede venir con texto alrededor). Gana el nombre más largo.
 */
export function buscarLocal(nombre: string, opts: { aproximado?: boolean } = {}) {
  const t = normalizarNombreLocal(nombre);
  if (!t) return null;
  const locales = localesReales();
  const exacto = locales.find((l) => normalizarNombreLocal(l.nombre) === t);
  if (exacto || !opts.aproximado) return exacto ?? null;
  return (
    locales
      .filter((l) => t.includes(normalizarNombreLocal(l.nombre)) || normalizarNombreLocal(l.nombre).includes(t))
      .sort((a, b) => b.nombre.length - a.nombre.length)[0] ?? null
  );
}

export interface FindOrCreateLocalOpts {
  /** De dónde salió el nombre: queda en la auditoría y en las observaciones del local. */
  origen: 'email' | 'manual';
  aproximado?: boolean;
  userId?: number;
  ip?: string;
}

/** Busca el local por nombre y, si no existe, lo crea. Devuelve el local y si es nuevo. */
export function findOrCreateLocal(
  nombre: string,
  opts: FindOrCreateLocalOpts,
): { local: typeof schema.locales.$inferSelect; created: boolean } | null {
  const limpio = (nombre || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!limpio) return null;

  const existente = buscarLocal(limpio, { aproximado: opts.aproximado });
  if (existente) return { local: existente, created: false };

  const observaciones =
    opts.origen === 'email'
      ? 'Creado automáticamente desde el asunto de un email.'
      : 'Creado al cargar una solicitud a mano.';
  try {
    const creado = db.insert(schema.locales).values({ nombre: limpio, estado: 'ACTIVO', observaciones }).returning().get();
    audit({ userId: opts.userId, accion: 'LOCAL_CREADO', entidad: 'local', entidadId: creado.id, detalle: { nombre: limpio, origen: opts.origen }, ip: opts.ip });
    return { local: creado, created: true };
  } catch {
    // Otro proceso lo creó en paralelo (UNIQUE nombre): reusar el existente.
    const ya = db.select().from(schema.locales).where(eq(schema.locales.nombre, limpio)).get();
    return ya ? { local: ya, created: false } : null;
  }
}
