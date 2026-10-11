import { describe, it, expect, beforeAll } from 'vitest';
import { migrate } from '../db/migrate.js';
import { db, schema } from '../db/client.js';
import { buildServer } from '../server.js';
import { createSession } from '../lib/session.js';
import { localAUtcIso } from '../lib/datetime.js';

let app: Awaited<ReturnType<typeof buildServer>>;
let cookie = '';
let local = 0, otroLocal = 0;
const t = `${Date.now()}`.slice(-7);

/** Registra una entrada ya cerrada (o abierta) con horarios LOCALES. */
let seq = 0;
function entrada(nombre: string, localId: number, ingreso: string, salida?: string) {
  const p = db.insert(schema.personas).values({
    dni: `${++seq}${t}`.slice(-8), nombre, apellido: `Apel${nombre}`, categoria: 'EMPRESA',
  }).returning().get();
  return db.insert(schema.entradas).values({
    personaId: p.id, localId,
    fechaHoraIngreso: localAUtcIso('2026-07-15', ingreso)!,
    fechaHoraSalida: salida ? localAUtcIso('2026-07-15', salida)! : null,
  }).returning().get();
}

beforeAll(async () => {
  migrate();
  app = await buildServer();
  const u = db.insert(schema.users).values({
    nombre: 'AdminRep', email: `adminrep${t}@t.com`, passwordHash: 'x', rol: 'ADMIN', activo: true,
  }).returning().get();
  cookie = `sap_session=${createSession(u.id)}`;
  local = db.insert(schema.locales).values({ nombre: `Zapatos ${t}`, estado: 'ACTIVO' }).returning().get().id;
  otroLocal = db.insert(schema.locales).values({ nombre: `Aloha ${t}`, estado: 'ACTIVO' }).returning().get().id;

  entrada('Manana', local, '08:00', '12:00');      // solo a la mañana
  entrada('Tarde', local, '13:00', '19:00');       // solo a la tarde
  entrada('TodoElDia', local, '07:30', '20:00');   // todo el día
  entrada('Abierta', local, '09:00');              // nunca le registraron la salida
  entrada('OtroLocal', otroLocal, '13:00', '18:00');
  entrada('Nocturno', local, '22:30');             // entró de noche: en UTC ya es el día siguiente
});

const presentes = async (hora: string, localId?: number) => {
  const url = `/api/reportes/presentes?fecha=2026-07-15&hora=${hora}${localId ? `&localId=${localId}` : ''}`;
  const res = await app.inject({ method: 'GET', url, headers: { cookie } });
  expect(res.statusCode, url).toBe(200);
  return (res.json() as any).personas as any[];
};
const nombres = (rows: any[]) => rows.map((r) => r.nombre).sort();

describe('quién estaba adentro a una hora puntual', () => {
  it('a las 10:00 están los de la mañana, no los de la tarde', async () => {
    const rows = (await presentes('10:00')).filter((r) => r.local.startsWith('Zapatos') || r.local.startsWith('Aloha'));
    expect(nombres(rows)).toEqual(['Abierta', 'Manana', 'TodoElDia']);
  });

  it('a las 15:00 cambió el turno', async () => {
    const rows = (await presentes('15:00')).filter((r) => r.local.startsWith('Zapatos') || r.local.startsWith('Aloha'));
    expect(nombres(rows)).toEqual(['Abierta', 'OtroLocal', 'Tarde', 'TodoElDia']);
  });

  it('el filtro por local funciona', async () => {
    expect(nombres(await presentes('15:00', otroLocal))).toEqual(['OtroLocal']);
  });

  it('a las 06:00, antes de que abriera, no hay nadie de estos locales', async () => {
    const rows = (await presentes('06:00')).filter((r) => r.local.startsWith('Zapatos') || r.local.startsWith('Aloha'));
    expect(rows.length).toBe(0);
  });

  it('el que salió justo a esa hora todavía cuenta (el borde se incluye)', async () => {
    const rows = await presentes('12:00', local);
    expect(nombres(rows)).toContain('Manana');
    expect(nombres(await presentes('12:01', local))).not.toContain('Manana');
  });

  it('marca a los que no tienen salida registrada, para no leerlos como permanencia probada', async () => {
    const abierta = (await presentes('15:00', local)).find((r) => r.nombre === 'Abierta');
    expect(abierta.sinSalida).toBe(true);
    const cerrada = (await presentes('15:00', local)).find((r) => r.nombre === 'Tarde');
    expect(cerrada.sinSalida).toBe(false);
  });

  /**
   * La hora se interpreta en la zona del shopping, no en UTC. Un ingreso de las 22:30 del 15/07 se
   * guarda como 01:30Z del 16/07: con el filtro pegando "T23:00:00Z" esa persona no aparecía a las
   * 23:00 de la noche del 15 y sí aparecía en el reporte del 16.
   */
  it('la hora es local, no UTC', async () => {
    expect(nombres(await presentes('23:00', local))).toContain('Nocturno');
    expect(nombres(await presentes('21:00', local))).not.toContain('Nocturno');
  });

  it('una fecha inválida da 400, no una lista vacía que parezca "no había nadie"', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/reportes/presentes?fecha=15/07/2026&hora=10:00', headers: { cookie } });
    expect(res.statusCode).toBe(400);
  });

  it('sin sesión no se puede consultar', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/reportes/presentes?fecha=2026-07-15&hora=10:00' });
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe('localAUtcIso', () => {
  it('convierte hora local de Buenos Aires a UTC', () => {
    expect(localAUtcIso('2026-07-15', '10:00')).toBe('2026-07-15T13:00:00.000Z');
    expect(localAUtcIso('2026-07-15', '22:30')).toBe('2026-07-16T01:30:00.000Z');
    expect(localAUtcIso('2026-07-15', '00:00')).toBe('2026-07-15T03:00:00.000Z');
  });

  it('rechaza lo que no es una fecha u hora válida', () => {
    for (const [f, h] of [['15/07/2026', '10:00'], ['2026-07-15', '25:00'], ['2026-07-15', '10'], ['', '10:00']]) {
      expect(localAUtcIso(f, h), `${f} ${h}`).toBeNull();
    }
  });
});
