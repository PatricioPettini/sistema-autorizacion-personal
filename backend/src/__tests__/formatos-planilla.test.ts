/**
 * Qué formatos de planilla acepta el sistema, y dónde está el límite.
 *
 * Los encargados mandan la nómina como se les ocurre: el documento adelante o atrás, el nombre en
 * una columna o en dos, con columnas de sobra. Este archivo fija lo que se acepta hoy, para que un
 * cambio en el lector no rompa en silencio el formato que ya usa alguno de los locales.
 */
import { describe, it, expect } from 'vitest';
import { filasAPersonas } from '../lib/xlsx.js';
import { splitNombreCompleto } from '../modules/personas/service.js';
import { parsePersonasFromBody } from '../modules/processing/body-table.js';

const casos: [string, string[][]][] = [
  ['CUIL primero, después el nombre',        [['CUIL','Nombre y Apellido'], ['20-33163078-1','Perez Juan']]],
  ['nombre primero, después el CUIL',        [['Nombre y Apellido','CUIL'], ['Perez Juan','20-33163078-1']]],
  ['DNI en vez de CUIL',                     [['DNI','Nombre completo'], ['33163078','Perez Juan']]],
  ['columna "Documento"',                    [['Documento','Nombre'], ['33163078','Perez Juan']]],
  ['Nombre y Apellido en dos columnas',      [['CUIL','Nombre','Apellido'], ['20-33163078-1','Juan','Perez']]],
  ['Apellido y Nombre en dos columnas',      [['CUIL','Apellido','Nombre'], ['20-33163078-1','Perez','Juan']]],
  ['el documento en el medio',               [['Apellido','DNI','Nombre'], ['Perez','33163078','Juan']]],
  ['el documento último',                    [['Apellido','Nombre','CUIL'], ['Perez','Juan','20-33163078-1']]],
  ['columna de orden adelante',              [['N°','CUIL','Nombre y Apellido'], ['1','20-33163078-1','Perez Juan']]],
  ['columnas de sobra',                      [['Local','CUIL','Nombre completo','Ingreso'], ['BK','20-33163078-1','Perez Juan','08:00']]],
  ['encabezado en minúsculas',               [['cuil','nombre y apellido'], ['20-33163078-1','Perez Juan']]],
  ['encabezado "Personal"',                  [['DNI','Personal'], ['33163078','Perez Juan']]],
  ['fila de título antes del encabezado',    [['NOMINA DE PERSONAL'], ['CUIL','Nombre y Apellido'], ['20-33163078-1','Perez Juan']]],
  ['sin encabezado',                         [['20-33163078-1','Perez Juan']]],
];

describe('formatos de tabla aceptados', () => {
  for (const [nombre, rows] of casos) {
    it(nombre, () => {
      const r = filasAPersonas(rows);
      expect(r.length, `${nombre}: no leyó ninguna persona`).toBe(1);
      const doc = (r[0].cuil ?? r[0].dni ?? '').replace(/\D/g, '');
      expect(['20331630781', '33163078'], `${nombre}: documento ${doc}`).toContain(doc);
      const texto = `${r[0].nombreCompleto ?? ''} ${r[0].nombre ?? ''} ${r[0].apellido ?? ''}`.toLowerCase();
      expect(texto, `${nombre}: no aparece el apellido`).toContain('perez');
      expect(texto, `${nombre}: no aparece el nombre`).toContain('juan');
    });
  }
});

describe('cómo parte un nombre completo', () => {
  const nombres: [string, string, string][] = [
    ['Perez, Juan',            'Juan',   'Perez'],
    ['Juan Perez',             'Juan',   'Perez'],
    ['PEREZ Juan',             'Juan',   'PEREZ'],
    ['MARQUEZ ESTEBAN Antonio','Antonio','MARQUEZ ESTEBAN'],
    ['Juan Carlos Perez',      'Juan',   'Carlos Perez'],
  ];
  for (const [full, nombre, apellido] of nombres) {
    it(`"${full}" -> nombre "${nombre}", apellido "${apellido}"`, () => {
      expect(splitNombreCompleto(full)).toEqual({ nombre, apellido });
    });
  }
});

/** El mismo lector se usa para la tabla del CUERPO del mail: mismos formatos, mismas reglas. */
describe('la misma tabla, pero en el cuerpo del mail', () => {
  const tabla = (encabezados: string[], fila: string[]) =>
    `<table><tr>${encabezados.map((h) => `<th>${h}</th>`).join('')}</tr><tr>${fila.map((c) => `<td>${c}</td>`).join('')}</tr></table>`;

  it('CUIL primero', () => {
    const r = parsePersonasFromBody(tabla(['CUIL', 'Nombre y Apellido'], ['20-33163078-1', 'Perez Juan']), undefined);
    expect(r.length).toBe(1);
    expect(r[0].cuil).toBe('20331630781');
  });

  it('nombre primero y el documento al final', () => {
    const r = parsePersonasFromBody(tabla(['Apellido', 'Nombre', 'DNI'], ['Perez', 'Juan', '33163078']), undefined);
    expect(r.length).toBe(1);
    expect(r[0].dni).toBe('33163078');
    expect(`${r[0].nombre} ${r[0].apellido}`).toBe('Juan Perez');
  });

  it('lista en texto plano, una persona por línea', () => {
    const r = parsePersonasFromBody(undefined, '20-33163078-1 Perez Juan\n27-38066308-8 Gomez Ana\n');
    expect(r.length).toBe(2);
  });

  it('en texto plano el documento puede ir después del nombre', () => {
    const r = parsePersonasFromBody(undefined, 'Perez Juan 33163078\n');
    expect(r.length).toBe(1);
    expect(r[0].dni).toBe('33163078');
  });
});

/** Dónde está el límite: sin documento no hay persona que autorizar. */
describe('lo que NO se acepta', () => {
  it('una tabla de nombres sin documento no da personas', () => {
    expect(filasAPersonas([['Nombre y Apellido'], ['Perez Juan'], ['Gomez Ana']])).toEqual([]);
  });

  it('un documento de menos de 7 dígitos se descarta', () => {
    expect(filasAPersonas([['DNI', 'Nombre'], ['12345', 'Perez Juan']])).toEqual([]);
  });
});

describe('encabezado lejos del principio', () => {
  /**
   * Caso real (AROMA, septiembre 2026): la planilla arranca con 30 filas de instrucciones y texto
   * legal, y recien en la fila 34 aparece "DNI | APELLIDO | NOMBRE". Buscando el encabezado solo en
   * las primeras filas, las personas salian con el DNI bien y el nombre VACIO.
   */
  const instrucciones = Array.from({ length: 34 }, (_, i) => [`aviso ${i}`, '', '', '', '']);
  const planilla = [
    ...instrucciones,
    ['', 'DNI', 'APELLIDO', 'NOMBRE', 'ART'],
    ['', '96648330', 'BLANCO', 'MIGUEL', 'PARANA SEGUROS'],
    ['', '93984035', 'MOLINA ORTEGA', 'GONZALO ALEXIS', 'PARANA SEGUROS'],
    ['', '', '', '', ''],
  ];

  it('encuentra el encabezado aunque este en la fila 34', () => {
    const p = filasAPersonas(planilla);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ dni: '96648330', apellido: 'BLANCO', nombre: 'MIGUEL' });
    expect(p[1]).toMatchObject({ dni: '93984035', nombre: 'GONZALO ALEXIS' });
  });

  it('prefiere el encabezado que ademas tiene columna de nombre', () => {
    // La palabra "DNI" aparece suelta en una instruccion antes de la tabla de verdad.
    const conRuido = [
      ['Completar el DNI de cada persona', '', ''],
      ['', '', ''],
      ['DNI', 'APELLIDO', 'NOMBRE'],
      ['33163078', 'PEREZ', 'JUAN'],
    ];
    const p = filasAPersonas(conRuido);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ dni: '33163078', apellido: 'PEREZ', nombre: 'JUAN' });
  });
});

describe('la etiqueta del documento se repite en cada fila', () => {
  /**
   * Caso real (Deporte Centro): sin encabezado, con la palabra "CUIT" repetida como etiqueta en cada
   * fila. El lector se quedaba con esa columna de etiquetas, que no tiene ningun numero, y leia
   * CERO personas de doce.
   */
  const planilla = [
    ['NOMINA ', '', ''],
    ['BENITEZ PABLO RODOLFO', 'CUIT', '23-29156865-3'],
    ['CABRERA TOMAS ROBERTO', 'CUIT', '20-24698361-6'],
    ['GIMENEZ MARIA CELESTE', 'CUIT', '23-25084596-0'],
  ];

  it('descarta la columna de la etiqueta y busca los documentos por contenido', () => {
    const p = filasAPersonas(planilla);
    expect(p).toHaveLength(3);
    expect(p[0]).toMatchObject({ cuil: '23291568653', nombreCompleto: 'BENITEZ PABLO RODOLFO' });
    expect(p[2]).toMatchObject({ cuil: '23250845960', nombreCompleto: 'GIMENEZ MARIA CELESTE' });
  });
});
