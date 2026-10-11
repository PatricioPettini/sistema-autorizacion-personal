import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { migrate } from '../db/migrate.js';
import { db, schema } from '../db/client.js';
import { env } from '../config/env.js';
import { purgarEmlViejos } from '../modules/email/reader.js';

beforeAll(() => { migrate(); });

const t = `${Date.now()}`.slice(-7);
let n = 0;

/** Un correo con su .eml en disco, recibido hace `diasAtras` días. */
function correo(diasAtras: number, estado = 'PROCESSED') {
  fs.mkdirSync(env.emailsPath, { recursive: true });
  const ruta = path.join(env.emailsPath, `purga_${t}_${++n}.eml`);
  fs.writeFileSync(ruta, 'From: a@b.com\r\nSubject: x\r\n\r\ncuerpo');
  const fecha = new Date(Date.now() - diasAtras * 86400000).toISOString();
  return db.insert(schema.emailMessages).values({
    messageId: `<purga-${t}-${n}>`, estado, rawStoredPath: ruta, fechaRecibido: fecha, asunto: `correo de hace ${diasAtras} dias`,
  }).returning().get();
}
const fila = (id: number) => db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, id)).get()!;

/**
 * Los .eml son el 97% del almacenamiento y crecen para siempre (~670 MB por mes), mientras que lo
 * que el sistema usa ya está en la base. El original tampoco se pierde: el lector no borra ni mueve
 * nada del buzón.
 */
describe('purga de los .eml viejos', () => {
  it('borra los anteriores a la retención y deja los de adentro', () => {
    const viejo = correo(200);
    const nuevo = correo(10);

    const r = purgarEmlViejos(3);
    expect(r.borrados).toBeGreaterThanOrEqual(1);

    expect(fs.existsSync(viejo.rawStoredPath!), 'el viejo se borra del disco').toBe(false);
    expect(fila(viejo.id).rawStoredPath, 'y se suelta la ruta').toBeNull();
    expect(fs.existsSync(nuevo.rawStoredPath!), 'el reciente no se toca').toBe(true);
  });

  it('la fila del correo se conserva entera: solo se va el archivo', () => {
    const viejo = correo(200);
    purgarEmlViejos(3);
    const f = fila(viejo.id);
    expect(f.asunto).toBe('correo de hace 200 dias');
    expect(f.estado).toBe('PROCESSED');
    expect(f.fechaRecibido).toBeTruthy();
  });

  it('no toca los que están en el respaldo: alguien los tiene que leer', () => {
    const enRespaldo = correo(200, 'NEEDS_REVIEW');
    const conError = correo(200, 'ERROR');
    purgarEmlViejos(3);
    expect(fs.existsSync(enRespaldo.rawStoredPath!)).toBe(true);
    expect(fs.existsSync(conError.rawStoredPath!)).toBe(true);
  });

  it('con retención 0 no borra nada', () => {
    const viejo = correo(500);
    expect(purgarEmlViejos(0)).toEqual({ borrados: 0, mb: 0 });
    expect(fs.existsSync(viejo.rawStoredPath!)).toBe(true);
  });

  it('correrla dos veces no rompe ni cuenta de más', () => {
    correo(200);
    const primera = purgarEmlViejos(3);
    const segunda = purgarEmlViejos(3);
    expect(primera.borrados).toBeGreaterThan(0);
    expect(segunda.borrados, 'ya no queda nada que borrar').toBe(0);
  });
});
