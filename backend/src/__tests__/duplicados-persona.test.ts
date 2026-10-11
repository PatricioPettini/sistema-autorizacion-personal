/**
 * Que la misma persona no entre dos veces.
 *
 * Los duplicados reales de la base salieron casi todos del mismo lugar: alguien la carga una vez
 * con el CUIL y otra con el DNI, y el sistema no las cruza. Cada caso de acá es un par que existe
 * en producción.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { migrate } from '../db/migrate.js';
import { db, schema } from '../db/client.js';
import { findOrCreatePersona, interpretarDocumento, buscarPersonasParecidas } from '../modules/personas/service.js';

beforeAll(() => { migrate(); });

/** Un CUIL válido distinto por test, para no chocar entre casos que comparten la misma base. */
const CUIL_A = '20965726773'; // DNI 96572677 adentro
const CUIL_B = '20479658839'; // DNI 47965883 adentro

describe('la misma persona con el CUIL y con el DNI', () => {
  it('encuentra a quien ya está cargado con el CUIL cuando después llega sólo el DNI', () => {
    // Caso PERALTA: la primera ficha quedó con el CUIL guardado también en el campo DNI, así que
    // buscar sólo por la columna DNI no la encontraba y se creaba una segunda ficha.
    db.insert(schema.personas).values({ cuil: CUIL_A, dni: CUIL_A, nombre: 'Dalia', apellido: 'Sanchez Perez' }).run();

    const { persona, created } = findOrCreatePersona({ dni: '96572677', nombre: 'Dalia', apellido: 'Sanchez Perez' });

    expect(created).toBe(false);
    expect(persona.cuil).toBe(CUIL_A);
  });

  it('no junta a dos personas distintas que declaran CUIL diferentes', () => {
    // La contracara: si la entrada trae SU propio CUIL y no es el de la ficha encontrada, son dos.
    const otro = findOrCreatePersona({ cuil: '27189988112', dni: '18998811', nombre: 'Otra', apellido: 'Persona' });
    expect(otro.persona.cuil).toBe('27189988112');
    expect(otro.persona.id).toBeGreaterThan(0);
  });
});

describe('CUIL al que le falta el dígito verificador', () => {
  it('lo completa calculándolo, no adivinando', () => {
    // Caso GARCIA y CASTILLO: el CUIL llega cortado en 10 dígitos al copiar y pegar.
    const r = interpretarDocumento(CUIL_B.slice(0, 10), '');
    expect(r.cuil).toBe(CUIL_B);
    expect(r.dni).toBe('47965883');
  });

  it('no completa si el prefijo no es de CUIL', () => {
    const r = interpretarDocumento('9912345678', '');
    expect(r.cuil).toBe('');
  });

  it('la persona cargada con el CUIL cortado y con el CUIL entero es la misma', () => {
    const cortado = findOrCreatePersona({ cuil: CUIL_B.slice(0, 10), nombre: 'Juan Jose', apellido: 'Castillo' });
    const entero = findOrCreatePersona({ cuil: CUIL_B, nombre: 'Juan Jose', apellido: 'Castillo' });

    expect(entero.created).toBe(false);
    expect(entero.persona.id).toBe(cortado.persona.id);
  });
});

describe('aviso de parecidos al cargar a mano', () => {
  it('avisa cuando el documento difiere en UN dígito: es la forma del typo', () => {
    // Caso real: 96572677 y 96572673. Ninguna búsqueda por documento puede evitarlo, porque el
    // número tipeado mal existe y es válido. Lo único posible es avisar antes de crear la ficha.
    findOrCreatePersona({ dni: '35009750', nombre: 'Elena', apellido: 'Rivas' });

    const parecidas = buscarPersonasParecidas({ dni: '35009751', nombre: 'Otra', apellido: 'Distinta' });

    expect(parecidas.some((p) => p.dni === '35009750' && p.motivo === 'DOCUMENTO_PARECIDO')).toBe(true);
  });

  it('avisa cuando ya hay alguien con el mismo nombre, aunque esté al revés', () => {
    findOrCreatePersona({ dni: '30982630', nombre: 'Martina', apellido: 'Quispe' });

    const parecidas = buscarPersonasParecidas({ dni: '41945178', nombre: 'Quispe', apellido: 'Martina' });

    expect(parecidas.some((p) => p.dni === '30982630' && p.motivo === 'MISMO_NOMBRE')).toBe(true);
  });

  it('no avisa de la persona que YA es esa: esa la resuelve la búsqueda por documento', () => {
    const { persona } = findOrCreatePersona({ dni: '28131822', nombre: 'Hugo', apellido: 'Ledesma' });

    const parecidas = buscarPersonasParecidas({ dni: '28131822', nombre: 'Hugo', apellido: 'Ledesma' });

    expect(parecidas.some((p) => p.id === persona.id)).toBe(false);
  });

  it('no avisa de cualquiera: sin nombre parecido ni documento cercano, no hay aviso', () => {
    findOrCreatePersona({ dni: '31214377', nombre: 'Bruno', apellido: 'Vera' });

    expect(buscarPersonasParecidas({ dni: '12142532', nombre: 'Zulema', apellido: 'Ibarra' })).toHaveLength(0);
  });
});
