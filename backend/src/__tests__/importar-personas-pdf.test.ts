import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { migrate } from '../db/migrate.js';
import { db, schema } from '../db/client.js';
import { env } from '../config/env.js';
import { buildServer } from '../server.js';
import { createSession } from '../lib/session.js';

let app: Awaited<ReturnType<typeof buildServer>>;
let cookie = '';

/** Los paréntesis y la barra invertida delimitan cadenas en PDF: hay que sacarlos del texto. */
const quitarParentesis = (l: string) =>
  l.split(String.fromCharCode(92)).join(' ').split('(').join(' ').split(')').join(' ');

/** Un PDF real con el texto que se le pase (hace falta de verdad: el lector usa pdfjs). */
function pdfConTexto(lineas: string[]): Buffer {
  const nl = String.fromCharCode(10);
  const contenido = 'BT /F1 11 Tf 40 750 Td ' +
    lineas.map((l) => `(${quitarParentesis(l)}) Tj 0 -14 Td`).join(' ') + ' ET';
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${contenido.length}>>${nl}stream${nl}${contenido}${nl}endstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let pdf = `%PDF-1.4${nl}`;
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj${nl}${o}${nl}endobj${nl}`; });
  const xref = pdf.length;
  pdf += `xref${nl}0 ${objs.length + 1}${nl}0000000000 65535 f ${nl}`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n ${nl}`;
  pdf += `trailer${nl}<</Size ${objs.length + 1}/Root 1 0 R>>${nl}startxref${nl}${xref}${nl}%%EOF${nl}`;
  return Buffer.from(pdf, 'latin1');
}

/** Una solicitud cuyo correo trae una nómina en PDF. */
function solicitudConPdf(lineas: string[]): number {
  const crlf = String.fromCharCode(13) + String.fromCharCode(10);
  const b = '----lim';
  const mid = `<imp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test>`;
  const partes = [
    `Message-ID: ${mid}`, 'From: Local Imp <imp@test.com>', 'Subject: FAO',
    'Date: Thu, 18 Sep 2026 10:00:00 -0300', 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: text/plain; charset=utf-8', '', 'Adjunto la nomina.',
    `--${b}`, 'Content-Type: application/pdf; name="nomina.pdf"',
    'Content-Disposition: attachment; filename="nomina.pdf"', 'Content-Transfer-Encoding: base64', '',
    pdfConTexto(lineas).toString('base64'),
    `--${b}--`, '',
  ];
  fs.mkdirSync(env.emailsPath, { recursive: true });
  const raw = path.join(env.emailsPath, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.eml`);
  fs.writeFileSync(raw, partes.join(crlf));
  const email = db.insert(schema.emailMessages).values({
    messageId: mid, remitente: 'imp@test.com', asunto: 'FAO', estado: 'RECEIVED', rawStoredPath: raw,
  }).returning().get();
  const local = db.insert(schema.locales).values({ nombre: `Local Imp ${Date.now()}${Math.random()}` }).returning().get();
  return db.insert(schema.solicitudes).values({
    localId: local.id, estado: 'PENDIENTE', emailMessageId: email.id,
  }).returning().get().id;
}

const NOMINA = [
  'Aseguradora de Riesgos del Trabajo - certificado de cobertura',
  'CUIL Apellido y Nombres',
  '20337916512 LOPEZ DIEGO EMILIANO',
  '27301105318 HERNANDEZ GABRIELA SABRINA',
];

beforeAll(async () => {
  migrate();
  app = await buildServer();
  const u = db.insert(schema.users).values({
    nombre: 'AdminImp', email: `imp${Date.now()}@t.com`, passwordHash: 'x', rol: 'ADMIN', activo: true,
  }).returning().get();
  cookie = `sap_session=${createSession(u.id)}`;
});

const detectar = async (solicitudId: number) => {
  const res = await app.inject({ method: 'GET', url: `/api/emails/solicitud/${solicitudId}/personas-detectadas`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as { detectadas: any[]; nuevas: number };
};

const personasDe = (solicitudId: number) =>
  db.select({ dni: schema.personas.dni, nombre: schema.personas.nombre, apellido: schema.personas.apellido })
    .from(schema.solicitudPersonas)
    .innerJoin(schema.personas, eq(schema.personas.id, schema.solicitudPersonas.personaId))
    .where(eq(schema.solicitudPersonas.solicitudId, solicitudId)).all();

const importar = (solicitudId: number, personas: unknown[]) =>
  app.inject({
    method: 'POST', url: `/api/solicitudes/${solicitudId}/personas/importar`, headers: { cookie },
    payload: { personas },
  });

describe('importar personas leídas de un PDF', () => {
  it('lee la nómina del PDF y las agrega cuando se confirman', async () => {
    const solicitudId = solicitudConPdf(NOMINA);

    const { detectadas, nuevas } = await detectar(solicitudId);
    expect(detectadas.map((d) => d.dni).sort()).toEqual(['30110531', '33791651']);
    expect(nuevas).toBe(2);
    expect(detectadas.every((d) => d.yaEsta === false)).toBe(true);
    expect(detectadas[0].archivo).toBe('nomina.pdf');

    const res = await importar(solicitudId, detectadas.map((d) => ({ dni: d.dni, nombre: d.nombre, apellido: d.apellido })));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ agregadas: 2, salteadas: 0 });
    expect(personasDe(solicitudId)).toHaveLength(2);
  });

  it('marca las que ya están y no las duplica si se importa de nuevo', async () => {
    const solicitudId = solicitudConPdf(NOMINA);
    const primera = await detectar(solicitudId);
    await importar(solicitudId, primera.detectadas.map((d) => ({ dni: d.dni, nombre: d.nombre, apellido: d.apellido })));

    // Al volver a abrir el importador, las dos figuran como ya cargadas.
    const segunda = await detectar(solicitudId);
    expect(segunda.nuevas).toBe(0);
    expect(segunda.detectadas.every((d) => d.yaEsta)).toBe(true);

    // Y si igual se mandan, se saltean en vez de duplicar.
    const res = await importar(solicitudId, segunda.detectadas.map((d) => ({ dni: d.dni, nombre: d.nombre, apellido: d.apellido })));
    expect(res.json()).toMatchObject({ agregadas: 0, salteadas: 2 });
    expect(personasDe(solicitudId)).toHaveLength(2);
  });

  it('no inventa el nombre que el PDF no dice', async () => {
    const solicitudId = solicitudConPdf([
      'Aseguradora de Riesgos del Trabajo',
      'CUIL Apellido y Nombres',
      '23233789461 PAREDES LEONARDO GABRIEL',
      '23414348505 SANCHEZ ANAH-',
    ]);
    const { detectadas } = await detectar(solicitudId);
    const cortada = detectadas.find((d) => d.dni === '41434850');
    expect(cortada).toBeDefined();
    // Viene vacía para que la complete el que revisa, no con el nombre del anterior.
    expect(cortada!.apellido).toBeNull();
    expect(cortada!.nombre).toBeNull();
  });

  it('exige nombre: no deja entrar una persona sin identificar', async () => {
    const solicitudId = solicitudConPdf(NOMINA);
    const res = await importar(solicitudId, [{ dni: '33791651', nombre: '', apellido: '' }]);
    expect(res.statusCode).toBe(400);
    expect(personasDe(solicitudId)).toHaveLength(0);
  });
});
