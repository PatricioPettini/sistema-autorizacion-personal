import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { migrate } from '../db/migrate.js';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { env } from '../config/env.js';
import { analizarSolicitud, limpiarCacheAnalisis } from '../modules/ai/analisis-adjuntos.js';

/** Los paréntesis y la barra invertida delimitan cadenas en PDF: hay que sacarlos del texto. */
const quitarParentesis = (l: string) =>
  l.split(String.fromCharCode(92)).join(' ').split('(').join(' ').split(')').join(' ');

/**
 * Un PDF real (chico) con el texto que se le pase. Hace falta uno de verdad porque el análisis lee
 * con pdfjs: un buffer con texto plano y extensión .pdf no se lee, que es justamente el otro caso
 * que se testea acá.
 */
function pdfConTexto(lineas: string[]): Buffer {
  const contenido =
    'BT /F1 11 Tf 40 750 Td ' +
    lineas.map((l) => `(${quitarParentesis(l)}) Tj 0 -14 Td`).join(' ') +
    ' ET';
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${contenido.length}>>\nstream\n${contenido}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Una solicitud con las personas que se le pasen, cada una identificada por su DNI. */
function solicitudCon(gente: { nombre: string; apellido: string; dni: string }[]): number {
  const local = db.insert(schema.locales).values({ nombre: `Local ${Date.now()}${Math.random()}` }).returning().get();
  const sol = db.insert(schema.solicitudes).values({ localId: local.id, estado: 'PENDIENTE' }).returning().get();
  for (const g of gente) {
    // La misma persona puede estar en varias solicitudes: si ya existe, se reusa.
    const p = db.select().from(schema.personas).where(eq(schema.personas.dni, g.dni)).get()
      ?? db.insert(schema.personas).values({ nombre: g.nombre, apellido: g.apellido, dni: g.dni }).returning().get();
    db.insert(schema.solicitudPersonas).values({ solicitudId: sol.id, personaId: p.id }).run();
  }
  return sol.id;
}

const adjunto = (filename: string, content: Buffer, contentType?: string) =>
  ({ emailId: Math.floor(Math.random() * 1e6), index: 0, filename, contentType, content });

beforeAll(() => {
  migrate();
});

afterEach(() => {
  limpiarCacheAnalisis();
  (env as any).analisisAdjuntos = true;
});

describe('lectura de la documentación (etapas 1 y 2)', () => {
  it('reconoce el tipo de documento y cruza a la gente de la solicitud', async () => {
    const solicitudId = solicitudCon([{ nombre: 'Juan Carlos', apellido: 'Perez', dni: '35837051' }]);
    const pdf = pdfConTexto([
      'Aseguradora de Riesgos del Trabajo - certificado de cobertura',
      'Vigencia hasta 24/12/2026',
      'PEREZ, JUAN CARLOS - DNI 35.837.051',
    ]);

    const r = await analizarSolicitud(solicitudId, [adjunto('art.pdf', pdf, 'application/pdf')]);

    expect(r.activo).toBe(true);
    expect(r.adjuntos[0].leido).toBe(true);
    expect(r.adjuntos[0].tipo).toBe('NOMINA_ART');
    expect(r.adjuntos[0].vencimiento).toBe('2026-12-24');
    expect(r.cubiertas.map((c) => c.nombre)).toEqual(['Perez, Juan Carlos']);
    expect(r.sinCubrir).toHaveLength(0);
    expect(r.sinLeer).toBe(0);
  });

  it('sugiere como vigencia el vencimiento más temprano de todos los papeles', async () => {
    const solicitudId = solicitudCon([{ nombre: 'Juan Carlos', apellido: 'Perez', dni: '35837051' }]);
    const art = pdfConTexto(['Aseguradora de Riesgos del Trabajo', 'Vigencia hasta 24/12/2026', 'PEREZ, JUAN CARLOS - DNI 35.837.051']);
    const seguro = pdfConTexto(['Poliza de seguro de vida colectivo suma asegurada', 'Vigencia hasta 30/09/2026']);

    const r = await analizarSolicitud(solicitudId, [
      { emailId: 1, index: 0, filename: 'art.pdf', contentType: 'application/pdf', content: art },
      { emailId: 1, index: 1, filename: 'seguro.pdf', contentType: 'application/pdf', content: seguro },
    ]);

    // La autorización no puede durar más que el papel que se vence primero.
    expect(r.vigenciaSugerida).toMatchObject({ fecha: '2026-09-30', archivos: ['seguro.pdf'] });
  });

  it('no sugiere vigencia si ningún papel trae fecha de vencimiento', async () => {
    const solicitudId = solicitudCon([{ nombre: 'Juan Carlos', apellido: 'Perez', dni: '35837051' }]);
    const pdf = pdfConTexto(['Aseguradora de Riesgos del Trabajo', 'PEREZ, JUAN CARLOS - DNI 35.837.051']);

    const r = await analizarSolicitud(solicitudId, [adjunto('art.pdf', pdf, 'application/pdf')]);

    expect(r.vigenciaSugerida).toBeNull();
  });

  it('descarta el vencimiento cuando es anterior a la emisión (es el inicio, no el fin)', async () => {
    const solicitudId = solicitudCon([{ nombre: 'Juan Carlos', apellido: 'Perez', dni: '35837051' }]);
    // Como vienen muchos certificados de ART: la fecha de "vigencia" es cuándo arranca la
    // afiliación. Leerla como vencimiento hacía aparecer papeles de 2026 vencidos en 2023.
    const pdf = pdfConTexto([
      'Aseguradora de Riesgos del Trabajo - certificado de cobertura',
      'Fecha de emision 01/09/2026',
      'Vigencia 01/09/2023',
      'PEREZ, JUAN CARLOS - DNI 35.837.051',
    ]);

    const r = await analizarSolicitud(solicitudId, [adjunto('art.pdf', pdf, 'application/pdf')]);

    expect(r.adjuntos[0].emision).toBe('2026-09-01');
    expect(r.adjuntos[0].vencimiento).toBeNull();
    expect(r.adjuntos[0].nota).toMatch(/inicio, no el vencimiento/);
    expect(r.vigenciaSugerida).toBeNull();
  });

  it('avisa quién de la solicitud no aparece en ningún papel, y quién aparece sin estar', async () => {
    const solicitudId = solicitudCon([
      { nombre: 'Juan Carlos', apellido: 'Perez', dni: '35837051' },
      { nombre: 'Ana Maria', apellido: 'Rodriguez', dni: '28325473' },
    ]);
    const pdf = pdfConTexto([
      'Aseguradora de Riesgos del Trabajo - certificado de cobertura',
      'PEREZ, JUAN CARLOS - DNI 35.837.051',
      'GOMEZ, PEDRO - DNI 30.640.882',
    ]);

    const r = await analizarSolicitud(solicitudId, [adjunto('art.pdf', pdf, 'application/pdf')]);

    expect(r.cubiertas.map((c) => c.nombre)).toEqual(['Perez, Juan Carlos']);
    expect(r.sinCubrir.map((c) => c.nombre)).toEqual(['Rodriguez, Ana Maria']);
    expect(r.ajenas.map((a) => a.dni)).toEqual(['30640882']);
  });

  it('dice que no pudo leer en lugar de inventar (escaneo o archivo que no es PDF)', async () => {
    const solicitudId = solicitudCon([{ nombre: 'Juan Carlos', apellido: 'Perez', dni: '35837051' }]);

    const r = await analizarSolicitud(solicitudId, [
      adjunto('escaneo.pdf', Buffer.from('esto no es un PDF de verdad'), 'application/pdf'),
      adjunto('foto.jpg', Buffer.from('bytes'), 'image/jpeg'),
    ]);

    expect(r.adjuntos.every((a) => !a.leido)).toBe(true);
    expect(r.adjuntos.every((a) => a.nota !== null)).toBe(true);
    expect(r.sinLeer).toBe(2);
    expect(r.sinCubrir).toHaveLength(1); // no se cubre a nadie con lo que no se pudo leer
  });

  it('con ANALISIS_ADJUNTOS=0 no analiza nada y la pantalla vuelve a lo de antes', async () => {
    (env as any).analisisAdjuntos = false;
    const solicitudId = solicitudCon([{ nombre: 'Juan Carlos', apellido: 'Perez', dni: '35837051' }]);
    const pdf = pdfConTexto(['Aseguradora de Riesgos del Trabajo', 'PEREZ, JUAN CARLOS - DNI 35.837.051']);

    const r = await analizarSolicitud(solicitudId, [adjunto('art.pdf', pdf, 'application/pdf')]);

    expect(r.activo).toBe(false);
    expect(r.adjuntos).toHaveLength(0);
    expect(r.cubiertas).toHaveLength(0);
    expect(r.sinCubrir).toHaveLength(0);
  });
});
