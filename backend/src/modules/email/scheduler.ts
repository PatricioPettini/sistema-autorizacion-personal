import { logger } from '../../lib/logger.js';
import { getEmailConfig } from '../config/service.js';
import { pollNow } from './reader.js';

let timer: NodeJS.Timeout | null = null;
let nextRunAt: string | null = null;
let pollMinutes = 0;

/** Espera antes de la primera revisión al arrancar: deja que el server termine de levantar. */
const ESPERA_ARRANQUE_MS = 20_000;
/** Espera después de guardar la configuración: feedback rápido para el usuario. */
const ESPERA_RECONFIG_MS = 5_000;

export function getSchedulerTiming() {
  return { activo: timer !== null, pollMinutes, nextRunAt };
}

function programar(ms: number): void {
  if (timer) clearTimeout(timer);
  nextRunAt = new Date(Date.now() + ms).toISOString();
  timer = setTimeout(tick, ms);
}

/**
 * Una vuelta del lector. Se re-programa a sí mismo al terminar (no setInterval):
 * así una revisión lenta nunca se pisa con la siguiente, y cada vuelta vuelve a
 * leer la frecuencia configurada (puede haber cambiado desde la app).
 */
async function tick(): Promise<void> {
  try {
    const r = await pollNow();
    if (!r.ok) logger.warn(`Revisión automática con error: ${r.error}`);
  } catch (err) {
    logger.error({ err }, 'Error en revisión programada de email.');
  }

  const c = getEmailConfig();
  if (!c.imapHost || c.pollMinutes <= 0) {
    stopScheduler();
    logger.info('Lector automático de email detenido (sin IMAP o frecuencia 0).');
    return;
  }
  pollMinutes = c.pollMinutes;
  programar(c.pollMinutes * 60_000);
}

/**
 * Inicia (o reinicia) el lector automático con la configuración actual.
 * Se llama al arrancar y cada vez que se guarda la configuración de email,
 * para que un cambio de frecuencia aplique sin reiniciar el sistema.
 */
export function startScheduler(opts: { reconfig?: boolean } = {}): void {
  if (timer) clearTimeout(timer);
  timer = null;
  nextRunAt = null;

  const c = getEmailConfig();
  pollMinutes = c.pollMinutes;
  if (!c.imapHost || c.pollMinutes <= 0) {
    logger.info('Lector automático de email desactivado (sin IMAP o frecuencia 0).');
    return;
  }

  const intervalo = c.pollMinutes * 60_000;
  const primera = Math.min(opts.reconfig ? ESPERA_RECONFIG_MS : ESPERA_ARRANQUE_MS, intervalo);
  programar(primera);
  logger.info(`Lector automático de email activo: cada ${c.pollMinutes} min (primera revisión en ${Math.round(primera / 1000)}s).`);
}

export function stopScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  nextRunAt = null;
}
