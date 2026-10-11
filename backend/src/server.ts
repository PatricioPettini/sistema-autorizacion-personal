import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { AppError } from './lib/errors.js';
import authPlugin from './plugins/auth.js';

import { authRoutes } from './modules/auth/routes.js';
import { usersRoutes } from './modules/users/routes.js';
import { localesRoutes } from './modules/locales/routes.js';
import { personasRoutes } from './modules/personas/routes.js';
import { documentTypesRoutes } from './modules/documentos/typesRoutes.js';
import { documentosRoutes } from './modules/documentos/routes.js';
import { emailsRoutes } from './modules/emails/routes.js';
import { solicitudesRoutes } from './modules/solicitudes/routes.js';
import { autorizacionesRoutes } from './modules/autorizaciones/routes.js';
import { ingresosRoutes } from './modules/ingresos/routes.js';
import { dashboardRoutes } from './modules/dashboard/routes.js';
import { reportesRoutes } from './modules/reportes/routes.js';
import { auditRoutes } from './modules/audit/routes.js';
import { setupRoutes } from './modules/setup/routes.js';
import { configRoutes } from './modules/config/routes.js';

export async function buildServer() {
  // trustProxy: detrás de Fly (proxy TLS) para tomar la IP real del cliente (X-Forwarded-For),
  // clave para el rate-limit del login y para registrar bien la IP en la auditoría.
  const app = Fastify({ loggerInstance: logger, trustProxy: true, bodyLimit: (env.rules.maxFileMb + 5) * 1024 * 1024 });

  // Cabeceras de seguridad en TODAS las respuestas (sin dependencias extra tipo helmet).
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN'); // permite el visor de PDF en iframe propio, bloquea clickjacking externo
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-DNS-Prefetch-Control', 'off');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=()');
    if (env.isProd) reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    // CSP: todo desde el mismo origen. 'unsafe-inline' solo en estilos (React usa style inline);
    // los scripts son un bundle propio (sin inline). frame-src/ancestors 'self' habilita el visor
    // de PDF propio y bloquea que un sitio externo embeba la app.
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
    );
  });

  await app.register(cookie, { secret: env.sessionSecret });
  await app.register(multipart, {
    limits: { fileSize: env.rules.maxFileMb * 1024 * 1024, files: 20 },
  });
  await app.register(authPlugin);

  // Manejo de errores: mensajes claros al usuario, detalle técnico solo en logs.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.publicMessage });
    }
    if (err instanceof ZodError) {
      const first = err.errors[0];
      if (!first) return reply.status(400).send({ error: 'Datos inválidos.' });
      // Las validaciones a nivel objeto (refine) no tienen path: sin prefijo quedan legibles.
      const campo = first.path.join('.');
      return reply.status(400).send({ error: campo ? `${campo}: ${first.message}` : first.message });
    }
    // Errores de UNIQUE de SQLite, etc.
    const msg = (err as Error)?.message;
    if (typeof msg === 'string' && msg.includes('UNIQUE constraint failed')) {
      return reply.status(409).send({ error: 'Ya existe un registro con esos datos.' });
    }
    req.log.error({ err }, 'Error no controlado');
    return reply.status(500).send({ error: 'Ocurrió un error inesperado. Se registró para revisión.' });
  });

  // Rutas de API
  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(setupRoutes, { prefix: '/setup' });
      await api.register(usersRoutes, { prefix: '/usuarios' });
      await api.register(localesRoutes, { prefix: '/locales' });
      await api.register(personasRoutes, { prefix: '/personas' });
      await api.register(documentTypesRoutes, { prefix: '/tipos-documento' });
      await api.register(documentosRoutes, { prefix: '/documentos' });
      await api.register(emailsRoutes, { prefix: '/emails' });
      await api.register(solicitudesRoutes, { prefix: '/solicitudes' });
      await api.register(autorizacionesRoutes, { prefix: '/autorizaciones' });
      await api.register(ingresosRoutes, { prefix: '/ingresos' });
      await api.register(dashboardRoutes, { prefix: '/dashboard' });
      await api.register(reportesRoutes, { prefix: '/reportes' });
      await api.register(auditRoutes, { prefix: '/auditoria' });
      await api.register(configRoutes, { prefix: '/config' });
    },
    { prefix: '/api' },
  );

  app.get('/api/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  // Servir el frontend compilado (producción)
  const frontendDist = path.join(env.projectRoot, 'frontend', 'dist');
  if (fs.existsSync(frontendDist)) {
    await app.register(fastifyStatic, {
      root: frontendDist,
      prefix: '/',
      // Sin esto, el plugin escribe su propio Cache-Control después de setHeaders y lo pisa.
      cacheControl: false,
      // Los archivos de /assets llevan un hash en el nombre: cambian de nombre cuando cambian, así
      // que se pueden cachear para siempre. El index.html NO: es el que dice qué bundle cargar, y
      // si el navegador se lo queda cacheado sigue pidiendo el bundle de la versión anterior y la
      // app no se actualiza nunca (pasó: después de un deploy seguía viéndose la versión vieja).
      setHeaders(res, ruta) {
        const enAssets = ruta.split('\\').join('/').includes('/assets/');
        if (enAssets) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        return reply.status(404).send({ error: 'Ruta no encontrada.' });
      }
      // Un pedido de archivo que no existe NO puede devolver el index: el navegador recibía HTML
      // con estado 200 en lugar del .js que pidió, intentaba ejecutarlo como JavaScript y la app
      // quedaba en blanco sin ningún error entendible. Con un 404 el navegador falla claro y al
      // recargar levanta el index nuevo.
      if (req.url.startsWith('/assets/') || /\.[a-z0-9]{2,5}(\?|$)/i.test(req.url)) {
        return reply.status(404).send('No encontrado.');
      }
      // Ruta de la SPA (ej. /solicitudes/12): la resuelve el router del front.
      return reply.sendFile('index.html');
    });
  }

  return app;
}
