// ¿Cuánto duele hoy no leer bien la documentación? Mide sobre la documentación REAL que hay en
// producción, para decidir con números si conviene OCR, IA, las dos o ninguna.
//
// Contesta dos preguntas:
//   1) Cuántos PDF no se pueden leer (no traen texto: son escaneos o fotos)  -> candidatos a OCR.
//   2) De los que SÍ se leen, cuántos no sueltan el dato que hace falta       -> candidatos a IA.
//      (tipo de documento, vencimiento, emisión, empresa, personas)
//
// Usa el código COMPILADO del sistema, no una copia: lo que mide es exactamente lo que hace hoy la
// pantalla. Es de sólo lectura: no toca la base ni los archivos.
//
// Uso:  node scripts/medir-lectura-docs.mjs [--limite N]
// En Fly:  fly ssh console -C "node /app/scripts/medir-lectura-docs.mjs"

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { extractPdfText } from '../backend/dist/modules/ocr/service.js';
import { classifyDocument, extractVencimiento, extractEmision, extractEmpresa, extractPeople } from '../backend/dist/modules/ai/classifier.js';

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const LIMITE = Number(arg('--limite') ?? 0);

const storage = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const db = new Database(path.join(storage, 'data', 'sistema.db'), { readonly: true });

// Sólo los correos que efectivamente pertenecen a una solicitud: es la documentación que se revisa.
const emails = db.prepare(`
  SELECT DISTINCT e.id, e.raw_stored_path AS raw
  FROM email_messages e
  JOIN solicitudes s ON s.email_message_id = e.id
  WHERE e.raw_stored_path IS NOT NULL
  ORDER BY e.id DESC
  ${LIMITE ? `LIMIT ${LIMITE}` : ''}
`).all();

const esExcel = (n, ct) => /\.(xlsx?|csv)$/i.test(n) || /spreadsheet|excel|csv/i.test(ct ?? '');
const esPdf = (n, ct) => /\.pdf$/i.test(n) || /pdf/i.test(ct ?? '');

const vistos = new Set();
const r = {
  emails: 0, pdfs: 0, ilegibles: 0, legibles: 0,
  sinTipo: 0, sinVencimiento: 0, sinEmision: 0, sinEmpresa: 0, sinPersonas: 0,
  completos: 0,
};
const ejemplosIlegibles = [];
const ejemplosSinVenc = [];

// No todos los documentos vencen: un F931 o un pago son del mes, no tienen vigencia. Medir
// "sin vencimiento" sobre todos mezcla dos cosas distintas, así que se corta por tipo.
const VENCEN = new Set(['ART', 'SEGURO_VIDA', 'CLAUSULA_NO_REPETICION']);
const porTipo = new Map();
const cuenta = (codigo) => {
  const k = codigo ?? '(sin reconocer)';
  if (!porTipo.has(k)) porTipo.set(k, { n: 0, conVenc: 0, conEmision: 0, conGente: 0 });
  return porTipo.get(k);
};

for (const e of emails) {
  if (!fs.existsSync(e.raw)) continue;
  r.emails++;
  let parsed;
  try { parsed = await simpleParser(fs.readFileSync(e.raw)); } catch { continue; }
  for (const a of parsed.attachments ?? []) {
    const nombre = a.filename ?? '(sin nombre)';
    if (a.contentDisposition === 'inline') continue;
    if (esExcel(nombre, a.contentType)) continue;
    if (!esPdf(nombre, a.contentType)) continue;
    const clave = `${nombre}:${a.content.length}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    r.pdfs++;

    const t = await extractPdfText(a.content);
    if (!t.ok || !t.text) {
      r.ilegibles++;
      if (ejemplosIlegibles.length < 8) ejemplosIlegibles.push(nombre);
      continue;
    }
    r.legibles++;
    const tipo = classifyDocument(t.text, nombre).codigo;
    let venc = extractVencimiento(t.text);
    const emi = extractEmision(t.text);
    const emp = extractEmpresa(t.text);
    const gente = extractPeople(t.text);
    if (!tipo) r.sinTipo++;
    if (venc && emi && venc < emi) venc = null; // es la fecha de inicio, no el vencimiento
    if (!venc) { r.sinVencimiento++; if (ejemplosSinVenc.length < 8) ejemplosSinVenc.push(`${nombre}${tipo ? ` (${tipo})` : ''}`); }
    if (!emi) r.sinEmision++;
    if (!emp) r.sinEmpresa++;
    if (gente.length === 0) r.sinPersonas++;
    if (tipo && venc && gente.length > 0) r.completos++;
    const c = cuenta(tipo);
    c.n++;
    if (venc) c.conVenc++;
    if (emi) c.conEmision++;
    if (gente.length > 0) c.conGente++;
  }
}

const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`);

console.log(`Correos de solicitudes con .eml en disco: ${r.emails}`);
console.log(`PDF distintos analizados: ${r.pdfs}\n`);

console.log('--- ¿Se puede leer el papel? (esto lo resuelve el OCR) ---');
console.log(`  se leen:    ${r.legibles}  (${pct(r.legibles, r.pdfs)})`);
console.log(`  NO se leen: ${r.ilegibles}  (${pct(r.ilegibles, r.pdfs)})  <- escaneos o fotos`);
if (ejemplosIlegibles.length) console.log(`  ejemplos: ${ejemplosIlegibles.join(', ')}`);

console.log('\n--- De los que SÍ se leen, ¿sueltan el dato? (esto lo resuelve la IA) ---');
console.log(`  sin reconocer el tipo: ${r.sinTipo}  (${pct(r.sinTipo, r.legibles)})`);
console.log(`  sin vencimiento:       ${r.sinVencimiento}  (${pct(r.sinVencimiento, r.legibles)})`);
console.log(`  sin fecha de emisión:  ${r.sinEmision}  (${pct(r.sinEmision, r.legibles)})`);
console.log(`  sin empresa:           ${r.sinEmpresa}  (${pct(r.sinEmpresa, r.legibles)})`);
console.log(`  sin ninguna persona:   ${r.sinPersonas}  (${pct(r.sinPersonas, r.legibles)})`);
console.log(`  con tipo + vencimiento + gente: ${r.completos}  (${pct(r.completos, r.legibles)})`);
if (ejemplosSinVenc.length) console.log(`  ejemplos sin vencimiento: ${ejemplosSinVenc.join(', ')}`);

console.log('');
console.log('--- Por tipo de documento (de los legibles) ---');
const filas = [...porTipo.entries()].sort((a, b) => b[1].n - a[1].n);
for (const [codigo, c] of filas) {
  const vence = VENCEN.has(codigo);
  console.log(`  ${codigo.padEnd(24)} ${String(c.n).padStart(4)} archivos` +
    `  ·  con vencimiento ${String(c.conVenc).padStart(3)} (${pct(c.conVenc, c.n)})${vence ? '  <- este tipo SÍ vence' : ''}` +
    `  ·  con emisión ${pct(c.conEmision, c.n)}  ·  con gente ${pct(c.conGente, c.n)}`);
}

const queVencen = filas.filter(([k]) => VENCEN.has(k));
const nV = queVencen.reduce((s, [, c]) => s + c.n, 0);
const okV = queVencen.reduce((s, [, c]) => s + c.conVenc, 0);
console.log(`  Documentos que SÍ deberían tener vencimiento: ${nV}. Se les pudo leer la fecha a ${okV} (${pct(okV, nV)}).`);
console.log(`  Los otros ${nV - okV} son los que hoy te obligan a abrir el PDF y tipear la fecha a mano.`);
