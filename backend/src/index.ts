import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { migrate } from './db/migrate.js';
import { buildServer } from './server.js';
import { startScheduler } from './modules/email/scheduler.js';

async function main() {
  // 1) Asegurar esquema y datos base.
  migrate();

  // 2) Levantar el servidor HTTP.
  const app = await buildServer();
  await app.listen({ port: env.port, host: env.host });
  logger.info(`Sistema disponible en http://${env.host}:${env.port}`);

  // 3) Iniciar el lector automático de emails (si está configurado).
  startScheduler();

  const shutdown = async () => {
    logger.info('Cerrando...');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'Fallo al iniciar el sistema');
  process.exit(1);
});
