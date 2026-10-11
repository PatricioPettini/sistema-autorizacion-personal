import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { migrate } from '../db/migrate.js';
import { db, schema } from '../db/client.js';
import { buildServer } from '../server.js';
import { createSession } from '../lib/session.js';
import { getVigenciasPorLocal } from '../modules/autorizaciones/service.js';
import { todayLocal } from '../lib/datetime.js';

let app: Awaited<ReturnType<typeof buildServer>>;
let cookie = '';
let persona = 0, localA = 0, localB = 0, admin = 0;
const t = `${Date.now()}`.slice(-7);
const hoy = todayLocal();
const ayer = new Date(Date.parse(`${hoy}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
const enUnMes = new Date(Date.parse(`${hoy}T12:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);

function autorizar(personaId: number, localId: number, fecha = ayer, hasta = enUnMes, estado = 'AUTORIZADA') {
  const sol = db.insert(schema.solicitudes).values({ localId, estado: 'AUTORIZADA', trabajo: `Trabajo ${localId}` }).returning().get();
  db.insert(schema.solicitudPersonas).values({ solicitudId: sol.id, personaId, estado: 'AUTORIZADA' }).run();
  return db.insert(schema.autorizaciones).values({
    solicitudId: sol.id, personaId, localId, fecha, fechaHasta: hasta,
    horaDesde: '00:00', horaHasta: '23:59', estado, autorizadaPorUserId: admin,
  }).returning().get();
}

beforeAll(async () => {
  migrate();
  app = await buildServer();
  const u = db.insert(schema.users).values({
    nombre: 'Seguri', email: `seg${t}@t.com`, passwordHash: 'x', rol: 'SEGURIDAD', activo: true,
  }).returning().get();
  cookie = `sap_session=${createSession(u.id)}`;
  admin = db.insert(schema.users).values({
    nombre: 'AdminML', email: `adminml${t}@t.com`, passwordHash: 'x', rol: 'ADMIN', activo: true,
  }).returning().get().id;
  localA = db.insert(schema.locales).values({ nombre: `Aloha ${t}`, estado: 'ACTIVO' }).returning().get().id;
  localB = db.insert(schema.locales).values({ nombre: `Zeta ${t}`, estado: 'ACTIVO' }).returning().get().id;
  persona = db.insert(schema.personas).values({
    dni: `44${t}`.slice(-8), nombre: 'Multi', apellido: 'Local', categoria: 'MONOTRIBUTISTA',
  }).returning().get().id;
  // El caso real: el mismo técnico contratado por dos negocios, las dos vigentes hoy.
  autorizar(persona, localA);
  autorizar(persona, localB);
});

const ficha = async () => {
  const res = await app.inject({ method: 'GET', url: `/api/personas/${persona}`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as any;
};
const ingresar = (localId: number) =>
  app.inject({ method: 'POST', url: '/api/ingresos', headers: { cookie }, payload: { personaId: persona, localId } });

describe('una persona autorizada por varios locales', () => {
  it('la ficha devuelve TODAS las autorizaciones vigentes, no una sola', async () => {
    const d = await ficha();
    expect(d.vigencia).toBe('AUTORIZADO');
    expect(d.vigentes.length, 'antes devolvía una y el otro local quedaba invisible').toBe(2);
    expect(d.vigentes.map((v: any) => v.localId).sort()).toEqual([localA, localB].sort());
    // Cada una trae el local y el trabajo, que es lo que Seguridad necesita para elegir.
    for (const v of d.vigentes) expect(v.local).toBeTruthy();
  });

  it('el ingreso se imputa al local que se elige', async () => {
    expect((await ingresar(localB)).statusCode).toBe(200);
    const abierta = db.select().from(schema.entradas).where(eq(schema.entradas.personaId, persona)).all().find((e) => !e.fechaHoraSalida)!;
    expect(abierta.localId, 'tiene que quedar en el local elegido, no en el primero de la lista').toBe(localB);
  });

  it('con un ingreso abierto en otro local, el error dice cuál es', async () => {
    const res = await ingresar(localA);
    expect(res.statusCode).toBe(400);
    expect(res.json().error ?? res.json().message).toMatch(new RegExp(`Zeta ${t}`));
  });

  it('después de la salida se le puede dar ingreso al otro local', async () => {
    const abierta = db.select().from(schema.entradas).where(eq(schema.entradas.personaId, persona)).all().find((e) => !e.fechaHoraSalida)!;
    expect((await app.inject({ method: 'POST', url: `/api/ingresos/${abierta.id}/salida`, headers: { cookie } })).statusCode).toBe(200);
    expect((await ingresar(localA)).statusCode).toBe(200);
    const nueva = db.select().from(schema.entradas).where(eq(schema.entradas.personaId, persona)).all().find((e) => !e.fechaHoraSalida)!;
    expect(nueva.localId).toBe(localA);
  });

  it('no se puede dar ingreso a un local que no la autorizó', async () => {
    const ajeno = db.insert(schema.locales).values({ nombre: `Ajeno ${t}`, estado: 'ACTIVO' }).returning().get().id;
    const res = await ingresar(ajeno);
    expect(res.statusCode).toBe(400);
  });
});

describe('getVigenciasPorLocal', () => {
  it('no cuenta las vencidas ni las revocadas', () => {
    const p = db.insert(schema.personas).values({ dni: `55${t}`.slice(-8), nombre: 'Uno', apellido: 'Solo' }).returning().get().id;
    const l1 = db.insert(schema.locales).values({ nombre: `L1 ${t}`, estado: 'ACTIVO' }).returning().get().id;
    const l2 = db.insert(schema.locales).values({ nombre: `L2 ${t}`, estado: 'ACTIVO' }).returning().get().id;
    const l3 = db.insert(schema.locales).values({ nombre: `L3 ${t}`, estado: 'ACTIVO' }).returning().get().id;
    autorizar(p, l1);                                  // vigente
    autorizar(p, l2, '2026-01-01', '2026-01-31');       // vencida
    autorizar(p, l3, ayer, enUnMes, 'REVOCADA');        // revocada
    expect(getVigenciasPorLocal(p).map((a) => a.localId)).toEqual([l1]);
  });

  it('si un local tiene dos autorizaciones solapadas, devuelve una sola vez ese local', () => {
    const p = db.insert(schema.personas).values({ dni: `66${t}`.slice(-8), nombre: 'Dos', apellido: 'Iguales' }).returning().get().id;
    const l = db.insert(schema.locales).values({ nombre: `Dup ${t}`, estado: 'ACTIVO' }).returning().get().id;
    autorizar(p, l);
    autorizar(p, l);
    expect(getVigenciasPorLocal(p).length).toBe(1);
  });
});
