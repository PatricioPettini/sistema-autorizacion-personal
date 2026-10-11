// ¿De qué documento sale la "Vigencia hasta" que se carga a mano?
//
// Para cada solicitud que tiene fecha de vencimiento cargada, lee los PDF de sus correos, extrae el
// vencimiento de cada papel y ve cuál coincide con la fecha que puso el administrador. Es la forma
// de contestar con datos "¿en base a qué documento se pone la fecha?" sin depender de la memoria.
//
// Sólo lectura. Uso:  node scripts/de-donde-sale-la-vigencia.mjs
// En Fly:  fly ssh console -C "node /app/scripts/de-donde-sale-la-vigencia.mjs"

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { extractPdfText } from '../backend/dist/modules/ocr/service.js';
import { classifyDocument, extractVencimiento, extractEmision } from '../backend/dist/modules/ai/classifier.js';

const storage = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const db = new Database(path.join(storage, 'data', 'sistema.db'), { readonly: true });

const solicitudes = db.prepare(`
  SELECT s.id, s.nro_orden AS nro, s.fecha_vencimiento AS venc, e.raw_stored_path AS raw
  FROM solicitudes s
  JOIN email_messages e ON e.id = s.email_message_id
  WHERE s.fecha_vencimiento IS NOT NULL AND e.raw_stored_path IS NOT NULL
  ORDER BY s.id DESC
`).all();

const esPdf = (n, ct) => /\.pdf$/i.test(n ?? '') || /pdf/i.test(ct ?? '');

const coincidePorTipo = new Map();   // tipo -> cuántas veces la fecha del admin salió de ese tipo
const sumar = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

let conVencLeido = 0, sinNingunVenc = 0, noCoincideConNinguno = 0;
const detalle = [];

for (const s of solicitudes) {
  if (!fs.existsSync(s.raw)) continue;
  let parsed;
  try { parsed = await simpleParser(fs.readFileSync(s.raw)); } catch { continue; }

  const papeles = [];
  for (const a of parsed.attachments ?? []) {
    if (a.contentDisposition === 'inline') continue;
    if (!esPdf(a.filename, a.contentType)) continue;
    const t = await extractPdfText(a.content);
    if (!t.ok || !t.text) continue;
    const emi = extractEmision(t.text);
    let v = extractVencimiento(t.text);
    if (v && emi && v < emi) v = null; // es la fecha de inicio, no el vencimiento
    if (v) papeles.push({ tipo: classifyDocument(t.text, a.filename ?? '').codigo ?? '(sin reconocer)', venc: v, archivo: a.filename });
  }

  if (papeles.length === 0) { sinNingunVenc++; continue; }
  conVencLeido++;

  const iguales = papeles.filter((p) => p.venc === s.venc);
  if (iguales.length === 0) {
    noCoincideConNinguno++;
    const masTemprano = papeles.map((p) => p.venc).sort()[0];
    detalle.push(`  ${s.nro ?? `#${s.id}`}: el admin puso ${s.venc}; los papeles dicen ${[...new Set(papeles.map((p) => p.venc))].sort().join(', ')} (el más temprano: ${masTemprano})`);
    continue;
  }
  for (const tipo of new Set(iguales.map((p) => p.tipo))) sumar(coincidePorTipo, tipo);
}

console.log(`Solicitudes con "Vigencia hasta" cargada y .eml en disco: ${solicitudes.length}`);
console.log(`  se les pudo leer el vencimiento a algún papel: ${conVencLeido}`);
console.log(`  ningún papel soltó vencimiento (no se puede saber): ${sinNingunVenc}`);
console.log(`  la fecha cargada NO coincide con ningún papel: ${noCoincideConNinguno}`);

console.log('\n--- Cuando la fecha coincide, ¿de qué tipo de documento salió? ---');
const filas = [...coincidePorTipo.entries()].sort((a, b) => b[1] - a[1]);
if (filas.length === 0) console.log('  (ninguna coincidencia)');
for (const [tipo, n] of filas) console.log(`  ${tipo.padEnd(24)} ${n}`);

if (detalle.length) {
  console.log('\n--- Casos donde no coincide (primeros 15) ---');
  console.log(detalle.slice(0, 15).join('\n'));
}
