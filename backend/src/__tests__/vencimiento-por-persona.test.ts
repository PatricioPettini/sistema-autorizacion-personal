/**
 * La vigencia es del grupo, pero cada persona puede tener la suya.
 *
 * El caso que lo pide: de cuatro que entran a hacer un trabajo, a uno le vence la ART antes, o
 * entra solo dos días. Antes había que partir el pedido en dos solicitudes.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { migrate } from '../db/migrate.js';
import { db, schema } from '../db/client.js';
import { buildServer } from '../server.js';
import { createSession } from '../lib/session.js';
import { findOrCreatePersona } from '../modules/personas/service.js';
import { todayLocal } from '../lib/datetime.js';

let app: Awaited<ReturnType<typeof buildServer>>;
let cookie = '';

const tipoId = (codigo: string) =>
  db.select().from(schema.documentTypes).where(eq(schema.documentTypes.codigo, codigo)).get()!.id;

function aprobarDePersona(personaId: number, codigo: string) {
  const t = tipoId(codigo);
  const hay = db.select().from(schema.documentos)
    .where(and(eq(schema.documentos.personaId, personaId), eq(schema.documentos.tipoDocumentoId, t))).get();
  if (!hay) db.insert(schema.documentos).values({ personaId, tipoDocumentoId: t }).run();
  db.update(schema.documentos).set({ verificacion: 'VERIFICADO' })
    .where(and(eq(schema.documentos.personaId, personaId), eq(schema.documentos.tipoDocumentoId, t))).run();
}

function aprobarDeSolicitud(solicitudId: number, codigo: string) {
  const t = tipoId(codigo);
  const hay = db.select().from(schema.solicitudDocumentos)
    .where(and(eq(schema.solicitudDocumentos.solicitudId, solicitudId), eq(schema.solicitudDocumentos.tipoDocumentoId, t))).get();
  if (!hay) db.insert(schema.solicitudDocumentos).values({ solicitudId, tipoDocumentoId: t, verificacion: 'VERIFICADO' }).run();
  else db.update(schema.solicitudDocumentos).set({ verificacion: 'VERIFICADO' }).where(eq(schema.solicitudDocumentos.id, hay.id)).run();
}

/** Una solicitud con dos personas, las dos con toda la documentación aprobada. */
function solicitudConDos(cuilA: string, cuilB: string) {
  const local = db.insert(schema.locales).values({ nombre: `Local Venc ${Date.now()}${Math.random()}`, estado: 'ACTIVO' }).returning().get();
  const sol = db.insert(schema.solicitudes).values({ localId: local.id, estado: 'PENDIENTE' }).returning().get();
  const ids: number[] = [];
  for (const cuil of [cuilA, cuilB]) {
    const { persona } = findOrCreatePersona({ cuil, nombre: 'Test', apellido: `Venc${cuil.slice(-4)}` });
    db.update(schema.personas).set({ categoria: 'EMPRESA' }).where(eq(schema.personas.id, persona.id)).run();
    db.insert(schema.solicitudPersonas).values({ solicitudId: sol.id, personaId: persona.id }).run();
    aprobarDePersona(persona.id, 'NOMINA_ART');
    ids.push(persona.id);
  }
  for (const c of ['FORM_931', 'PAGO_ARCA', 'CLAUSULA_NO_REPETICION']) aprobarDeSolicitud(sol.id, c);
  return { solicitudId: sol.id, personas: ids };
}

const enDias = (n: number) =>
  new Date(new Date(`${todayLocal()}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

const autorizacionDe = (solicitudId: number, personaId: number) =>
  db.select().from(schema.autorizaciones)
    .where(and(eq(schema.autorizaciones.solicitudId, solicitudId), eq(schema.autorizaciones.personaId, personaId),
      eq(schema.autorizaciones.estado, 'AUTORIZADA'))).get();

beforeAll(async () => {
  migrate();
  app = await buildServer();
  const u = db.insert(schema.users).values({
    nombre: 'AdminVenc', email: `venc${Date.now()}@t.com`, passwordHash: 'x', rol: 'ADMIN', activo: true,
  }).returning().get();
  cookie = `sap_session=${createSession(u.id)}`;
});

describe('vigencia general con excepción por persona', () => {
  it('sin fecha propia, a cada una la autoriza la fecha del grupo', async () => {
    const { solicitudId, personas } = solicitudConDos('20145967555', '23145757142');
    const general = enDias(30);

    const res = await app.inject({
      method: 'POST', url: `/api/solicitudes/${solicitudId}/vencimiento`, headers: { cookie },
      payload: { fechaVencimiento: general },
    });
    expect(res.statusCode).toBe(200);

    for (const id of personas) expect(autorizacionDe(solicitudId, id)!.fechaHasta).toBe(general);
  });

  it('la fecha propia de una persona le gana a la general, y no toca a las demás', async () => {
    const { solicitudId, personas } = solicitudConDos('24316058899', '27189988112');
    const general = enDias(30);
    const propia = enDias(5);
    await app.inject({
      method: 'POST', url: `/api/solicitudes/${solicitudId}/vencimiento`, headers: { cookie },
      payload: { fechaVencimiento: general },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/solicitudes/${solicitudId}/personas/${personas[0]}/vencimiento`, headers: { cookie },
      payload: { fechaVencimiento: propia },
    });
    expect(res.statusCode).toBe(200);

    expect(autorizacionDe(solicitudId, personas[0])!.fechaHasta).toBe(propia);
    expect(autorizacionDe(solicitudId, personas[1])!.fechaHasta).toBe(general);
  });

  it('vaciarla la devuelve a la general', async () => {
    const { solicitudId, personas } = solicitudConDos('20298901960', '27367921221');
    const general = enDias(30);
    await app.inject({
      method: 'POST', url: `/api/solicitudes/${solicitudId}/vencimiento`, headers: { cookie },
      payload: { fechaVencimiento: general },
    });
    await app.inject({
      method: 'POST', url: `/api/solicitudes/${solicitudId}/personas/${personas[0]}/vencimiento`, headers: { cookie },
      payload: { fechaVencimiento: enDias(5) },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/solicitudes/${solicitudId}/personas/${personas[0]}/vencimiento`, headers: { cookie },
      payload: { fechaVencimiento: null },
    });
    expect(res.statusCode).toBe(200);
    expect(autorizacionDe(solicitudId, personas[0])!.fechaHasta).toBe(general);
  });

  it('tampoco acepta una fecha propia ya pasada', async () => {
    const { solicitudId, personas } = solicitudConDos('20360786685', '20337916512');
    const res = await app.inject({
      method: 'POST', url: `/api/solicitudes/${solicitudId}/personas/${personas[0]}/vencimiento`, headers: { cookie },
      payload: { fechaVencimiento: enDias(-1) },
    });
    expect(res.statusCode).toBe(400);
  });
});
