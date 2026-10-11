import { describe, it, expect, beforeAll } from 'vitest';
import { migrate } from '../db/migrate.js';
import { db, schema } from '../db/client.js';
import { buildServer } from '../server.js';
import { createSession } from '../lib/session.js';

let app: Awaited<ReturnType<typeof buildServer>>;
let cookie = '';

beforeAll(async () => {
  migrate();
  app = await buildServer();
  const u = db.insert(schema.users).values({
    nombre: 'AdminReq', email: `adminreq${Date.now()}@t.com`, passwordHash: 'x', rol: 'ADMIN', activo: true,
  }).returning().get();
  cookie = `sap_session=${createSession(u.id)}`;
});

const crearSolicitud = async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/solicitudes/manual', headers: { cookie },
    payload: {
      localNombre: `REQ SOL SA ${Date.now()}`,
      categoria: 'EMPRESA',
      personas: [{ dni: '30640882', nombreCompleto: 'Perez Juan', categoria: 'EMPRESA' }],
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as any).solicitudId as number;
};

const detalle = async (id: number) => {
  const res = await app.inject({ method: 'GET', url: `/api/solicitudes/${id}`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as any;
};

describe('requisito extra para toda la solicitud (alcance SOLICITUD, como el 931)', () => {
  it('se agrega, aparece como extra obligatorio, cuenta para la autorización, y se quita', async () => {
    const solId = await crearSolicitud();

    // Antes: ningún item es "extra".
    const antes = await detalle(solId);
    expect((antes.solicitudDocs.items as any[]).some((it) => it.esExtra)).toBe(false);
    const personaId = antes.personas[0].personaId as number;

    // Agregar un requisito nuevo (texto libre) para toda la solicitud.
    const add = await app.inject({
      method: 'POST', url: '/api/documentos/requisitos-solicitud', headers: { cookie },
      payload: { solicitudId: solId, nombre: 'Seguro de caución' },
    });
    expect(add.statusCode, add.body).toBe(200);
    const tipoId = (add.json() as any).tipoDocumentoId as number;
    expect(tipoId).toBeGreaterThan(0);

    // Aparece en la documentación de la solicitud, marcado como extra, obligatorio y sin archivo.
    const conReq = await detalle(solId);
    const item = (conReq.solicitudDocs.items as any[]).find((it) => it.tipoId === tipoId);
    expect(item, 'el requisito agregado tiene que verse en la documentación de la solicitud').toBeTruthy();
    expect(item.esExtra).toBe(true);
    expect(item.obligatorio).toBe(true);
    expect(item.presente).toBe(false);
    expect(item.nombre).toBe('Seguro de caución');

    // Cuenta para la autorización: la persona del grupo lo tiene como faltante.
    const persona = conReq.personas.find((p: any) => p.personaId === personaId);
    expect(persona.faltantesTotales, 'el requisito de solicitud cuenta como faltante de la persona')
      .toContain('Seguro de caución');

    // Agregarlo de nuevo por id no lo duplica (onConflictDoNothing).
    const addDup = await app.inject({
      method: 'POST', url: '/api/documentos/requisitos-solicitud', headers: { cookie },
      payload: { solicitudId: solId, tipoDocumentoId: tipoId },
    });
    expect(addDup.statusCode).toBe(200);
    const dup = await detalle(solId);
    expect((dup.solicitudDocs.items as any[]).filter((it) => it.tipoId === tipoId).length).toBe(1);
    expect(db.select().from(schema.requisitosSolicitud).all()
      .filter((r) => r.solicitudId === solId && r.tipoDocumentoId === tipoId).length).toBe(1);

    // Quitarlo: desaparece de la documentación y deja de contar como faltante.
    const del = await app.inject({
      method: 'DELETE', url: `/api/documentos/requisitos-solicitud/${solId}/${tipoId}`, headers: { cookie },
    });
    expect(del.statusCode).toBe(200);
    const despues = await detalle(solId);
    expect((despues.solicitudDocs.items as any[]).some((it) => it.tipoId === tipoId)).toBe(false);
    const personaFinal = despues.personas.find((p: any) => p.personaId === personaId);
    expect(personaFinal.faltantesTotales).not.toContain('Seguro de caución');
  });

  it('un LOCAL no puede agregar requisitos a una solicitud', async () => {
    const solId = await crearSolicitud();
    const local = db.insert(schema.users).values({
      nombre: 'Encargado', email: `local${Date.now()}@t.com`, passwordHash: 'x', rol: 'LOCAL', activo: true,
    }).returning().get();
    const localCookie = `sap_session=${createSession(local.id)}`;
    const res = await app.inject({
      method: 'POST', url: '/api/documentos/requisitos-solicitud', headers: { cookie: localCookie },
      payload: { solicitudId: solId, nombre: 'Algo' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});
