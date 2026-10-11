import { describe, it, expect, beforeAll } from 'vitest';
import { migrate } from '../db/migrate.js';
import { db, schema } from '../db/client.js';
import { buildServer } from '../server.js';
import { createSession } from '../lib/session.js';
import { findPersonaByDocumento } from '../modules/personas/service.js';

let app: Awaited<ReturnType<typeof buildServer>>;
let cookie = '';
const t = `${Date.now()}`.slice(-6);

beforeAll(async () => {
  migrate();
  app = await buildServer();
  const u = db.insert(schema.users).values({
    nombre: 'SeguriDoc', email: `segdoc${t}@t.com`, passwordHash: 'x', rol: 'SEGURIDAD', activo: true,
  }).returning().get();
  cookie = `sap_session=${createSession(u.id)}`;
});

/**
 * Seguridad busca a la persona con el número del documento que le muestran, y ese documento dice
 * el DNI, no el CUIL. Antes la consulta comparaba solo contra la columna `cuil` exacta: con el DNI
 * del documento no encontraba a nadie y había que tipear los 11 dígitos del CUIL.
 */
describe('buscar a una persona por su documento', () => {
  it('encuentra por el DNI que está adentro del CUIL', () => {
    const p = db.insert(schema.personas).values({
      cuil: `2031761${t.slice(-3)}10`.slice(0, 11), dni: `3176${t}`.slice(0, 8), nombre: 'Nestor', apellido: 'Fernandez',
    }).returning().get();
    expect(findPersonaByDocumento(p.cuil!)!.id).toBe(p.id);          // por CUIL completo
    expect(findPersonaByDocumento(p.dni)!.id).toBe(p.id);            // por DNI de la columna
    // Y por el DNI derivado del CUIL, aunque la columna dni tenga otra cosa.
    expect(findPersonaByDocumento(p.cuil!.slice(2, 10))!.id).toBe(p.id);
  });

  it('un DNI de 7 dígitos también, con el cero que el CUIL le pone adelante', () => {
    const p = db.insert(schema.personas).values({
      cuil: '27065432108', dni: `7${t}`.slice(0, 8), nombre: 'Ana', apellido: 'Vieja',
    }).returning().get();
    expect(findPersonaByDocumento('6543210')!.id).toBe(p.id);
  });

  it('acepta el CUIL con guiones y puntos', () => {
    const p = db.insert(schema.personas).values({
      cuil: '20410586250', dni: `41999${t.slice(-3)}`, nombre: 'Con', apellido: 'Formato',
    }).returning().get();
    expect(findPersonaByDocumento('20-41058625-0')!.id).toBe(p.id);
  });

  it('con un número que no existe devuelve null, no cualquier persona', () => {
    expect(findPersonaByDocumento('99999999')).toBeNull();
    expect(findPersonaByDocumento('')).toBeNull();
    expect(findPersonaByDocumento('abc')).toBeNull();
  });

  it('la consulta de la puerta encuentra por DNI', async () => {
    const p = db.insert(schema.personas).values({
      cuil: '20448457683', dni: '44845768', nombre: 'Puerta', apellido: 'Consulta',
    }).returning().get();
    for (const q of ['44845768', '20448457683', '20-44845768-3']) {
      const res = await app.inject({ method: 'GET', url: `/api/ingresos/consulta?q=${encodeURIComponent(q)}`, headers: { cookie } });
      expect(res.statusCode, q).toBe(200);
      const body = res.json() as any;
      expect(body.encontrada, `no encontró con "${q}"`).toBe(true);
      expect(body.persona.id).toBe(p.id);
    }
  });
});

/**
 * Al revés que el caso de arriba: la persona está cargada SOLO con su DNI y se la busca con el
 * CUIL completo. Pasa seguido, porque el CUIL contiene al DNI y cada uno tiene a mano uno distinto.
 */
describe('buscar con el CUIL a alguien cargado solo por DNI', () => {
  it('lo encuentra por los 8 dígitos del medio', () => {
    const p = db.insert(schema.personas).values({
      dni: '31424514', nombre: 'Solo', apellido: 'ConDni',
    }).returning().get();
    expect(p.cuil).toBeFalsy();
    expect(findPersonaByDocumento('20314245149')?.id, 'CUIL válido de ese DNI').toBe(p.id);
  });

  it('con el CUIL mal tipeado no arriesga: no devuelve a nadie', () => {
    db.insert(schema.personas).values({ dni: '31832795', nombre: 'Otro', apellido: 'ConDni' }).run();
    // Mismo medio, verificador inválido: los dígitos del medio no son confiables.
    expect(findPersonaByDocumento('20318327958')).toBeNull();
  });
});
