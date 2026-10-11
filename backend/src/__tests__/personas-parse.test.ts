import { describe, it, expect, beforeAll } from 'vitest';
import { migrate } from '../db/migrate.js';
import { filasAPersonas, pareceFecha } from '../lib/xlsx.js';
import { parsePersonasFromBody } from '../modules/processing/body-table.js';
import { splitNombreCompleto, findOrCreatePersona, findPersonaByCuil } from '../modules/personas/service.js';

beforeAll(() => { migrate(); });

describe('filasAPersonas — formatos de planilla', () => {
  it('columna "PERSONAL" con columna de número de orden: no toma el número como nombre', () => {
    const rows = [
      ['', 'CUIL', 'PERSONAL'],
      ['1', '27-38066308-8', 'CARDOZO, Tatiana'],
      ['2', '20-34843729-2', 'MIRANDA, Yamila'],
    ];
    const per = filasAPersonas(rows);
    expect(per.length).toBe(2);
    expect(per[0].nombreCompleto).toBe('CARDOZO, Tatiana');
    expect(per[0].cuil).toBe('27380663088');
  });

  it('encabezado combinado "NOMBRE Y APELLIDO"', () => {
    const rows = [['CUIL', 'NOMBRE Y APELLIDO'], ['20-34843729-2', 'MIRANDA, Yamila']];
    const per = filasAPersonas(rows);
    expect(per).toEqual([{ cuil: '20348437292', nombreCompleto: 'MIRANDA, Yamila' }]);
  });

  it('dos columnas separadas Apellido + Nombre', () => {
    const rows = [['CUIL', 'Apellido', 'Nombre'], ['20-34843729-2', 'Miranda', 'Yamila']];
    const per = filasAPersonas(rows);
    expect(per[0].apellido).toBe('Miranda');
    expect(per[0].nombre).toBe('Yamila');
  });
});

describe('splitNombreCompleto', () => {
  it('formato "Apellido, Nombre"', () => {
    expect(splitNombreCompleto('CARDOZO, Tatiana')).toEqual({ apellido: 'CARDOZO', nombre: 'Tatiana' });
  });
  it('apellido en MAYÚSCULAS al inicio', () => {
    expect(splitNombreCompleto('MARQUEZ ESTEBAN Antonio')).toEqual({ apellido: 'MARQUEZ ESTEBAN', nombre: 'Antonio' });
  });
  it('formato simple "Nombre Apellido"', () => {
    expect(splitNombreCompleto('Juan Perez')).toEqual({ nombre: 'Juan', apellido: 'Perez' });
  });
});

describe('findOrCreatePersona — corrige nombres placeholder al reimportar', () => {
  it('actualiza el nombre "(a completar)" cuando llega el real', () => {
    const cuil = '20-33914266-0';
    const a = findOrCreatePersona({ cuil, nombre: '(a completar)', apellido: '(a completar)' });
    expect(a.created).toBe(true);
    const b = findOrCreatePersona({ cuil, nombre: 'Yamila', apellido: 'Miranda' });
    expect(b.created).toBe(false);
    expect(b.persona.nombre).toBe('Yamila');
    expect(b.persona.apellido).toBe('Miranda');
    expect(findPersonaByCuil(cuil)!.nombre).toBe('Yamila');
  });

  it('no pisa un nombre real ya cargado', () => {
    const cuil = '20-33583849-5';
    findOrCreatePersona({ cuil, nombre: 'Ana', apellido: 'Lopez' });
    const b = findOrCreatePersona({ cuil, nombre: 'OTRO', apellido: 'DISTINTO' });
    expect(b.persona.nombre).toBe('Ana');
    expect(b.persona.apellido).toBe('Lopez');
  });
});

/**
 * Caso real (BurgerSur, 04/09): el correo informaba el cronograma de visitas de su consultora en
 * una tabla "Fecha | Locales". No hay columna de documento, así que el lector cayó en "la columna
 * de ID es la que más valores tipo CUIL/DNI tiene", y "Jue 03/09/2026" sin los separadores queda
 * 03092026: ocho dígitos, un DNI perfecto. Se dieron de alta 5 personas llamadas "BK Campana",
 * "BK Wilde"… con las fechas como documento.
 */
describe('una tabla que no es una nómina', () => {
  const CRONOGRAMA = `<table>
    <tr><th>Fecha</th><th>Locales</th></tr>
    <tr><td>Jue 03/09/2026</td><td>BK Campana</td></tr>
    <tr><td></td><td>BK Escobar</td></tr>
    <tr><td></td><td>BK Mall del Lago</td></tr>
    <tr><td>Vie 04/09/2026</td><td>BK Plaza del Sur</td></tr>
    <tr><td>Lun 07/09/2026</td><td>BK Wilde</td></tr>
    <tr><td>Mar 08/09/2026</td><td>BK Paseo Central</td></tr>
    <tr><td>Jue 10/09/2026</td><td>BK Ballester</td></tr>
  </table>`;

  it('un cronograma de fechas no da personas', () => {
    expect(parsePersonasFromBody(CRONOGRAMA, undefined)).toEqual([]);
  });

  it('tampoco leyéndolo como texto plano', () => {
    expect(parsePersonasFromBody(undefined, 'Jue 03/09/2026  BK Campana\nVie 04/09/2026  BK Wilde\n')).toEqual([]);
  });

  it('una nómina de verdad sigue funcionando', () => {
    const nomina = `<table>
      <tr><th>CUIL</th><th>Nombre y Apellido</th></tr>
      <tr><td>20-33163078-1</td><td>Perez Juan</td></tr>
      <tr><td>27-38066308-8</td><td>Gomez Ana</td></tr>
    </table>`;
    const r = parsePersonasFromBody(nomina, undefined);
    expect(r.length).toBe(2);
    expect(r[0].cuil).toBe('20331630781');
  });

  it('una nómina con fecha de nacimiento no confunde la columna', () => {
    const nomina = `<table>
      <tr><th>DNI</th><th>Nombre completo</th><th>Fecha de nacimiento</th></tr>
      <tr><td>33163078</td><td>Perez Juan</td><td>05/07/1988</td></tr>
    </table>`;
    const r = parsePersonasFromBody(nomina, undefined);
    expect(r.length).toBe(1);
    expect(r[0].dni).toBe('33163078');
  });
});

describe('pareceFecha', () => {
  it('reconoce las fechas con separadores', () => {
    for (const v of ['Jue 03/09/2026', '2026-09-03', '03.09.2026', '3/9/26', '10 / 09 / 2026']) {
      expect(pareceFecha(v), v).toBe(true);
    }
  });

  it('no toma por fecha un documento', () => {
    for (const v of ['12.345.678', '20-33163078-1', '33163078', '27407006645', '1.234.567']) {
      expect(pareceFecha(v), v).toBe(false);
    }
  });
});
