import { eq } from 'drizzle-orm';
import { db, rawDb, schema } from '../../db/client.js';
import { nowIso, todayLocal } from '../../lib/datetime.js';

/** Estado "resumen" a partir de varios estados (de personas o de solicitudes de un grupo). */
export function aggEstado(estadosRaw: string[]): string {
  // Las personas "reemplazadas" (por un reenvío posterior) no cuentan para el estado activo.
  const estados = estadosRaw.filter((e) => e !== 'REEMPLAZADA');
  if (estados.length === 0) return estadosRaw.length ? 'REEMPLAZADA' : 'PENDIENTE';
  const todas = (e: string) => estados.every((x) => x === e);
  const alguna = (e: string) => estados.some((x) => x === e);
  if (todas('AUTORIZADA')) return 'AUTORIZADA';
  if (todas('RECHAZADA')) return 'RECHAZADA';
  if (todas('REVOCADA')) return 'REVOCADA';
  if (alguna('OBSERVADA')) return 'OBSERVADA';
  // Alguna autorizada (pero no todas) o ya en revisión => en revisión.
  if (alguna('AUTORIZADA') || alguna('EN_REVISION')) return 'EN_REVISION';
  return 'PENDIENTE';
}

/** Agrupa filas de solicitudes por email (o por solicitud si es manual). Devuelve grupos ordenados por updatedAt desc. */
export interface SolicitudRow {
  id: number; estado: string; updatedAt: string; localId: number; local: string;
  emailMessageId: number | null; emailAsunto?: string | null; fecha?: string | null;
  personasCount: number | null; personasLabel: string | null; cuils?: string | null;
  categorias?: string | null; nroOrden?: string | null; docNuevaAt?: string | null;
}
export interface SolicitudGroup {
  id: number; localId: number; local: string; emailAsunto: string | null;
  personasCount: number; personasLabel: string; cuils: string; estado: string; updatedAt: string;
  fecha: string | null; // fecha de envío (del email) o de creación
  tipo: string | null; // EMPRESA | MONOTRIBUTISTA | MIXTO | null
  nroOrden: string | null; // se asigna al terminar la revisión
  docNuevaAt?: string | null; // llegó documentación después de informarle el resultado al local
}

/** Resuelve el tipo de un grupo a partir de las categorías de sus personas. */
function tipoDeGrupo(cats: Set<string>): string | null {
  if (cats.size === 0) return null;
  if (cats.size === 1) return [...cats][0];
  return 'MIXTO';
}

export function agruparPorEmail(rows: SolicitudRow[]): SolicitudGroup[] {
  const groups = new Map<string, any>();
  for (const r of rows) {
    const key = r.emailMessageId != null ? `e${r.emailMessageId}` : `s${r.id}`;
    let g = groups.get(key);
    if (!g) { g = { id: r.id, localId: r.localId, local: r.local, emailAsunto: r.emailAsunto ?? null, fecha: r.fecha ?? null, updatedAt: r.updatedAt, personasCount: 0, labels: [] as string[], cuils: [] as string[], estados: [] as string[], cats: new Set<string>(), nroOrden: null as string | null, docNuevaAt: null as string | null }; groups.set(key, g); }
    g.id = Math.min(g.id, r.id);
    if (g.local === '(Sin asignar)' && r.local !== '(Sin asignar)') { g.local = r.local; g.localId = r.localId; }
    g.personasCount += r.personasCount ?? 0;
    if (r.personasLabel) g.labels.push(r.personasLabel);
    if (r.cuils) g.cuils.push(r.cuils);
    if (r.categorias) for (const c of r.categorias.split(',')) if (c) g.cats.add(c);
    g.estados.push(r.estado);
    if (r.nroOrden && !g.nroOrden) g.nroOrden = r.nroOrden;
    if (r.docNuevaAt && !g.docNuevaAt) g.docNuevaAt = r.docNuevaAt;
    if (r.updatedAt > g.updatedAt) g.updatedAt = r.updatedAt;
  }
  return [...groups.values()]
    .map((g) => ({ id: g.id, localId: g.localId, local: g.local, emailAsunto: g.emailAsunto, personasCount: g.personasCount, personasLabel: g.labels.join(' · '), cuils: g.cuils.join(','), estado: aggEstado(g.estados), updatedAt: g.updatedAt, fecha: g.fecha, tipo: tipoDeGrupo(g.cats), nroOrden: g.nroOrden, docNuevaAt: g.docNuevaAt }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/**
 * Recalcula el estado "resumen" de una solicitud a partir del estado de cada
 * una de sus personas. Sirve para el listado y los filtros del panel.
 */
export function recomputeSolicitudEstado(solicitudId: number): string {
  const filas = db
    .select({ estado: schema.solicitudPersonas.estado })
    .from(schema.solicitudPersonas)
    .where(eq(schema.solicitudPersonas.solicitudId, solicitudId))
    .all();

  let estado = 'PENDIENTE';
  if (filas.length > 0) {
    const estados = filas.map((f) => f.estado);
    const todas = (e: string) => estados.every((x) => x === e);
    const alguna = (e: string) => estados.some((x) => x === e);
    if (todas('AUTORIZADA')) estado = 'AUTORIZADA';
    else if (todas('RECHAZADA')) estado = 'RECHAZADA';
    else if (todas('REVOCADA')) estado = 'REVOCADA';
    else if (alguna('OBSERVADA')) estado = 'OBSERVADA';
    else if (alguna('AUTORIZADA')) estado = 'EN_REVISION';
    else estado = 'PENDIENTE';
  }

  db.update(schema.solicitudes).set({ estado, updatedAt: nowIso() }).where(eq(schema.solicitudes.id, solicitudId)).run();
  return estado;
}

// ---------------------------------------------------------------------------
// Número de orden
// ---------------------------------------------------------------------------

/** Prefijo del número de orden ("Orden de Autorización"). Cambiar acá si se usa otra sigla. */
const PREFIJO_ORDEN = 'OA';

/** Solicitudes del mismo email (el grupo que se revisa y se responde junto). */
export function grupoDeSolicitud(solicitudId: number) {
  const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get();
  if (!sol) return [];
  return sol.emailMessageId != null
    ? db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, sol.emailMessageId)).all()
    : [sol];
}

/** Número de orden ya asignado al grupo, o null si todavía no se generó. */
export function getNroOrden(solicitudId: number): string | null {
  return grupoDeSolicitud(solicitudId).find((s) => s.nroOrden)?.nroOrden ?? null;
}

/**
 * Asigna el número de orden del grupo y lo devuelve. Formato `OA-AAAA-NNNN`,
 * con secuencia propia por año.
 *
 * Es idempotente: si el grupo ya tiene número (por ejemplo, porque se reenvía el
 * email de resultado), devuelve el mismo en vez de generar otro. Todas las
 * solicitudes del mismo email comparten el número, porque el remitente recibe
 * una sola respuesta por su correo.
 */
export function asignarNroOrden(solicitudId: number): string | null {
  const grupo = grupoDeSolicitud(solicitudId);
  if (grupo.length === 0) return null;
  const ya = grupo.find((s) => s.nroOrden)?.nroOrden;
  if (ya) return ya;

  const anio = todayLocal().slice(0, 4);
  const ids = grupo.map((s) => s.id);

  // En una transacción: se busca el último del año y se guarda el siguiente, así dos
  // revisiones terminadas a la vez no pueden quedarse con el mismo número.
  const asignar = rawDb.transaction(() => {
    const ultimo = rawDb
      .prepare(`SELECT nro_orden FROM solicitudes WHERE nro_orden LIKE ? ORDER BY nro_orden DESC LIMIT 1`)
      .get(`${PREFIJO_ORDEN}-${anio}-%`) as { nro_orden: string } | undefined;
    const secuencia = ultimo ? Number(ultimo.nro_orden.split('-').pop()) + 1 : 1;
    const nro = `${PREFIJO_ORDEN}-${anio}-${String(secuencia).padStart(4, '0')}`;
    const upd = rawDb.prepare(`UPDATE solicitudes SET nro_orden = ?, updated_at = ? WHERE id = ?`);
    for (const id of ids) upd.run(nro, nowIso(), id);
    return nro;
  });

  return asignar();
}
