import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../server.js';
import { migrate } from '../db/migrate.js';

let app: Awaited<ReturnType<typeof buildServer>>;
beforeAll(async () => { migrate(); app = await buildServer(); });

/**
 * Después de un deploy seguía viéndose la versión anterior. La causa no era el caché a secas: un
 * pedido de un bundle que ya no existe caía en el fallback de la SPA y devolvía index.html con
 * estado 200 y content-type text/html. El navegador intentaba ejecutar HTML como JavaScript y la
 * app quedaba trabada, sin un error que lo explicara.
 */
describe('archivos estáticos y fallback de la SPA', () => {
  it('un asset que no existe da 404, no el index', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/index-VIEJO123.js' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type'] ?? '').not.toMatch(/text\/html/);
  });

  it('cualquier archivo inexistente con extensión da 404', async () => {
    for (const url of ['/algo.js', '/estilos.css', '/logo.png', '/x.woff2?v=2']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });

  it('una ruta de la SPA sí devuelve el index, para que la resuelva el router', async () => {
    const res = await app.inject({ method: 'GET', url: '/solicitudes/12' });
    // Sin frontend compilado en el entorno de test devuelve 404; con dist presente, el index.
    expect([200, 404]).toContain(res.statusCode);
    if (res.statusCode === 200) expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('una ruta de API inexistente responde JSON, no HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/no-existe' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBeTruthy();
  });
});
