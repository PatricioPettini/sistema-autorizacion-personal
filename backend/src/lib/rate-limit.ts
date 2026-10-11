// Rate limiter simple en memoria (una sola instancia). Suficiente para proteger el login
// de fuerza bruta sin agregar dependencias ni infraestructura.

interface Entry { count: number; resetAt: number }
const buckets = new Map<string, Entry>();

// Limpieza perezosa para que el Map no crezca indefinidamente.
let lastSweep = 0;
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, e] of buckets) if (e.resetAt < now) buckets.delete(k);
}

/** Registra un intento para `key`. Devuelve true si SUPERÓ el máximo dentro de la ventana. */
export function tooManyAttempts(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  sweep(now);
  const e = buckets.get(key);
  if (!e || e.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  e.count++;
  return e.count > max;
}

/** Limpia el contador (ej. al loguear con éxito). */
export function clearAttempts(key: string): void {
  buckets.delete(key);
}
