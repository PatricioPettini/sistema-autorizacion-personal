/**
 * El tipo de contratista que declara el correo tiene que sobrevivir aunque la solicitud entre vacía.
 *
 * El tipo no es un campo de la solicitud: vive en cada persona. Cuando el correo entra sin nómina
 * legible no hay a quién estampárselo, así que el "Empresa" del asunto se leía bien y se perdía, y
 * el que cargaba la gente a mano tenía que volver a elegirlo mirando un asunto que ya lo decía.
 * Caso real: OA-2026-0299, "Solicitud de Fao (Surfistas) Empresa - Mundo Sport SRL".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { migrate } from '../db/migrate.js';
import { db, schema } from '../db/client.js';
import { buildServer } from '../server.js';
import { createSession } from '../lib/session.js';
import { findOrCreatePersona } from '../modules/personas/service.js';

let app: Awaited<ReturnType<typeof buildServer>>;
let cookie = '';
const t = `${Date.now()}`.slice(-6);
let n = 0;

beforeAll(async () => {
  migrate();
  app = await buildServer();
  const u = db.insert(schema.users).values({
    nombre: 'AdminTipo', email: `admintipo${t}@t.com`, passwordHash: 'x', rol: 'ADMIN', activo: true,
  }).returning().get();
  cookie = `sap_session=${createSession(u.id)}`;
});

/** Una solicitud con (o sin) un correo que declara el tipo en el asunto o en el cuerpo. */
function solicitudCon(opts: { asunto?: string; cuerpo?: string; conEmail?: boolean } = {}) {
  const id = ++n;
  const local = db.insert(schema.locales).values({ nombre: `LocalTipo ${t}-${id}`, estado: 'ACTIVO' }).returning().get();
  const email = opts.conEmail === false ? null : db.insert(schema.emailMessages).values({
    messageId: `<tipo-${t}-${id}>`, estado: 'PROCESSED', asunto: opts.asunto ?? null, cuerpo: opts.cuerpo ?? null,
  }).returning().get();
  return db.insert(schema.solicitudes).values({ localId: local.id, emailMessageId: email?.id ?? null, estado: 'PENDIENTE' }).returning().get().id;
}

const agregar = (solId: number, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/solicitudes/${solId}/personas`, headers: { cookie }, payload });

const categoriaDe = (dni: string) =>
  db.select().from(schema.personas).where(eq(schema.personas.dni, dni)).get()?.categoria ?? null;

describe('el tipo declarado en el correo lo hereda la persona cargada a mano', () => {
  it('lo toma del asunto, con el formato real del local', async () => {
    const sol = solicitudCon({ asunto: 'Solicitud de Fao (Surfistas) Empresa - Mundo Sport SRL' });

    const res = await agregar(sol, { dni: '30590877', nombre: 'Juan', apellido: 'Silva' });

    expect(res.statusCode, res.body).toBe(200);
    expect(categoriaDe('30590877')).toBe('EMPRESA');
  });

  it('lo toma del cuerpo cuando el asunto no lo dice', async () => {
    const sol = solicitudCon({ asunto: 'Solicitud de FAO', cuerpo: 'Buen día, va la documentación del monotributista.' });

    await agregar(sol, { dni: '30050454', nombre: 'Ana', apellido: 'Gomez' });

    expect(categoriaDe('30050454')).toBe('MONOTRIBUTISTA');
  });

  it('el tipo elegido en el alta le gana al del asunto', async () => {
    const sol = solicitudCon({ asunto: 'Solicitud de Fao (X) Empresa' });

    await agregar(sol, { dni: '30919020', nombre: 'Luis', apellido: 'Paz', categoria: 'MONOTRIBUTISTA' });

    expect(categoriaDe('30919020')).toBe('MONOTRIBUTISTA');
  });

  /** Deducir un tipo es una cosa; cambiárselo a una ficha que ya lo tenía es otra. */
  it('NO le pisa el tipo a una persona que ya lo traía de otra solicitud', async () => {
    findOrCreatePersona({ dni: '30122976', nombre: 'Rosa', apellido: 'Diaz' });
    db.update(schema.personas).set({ categoria: 'MONOTRIBUTISTA' }).where(eq(schema.personas.dni, '30122976')).run();
    const sol = solicitudCon({ asunto: 'Solicitud de Fao (Y) Empresa' });

    await agregar(sol, { dni: '30122976', nombre: 'Rosa', apellido: 'Diaz' });

    expect(categoriaDe('30122976')).toBe('MONOTRIBUTISTA');
  });

  it('sin correo que lo declare, hereda el tipo que comparten los que ya están', async () => {
    const sol = solicitudCon({ conEmail: false });
    await agregar(sol, { dni: '30396365', nombre: 'Pedro', apellido: 'Luna', categoria: 'EMPRESA' });

    await agregar(sol, { dni: '30483749', nombre: 'Mario', apellido: 'Vera' });

    expect(categoriaDe('30483749')).toBe('EMPRESA');
  });

  it('si los que están tienen tipos distintos no inventa ninguno', async () => {
    const sol = solicitudCon({ conEmail: false });
    await agregar(sol, { dni: '30196773', nombre: 'Eva', apellido: 'Rios', categoria: 'EMPRESA' });
    await agregar(sol, { dni: '30157615', nombre: 'Omar', apellido: 'Sosa', categoria: 'MONOTRIBUTISTA' });

    await agregar(sol, { dni: '30392735', nombre: 'Clara', apellido: 'Niz' });

    expect(categoriaDe('30392735')).toBeNull();
  });

  it('el importador de PDF hereda igual que el alta de a una', async () => {
    const sol = solicitudCon({ asunto: 'SOLICITUD FAO (TOLDO) - MONOTRIBUTISTA' });

    const res = await app.inject({
      method: 'POST', url: `/api/solicitudes/${sol}/personas/importar`, headers: { cookie },
      payload: { personas: [{ dni: '30465946', nombre: 'Hugo', apellido: 'Arce' }] },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(categoriaDe('30465946')).toBe('MONOTRIBUTISTA');
  });
});
