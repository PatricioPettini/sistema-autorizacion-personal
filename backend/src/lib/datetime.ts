import { env } from '../config/env.js';

/** Ahora en ISO-8601 UTC (para guardar en la base). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Fecha de hoy en zona horaria configurada, formato YYYY-MM-DD. */
export function todayLocal(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: env.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Convierte un ISO/fecha a texto local argentino DD/MM/YYYY HH:mm. */
export function formatLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: env.tz,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/** Días hasta una fecha YYYY-MM-DD (negativo = ya vencida). null si inválida. */
export function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const target = new Date(`${dateStr}T00:00:00`);
  if (isNaN(target.getTime())) return null;
  const today = new Date(`${todayLocal()}T00:00:00`);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/**
 * Desfase de la zona del sistema respecto de UTC, en milisegundos, para un instante dado.
 * Se calcula con `Intl` en vez de una constante -3 h para no atarse a que Argentina no use
 * horario de verano: si algún día vuelve, esto sigue dando bien.
 */
function desfaseZona(instante: Date): number {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instante).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const comoSiFueraUtc = Date.UTC(
    Number(partes.year), Number(partes.month) - 1, Number(partes.day),
    Number(partes.hour), Number(partes.minute), Number(partes.second),
  );
  return comoSiFueraUtc - instante.getTime();
}

/**
 * Convierte fecha y hora LOCALES ("2026-09-04", "14:30") al instante UTC que se guarda en la base.
 *
 * Hace falta porque las marcas de tiempo se guardan en UTC y los filtros de los reportes venían
 * pegando la fecha con "T00:00:00Z", que en Argentina (UTC-3) corre todo tres horas: un ingreso de
 * las 22:00 del día 3 se guarda como 01:00Z del día 4 y aparecía en el reporte del día siguiente.
 *
 * `hora` admite "HH:MM" o "HH:MM:SS". Devuelve null si la fecha no es válida.
 */
export function localAUtcIso(fecha: string, hora = '00:00'): string | null {
  const f = /^\d{4}-\d{2}-\d{2}$/.exec(fecha.trim());
  const h = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(hora.trim());
  if (!f || !h) return null;
  const hh = Number(h[1]), mm = Number(h[2]), ss = Number(h[3] ?? '0');
  if (hh > 23 || mm > 59 || ss > 59) return null;
  const comoUtc = Date.parse(`${fecha}T${String(hh).padStart(2, '0')}:${h[2]}:${String(ss).padStart(2, '0')}.000Z`);
  if (isNaN(comoUtc)) return null;
  // Dos pasadas: la primera estima el desfase, la segunda lo corrige si el instante estimado cayó
  // del otro lado de un cambio de hora.
  let t = comoUtc - desfaseZona(new Date(comoUtc));
  t = comoUtc - desfaseZona(new Date(t));
  return new Date(t).toISOString();
}

/** Hora local actual en formato HH:MM. */
export function horaLocal(): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: env.tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date());
}
