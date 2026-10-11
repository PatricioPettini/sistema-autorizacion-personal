/**
 * Aprobar el mismo requisito para varias personas de una vez.
 *
 * La Nómina ART es UN papel que lista a todo el grupo, pero el requisito es por persona: en un
 * pedido de 28 había que aprobarlo 28 veces sobre el mismo PDF. Lo que se prueba acá es que el
 * bloque haga exactamente lo mismo que aprobar una por una —incluida la autorización automática—,
 * y que respete a quién se dejó afuera.
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

const verificacionDe = (personaId: number, codigo: string) =>
  db.select().from(schema.documentos)
    .where(and(eq(schema.documentos.personaId, personaId), eq(schema.documentos.tipoDocumentoId, tipoId(codigo))))
    .get()?.verificacion ?? null;

function aprobarDeSolicitud(solicitudId: number, codigo: string) {
  const t = tipoId(codigo);
  const hay = db.select().from(schema.solicitudDocumentos)
    .where(and(eq(schema.solicitudDocumentos.solicitudId, solicitudId), eq(schema.solicitudDocumentos.tipoDocumentoId, t))).get();
  if (!hay) db.insert(schema.solicitudDocumentos).values({ solicitudId, tipoDocumentoId: t, verificacion: 'VERIFICADO' }).run();
}

/** Una solicitud de empresa con N personas y TODO lo de la solicitud ya aprobado. */
function solicitudCon(cuiles: string[]) {
  const local = db.insert(schema.locales).values({ nombre: `Local Bloque ${Date.now()}${Math.random()}`, estado: 'ACTIVO' }).returning().get();
  const sol = db.insert(schema.solicitudes).values({ localId: local.id, estado: 'PENDIENTE' }).returning().get();
  const ids = cuiles.map((cuil) => {
    const { persona } = findOrCreatePersona({ cuil, nombre: 'Test', apellido: `Bloque${cuil.slice(-4)}` });
    db.update(schema.personas).set({ categoria: 'EMPRESA' }).where(eq(schema.personas.id, persona.id)).run();
    db.insert(schema.solicitudPersonas).values({ solicitudId: sol.id, personaId: persona.id }).run();
    return persona.id;
  });
  for (const c of ['FORM_931', 'PAGO_ARCA', 'CLAUSULA_NO_REPETICION']) aprobarDeSolicitud(sol.id, c);
  return { solicitudId: sol.id, personas: ids };
}

const enBloque = (personaIds: number[], codigo: string, estado = 'VERIFICADO') =>
  app.inject({
    method: 'POST', url: '/api/documentos/verificar-varios', headers: { cookie },
    payload: { personaIds, tipoDocumentoId: tipoId(codigo), estado },
  });

beforeAll(async () => {
  migrate();
  app = await buildServer();
  const u = db.insert(schema.users).values({
    nombre: 'AdminBloque', email: `bloque${Date.now()}@t.com`, passwordHash: 'x', rol: 'ADMIN', activo: true,
  }).returning().get();
  cookie = `sap_session=${createSession(u.id)}`;
});

describe('aprobar un requisito para varias personas', () => {
  it('aprueba a las que se le pasan y deja igual a las demás', async () => {
    const { personas } = solicitudCon(['20145967555', '23145757142', '24316058899']);

    const res = await enBloque(personas.slice(0, 2), 'NOMINA_ART');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cuantas: 2 });
    expect(verificacionDe(personas[0], 'NOMINA_ART')).toBe('VERIFICADO');
    expect(verificacionDe(personas[1], 'NOMINA_ART')).toBe('VERIFICADO');
    // La tercera quedó afuera a propósito: el bloque recibe la lista, no "todas".
    expect(verificacionDe(personas[2], 'NOMINA_ART')).toBeNull();
  });

  it('dispara la autorización automática igual que aprobando de a una', async () => {
    const { solicitudId, personas } = solicitudCon(['27189988112', '20298901960']);
    const futuro = new Date(new Date(`${todayLocal()}T12:00:00Z`).getTime() + 30 * 86400000).toISOString().slice(0, 10);
    await app.inject({
      method: 'POST', url: `/api/solicitudes/${solicitudId}/vencimiento`, headers: { cookie },
      payload: { fechaVencimiento: futuro },
    });

    await enBloque(personas, 'NOMINA_ART');

    for (const personaId of personas) {
      const aut = db.select().from(schema.autorizaciones)
        .where(and(eq(schema.autorizaciones.solicitudId, solicitudId), eq(schema.autorizaciones.personaId, personaId),
          eq(schema.autorizaciones.estado, 'AUTORIZADA'))).get();
      expect(aut, `persona ${personaId}`).toBeTruthy();
      expect(aut!.fechaHasta).toBe(futuro);
    }
  });

  it('sirve también para marcar que falta, no sólo para aprobar', async () => {
    const { personas } = solicitudCon(['27367921221', '20360786685']);

    await enBloque(personas, 'NOMINA_ART', 'RECHAZADO');

    for (const p of personas) expect(verificacionDe(p, 'NOMINA_ART')).toBe('RECHAZADO');
  });

  it('no acepta una lista vacía', async () => {
    const res = await enBloque([], 'NOMINA_ART');
    expect(res.statusCode).toBe(400);
  });
});
