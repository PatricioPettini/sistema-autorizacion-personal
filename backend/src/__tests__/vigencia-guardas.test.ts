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

/** Una solicitud con una persona que tiene TODA la documentación aprobada, pero sin vigencia. */
function solicitudLista(cuil: string) {
  const { persona } = findOrCreatePersona({ cuil, nombre: 'Sara', apellido: 'Vega' });
  db.update(schema.personas).set({ categoria: 'EMPRESA' }).where(eq(schema.personas.id, persona.id)).run();
  const local = db.insert(schema.locales).values({ nombre: `Local Guarda ${Date.now()}${Math.random()}`, estado: 'ACTIVO' }).returning().get();
  const sol = db.insert(schema.solicitudes).values({ localId: local.id, estado: 'PENDIENTE' }).returning().get();
  db.insert(schema.solicitudPersonas).values({ solicitudId: sol.id, personaId: persona.id }).run();
  aprobarDePersona(persona.id, 'NOMINA_ART');
  for (const c of ['FORM_931', 'PAGO_ARCA', 'CLAUSULA_NO_REPETICION']) aprobarDeSolicitud(sol.id, c);
  return sol.id;
}

const enDias = (n: number) =>
  new Date(new Date(`${todayLocal()}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  migrate();
  app = await buildServer();
  const u = db.insert(schema.users).values({
    nombre: 'AdminGuarda', email: `guarda${Date.now()}@t.com`, passwordHash: 'x', rol: 'ADMIN', activo: true,
  }).returning().get();
  cookie = `sap_session=${createSession(u.id)}`;
});

describe('guardas de la vigencia', () => {
  it('no deja guardar una vigencia ya pasada', async () => {
    const solicitudId = solicitudLista('20554908123');
    const res = await app.inject({
      method: 'POST', url: `/api/solicitudes/${solicitudId}/vencimiento`, headers: { cookie },
      payload: { fechaVencimiento: enDias(-1) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message ?? res.json().error).toMatch(/anterior a hoy/i);
    // Y no la guardó: la autorización habría nacido vencida.
    expect(db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get()!.fechaVencimiento).toBeNull();
  });

  it('acepta hoy y cualquier fecha futura', async () => {
    const solicitudId = solicitudLista('20554908123');
    for (const fecha of [todayLocal(), enDias(30)]) {
      const res = await app.inject({
        method: 'POST', url: `/api/solicitudes/${solicitudId}/vencimiento`, headers: { cookie },
        payload: { fechaVencimiento: fecha },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it('no deja terminar la revisión si hay gente lista y la solicitud no tiene vigencia', async () => {
    const solicitudId = solicitudLista('27304108496');
    const res = await app.inject({ method: 'POST', url: `/api/solicitudes/${solicitudId}/terminar-revision`, headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message ?? res.json().error).toMatch(/Vigencia hasta/i);
    // No mandó el email ni cerró la revisión.
    expect(db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get()!.nroOrden).toBeNull();
  });

  it('con la vigencia cargada, la revisión se puede terminar', async () => {
    const solicitudId = solicitudLista('27304108496');
    await app.inject({
      method: 'POST', url: `/api/solicitudes/${solicitudId}/vencimiento`, headers: { cookie },
      payload: { fechaVencimiento: enDias(30) },
    });
    const res = await app.inject({ method: 'POST', url: `/api/solicitudes/${solicitudId}/terminar-revision`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get()!.nroOrden).not.toBeNull();
  });
});
