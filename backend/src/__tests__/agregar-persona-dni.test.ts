import { describe, it, expect, beforeAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { migrate } from '../db/migrate.js';
import { db, schema } from '../db/client.js';
import { buildServer } from '../server.js';
import { createSession } from '../lib/session.js';

let app: Awaited<ReturnType<typeof buildServer>>;
let cookie = '';
let solicitud = 0;
const t = `${Date.now()}`.slice(-6);

beforeAll(async () => {
  migrate();
  app = await buildServer();
  const u = db.insert(schema.users).values({
    nombre: 'AdminDni', email: `admindni${t}@t.com`, passwordHash: 'x', rol: 'ADMIN', activo: true,
  }).returning().get();
  cookie = `sap_session=${createSession(u.id)}`;
  const local = db.insert(schema.locales).values({ nombre: `Local DNI ${t}`, estado: 'ACTIVO' }).returning().get();
  solicitud = db.insert(schema.solicitudes).values({ localId: local.id, estado: 'PENDIENTE' }).returning().get().id;
});

const agregar = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/solicitudes/${solicitud}/personas`, headers: { cookie }, payload });

const personasDe = (id: number) =>
  db.select({ cuil: schema.personas.cuil, dni: schema.personas.dni, ap: schema.personas.apellido })
    .from(schema.solicitudPersonas)
    .innerJoin(schema.personas, eq(schema.personas.id, schema.solicitudPersonas.personaId))
    .where(eq(schema.solicitudPersonas.solicitudId, id)).all();

/**
 * Muchas planillas traen solo el DNI. Antes el alta exigía CUIL, así que había que salir a buscarlo
 * para poder cargar a la persona, o inventarlo.
 */
describe('cargar una persona con DNI en vez de CUIL', () => {
  it('se puede dar de alta solo con el DNI', async () => {
    const res = await agregar({ dni: '30410849', nombre: 'Juan', apellido: 'Perez' });
    expect(res.statusCode, res.body).toBe(200);
    const p = personasDe(solicitud).find((x) => x.ap === 'Perez')!;
    expect(p.dni).toBe('30410849');
    expect(p.cuil).toBeFalsy();
  });

  it('con el CUIL sigue funcionando igual', async () => {
    const res = await agregar({ cuil: '20-33163078-1', nombre: 'Ana', apellido: 'Gomez' });
    expect(res.statusCode, res.body).toBe(200);
    const p = personasDe(solicitud).find((x) => x.ap === 'Gomez')!;
    expect(p.cuil).toBe('20331630781');
  });

  it('sin CUIL ni DNI no se puede', async () => {
    const res = await agregar({ nombre: 'Sin', apellido: 'Documento' });
    expect(res.statusCode).toBe(400);
  });

  it('un DNI de 4 dígitos no alcanza', async () => {
    expect((await agregar({ dni: '1234', nombre: 'Corto', apellido: 'Documento' })).statusCode).toBe(400);
  });

  it('la misma persona por DNI no entra dos veces', async () => {
    const res = await agregar({ dni: '30410849', nombre: 'Juan', apellido: 'Perez' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error ?? res.json().message).toMatch(/ya está en la solicitud/i);
  });

  /**
   * El CUIL contiene al DNI. Si alguien carga primero uno y después el otro, es la misma persona:
   * antes el chequeo miraba solo la columna CUIL y la dejaba entrar de nuevo.
   */
  it('cargarla por CUIL cuando ya está por DNI tampoco la duplica', async () => {
    const res = await agregar({ cuil: '20-30410849-6', nombre: 'Juan', apellido: 'Perez' });
    expect(res.statusCode).toBe(400);
    expect(personasDe(solicitud).filter((x) => x.ap === 'Perez').length).toBe(1);
  });

  it('crear una solicitud a mano también acepta DNI', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/solicitudes/manual', headers: { cookie },
      payload: { localNombre: `Otro local ${t}`, personas: [{ dni: '28123530', nombre: 'Luis', apellido: 'Silva' }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const nueva = (res.json() as any).solicitudId;
    expect(personasDe(nueva).map((p) => p.dni)).toContain('28123530');
  });
});

/**
 * Sacar el aviso de "documentación nueva" sin rehacer la revisión. Antes la única forma era mandar
 * la solicitud a la papelera, que hace desaparecer la FAO entera del listado.
 */
describe('marcar como visto el aviso de documentación nueva', () => {
  it('apaga el aviso y no toca nada más', async () => {
    const local = db.insert(schema.locales).values({ nombre: `Visto ${t}`, estado: 'ACTIVO' }).returning().get();
    const sol = db.insert(schema.solicitudes).values({
      localId: local.id, estado: 'AUTORIZADA', nroOrden: `OA-2026-95${t.slice(-2)}`, docNuevaAt: new Date().toISOString(),
    }).returning().get();

    const res = await app.inject({ method: 'POST', url: `/api/solicitudes/${sol.id}/visto`, headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);

    const despues = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, sol.id)).get()!;
    expect(despues.docNuevaAt).toBeNull();
    expect(despues.estado, 'no cambia el estado').toBe('AUTORIZADA');
    expect(despues.deletedAt, 'no la manda a la papelera').toBeFalsy();
  });

  it('una solicitud que no existe da 404', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/solicitudes/999999/visto', headers: { cookie } })).statusCode).toBe(404);
  });
});
