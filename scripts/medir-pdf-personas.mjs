// ¿Lo que el lector saca de los PDF coincide con la gente que realmente quedó cargada?
//
// Es la prueba de fuego del importador: no alcanza con que "detecte personas", tienen que ser LAS
// personas de esa solicitud, y con el nombre bien. Mide tres cosas por separado:
//
//   - aciertos: el documento está y la persona también
//   - de más:   el lector propone a alguien que no está en la solicitud (ruido o gente ajena)
//   - faltan:   la persona está cargada y el lector no la vio
//
// Y sobre los aciertos, si el APELLIDO coincide: un DNI bien con el nombre de otro es peor que no
// detectarlo, porque se importa sin que nadie lo note.
//
// Sólo lectura. Uso:  node scripts/medir-pdf-personas.mjs [--detalle N]

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { extractPdfText } from '../backend/dist/modules/ocr/service.js';
import { extractPeople } from '../backend/dist/modules/ai/classifier.js';

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const DETALLE = Number(arg('--detalle') ?? 10);

const storage = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const db = new Database(path.join(storage, 'data', 'sistema.db'), { readonly: true });

const solicitudes = db.prepare(`
  SELECT s.id, s.nro_orden AS nro, l.nombre AS local, e.raw_stored_path AS raw
  FROM solicitudes s JOIN locales l ON l.id = s.local_id
  JOIN email_messages e ON e.id = s.email_message_id
  WHERE e.raw_stored_path IS NOT NULL ORDER BY s.id DESC
`).all();

const personasDe = db.prepare(`
  SELECT p.dni, p.cuil, p.apellido, p.nombre FROM solicitud_personas sp
  JOIN personas p ON p.id = sp.persona_id WHERE sp.solicitud_id = ?
`);

const soloDig = (v) => String(v ?? '').replace(/\D/g, '');
function claveDni(p) {
  const dni = soloDig(p.dni).replace(/^0+/, '');
  if (dni.length >= 7 && dni.length <= 8) return dni;
  const cuil = soloDig(p.cuil ?? p.dni);
  if (cuil.length === 11) return cuil.slice(2, 10).replace(/^0+/, '');
  return null;
}
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').trim();

/** El apellido se compara por palabras: las fichas mezclan "Gonzalez, Rodrigo" y "Rodrigo Gonzalez". */
function mismoApellido(a, b) {
  const pa = new Set(norm(a).split(/\s+/).filter((w) => w.length >= 3));
  const pb = norm(b).split(/\s+/).filter((w) => w.length >= 3);
  return pb.some((w) => pa.has(w));
}

const r = { solicitudes: 0, cargadas: 0, aciertos: 0, deMas: 0, faltan: 0, nombreOk: 0, nombreMal: 0, sinNombre: 0 };
const peores = [];

for (const s of solicitudes) {
  if (!fs.existsSync(s.raw)) continue;
  let parsed;
  try { parsed = await simpleParser(fs.readFileSync(s.raw)); } catch { continue; }

  const cargadas = personasDe.all(s.id).map((p) => ({ ...p, k: claveDni(p) })).filter((p) => p.k);
  if (cargadas.length === 0) continue;
  r.solicitudes++;
  r.cargadas += cargadas.length;

  const detectadas = new Map();
  for (const a of parsed.attachments ?? []) {
    const nombre = a.filename ?? '';
    if (a.contentDisposition === 'inline') continue;
    if (!/\.pdf$/i.test(nombre) && !/pdf/i.test(a.contentType ?? '')) continue;
    const t = await extractPdfText(a.content);
    if (!t.ok || !t.text) continue;
    for (const g of extractPeople(t.text)) {
      const k = g.dni.replace(/^0+/, '');
      if (!detectadas.has(k)) detectadas.set(k, { ...g, archivo: nombre });
    }
  }

  const cargadasPorK = new Map(cargadas.map((p) => [p.k, p]));
  let aciertos = 0, malos = 0;
  for (const [k, g] of detectadas) {
    const p = cargadasPorK.get(k);
    if (!p) { r.deMas++; continue; }
    aciertos++; r.aciertos++;
    // La ficha guarda apellido y nombre; el lector puede haberlos leído al revés o de otra fila.
    const esperado = `${p.apellido} ${p.nombre}`;
    const leido = `${g.apellido ?? ''} ${g.nombre ?? ''}`.trim();
    if (!leido) r.sinNombre++;
    else if (mismoApellido(esperado, leido)) r.nombreOk++;
    else { r.nombreMal++; malos++; }
  }
  const faltan = cargadas.filter((p) => !detectadas.has(p.k)).length;
  r.faltan += faltan;

  if (malos > 0 || (detectadas.size > 0 && aciertos === 0)) {
    peores.push({
      nro: s.nro ?? `#${s.id}`, local: s.local,
      cargadas: cargadas.length, detectadas: detectadas.size, aciertos, malos,
      ejemplos: [...detectadas.values()].slice(0, 4)
        .map((g) => `${g.dni} ${g.apellido ?? '-'} ${g.nombre ?? '-'}`).join(' | '),
    });
  }
}

const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`);

console.log(`Solicitudes comparadas: ${r.solicitudes} · personas cargadas en total: ${r.cargadas}`);
console.log('\n--- ¿Encuentra a la gente de la solicitud? ---');
console.log(`  aciertos (está en el PDF y en la solicitud): ${r.aciertos}  (${pct(r.aciertos, r.cargadas)} de las cargadas)`);
console.log(`  faltan   (cargada y el lector no la vio):    ${r.faltan}  (${pct(r.faltan, r.cargadas)})`);
console.log(`  de más   (propone a alguien que no está):    ${r.deMas}`);

console.log('\n--- De los aciertos, ¿el nombre está bien? ---');
console.log(`  apellido correcto: ${r.nombreOk}  (${pct(r.nombreOk, r.aciertos)})`);
console.log(`  apellido de OTRA persona: ${r.nombreMal}  (${pct(r.nombreMal, r.aciertos)})   <- lo grave`);
console.log(`  sin nombre (queda para completar a mano): ${r.sinNombre}  (${pct(r.sinNombre, r.aciertos)})`);

console.log(`\n--- Solicitudes con nombres cruzados o sin un solo acierto (primeras ${DETALLE}) ---`);
for (const p of peores.slice(0, DETALLE)) {
  console.log(`  ${p.nro} · ${p.local}: cargadas ${p.cargadas} · detectadas ${p.detectadas} · aciertos ${p.aciertos} · nombres cruzados ${p.malos}`);
  console.log(`      ${p.ejemplos}`);
}
