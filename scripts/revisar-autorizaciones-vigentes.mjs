// INFORME (sólo lectura): ¿hay gente autorizada hoy con la documentación ya vencida?
//
// No toca la base, no cambia ningún estado, no manda ningún correo. Sólo lee las autorizaciones
// vigentes, abre los PDF de la solicitud de cada una y compara el vencimiento del papel contra la
// fecha hasta la que esa persona está autorizada a entrar.
//
// Uso:  node scripts/revisar-autorizaciones-vigentes.mjs
// En Fly:  fly ssh console -C "node /app/scripts/revisar-autorizaciones-vigentes.mjs"

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { extractPdfText } from '../backend/dist/modules/ocr/service.js';
import { classifyDocument, extractVencimiento, extractEmision } from '../backend/dist/modules/ai/classifier.js';

const storage = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const db = new Database(path.join(storage, 'data', 'sistema.db'), { readonly: true });
const hoy = new Date().toISOString().slice(0, 10);

// Una fila por solicitud con autorizaciones vigentes hoy.
const filas = db.prepare(`
  SELECT s.id, s.nro_orden AS nro, l.nombre AS local, e.raw_stored_path AS raw,
         MAX(a.fecha_hasta) AS hasta, COUNT(DISTINCT a.persona_id) AS personas
  FROM autorizaciones a
  JOIN solicitudes s ON s.id = a.solicitud_id
  JOIN locales l ON l.id = s.local_id
  LEFT JOIN email_messages e ON e.id = s.email_message_id
  WHERE a.estado = 'AUTORIZADA' AND a.fecha_hasta >= ?
  GROUP BY s.id
  ORDER BY s.id DESC
`).all(hoy);

const esPdf = (n, ct) => /\.pdf$/i.test(n ?? '') || /pdf/i.test(ct ?? '');
const dias = (a, b) => Math.round((new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000);

const problemas = [];
let sinEml = 0, sinVencLeido = 0, ok = 0;

for (const f of filas) {
  if (!f.raw || !fs.existsSync(f.raw)) { sinEml++; continue; }
  let parsed;
  try { parsed = await simpleParser(fs.readFileSync(f.raw)); } catch { sinEml++; continue; }

  const papeles = [];
  for (const a of parsed.attachments ?? []) {
    if (a.contentDisposition === 'inline') continue;
    if (!esPdf(a.filename, a.contentType)) continue;
    const t = await extractPdfText(a.content);
    if (!t.ok || !t.text) continue;
    const emi = extractEmision(t.text);
    let v = extractVencimiento(t.text);
    if (v && emi && v < emi) v = null; // es la fecha de inicio, no el vencimiento
    if (v) papeles.push({ archivo: a.filename, venc: v, tipo: classifyDocument(t.text, a.filename ?? '').codigo ?? '(sin reconocer)' });
  }

  if (papeles.length === 0) { sinVencLeido++; continue; }
  const vencidos = papeles.filter((p) => p.venc < f.hasta).sort((a, b) => a.venc.localeCompare(b.venc));
  if (vencidos.length === 0) { ok++; continue; }
  problemas.push({ ...f, vencidos, yaVencido: vencidos[0].venc < hoy });
}

problemas.sort((a, b) => a.vencidos[0].venc.localeCompare(b.vencidos[0].venc));
const graves = problemas.filter((p) => p.yaVencido);

console.log(`Fecha del informe: ${hoy}`);
console.log(`Solicitudes con autorizaciones vigentes hoy: ${filas.length}`);
console.log(`  la documentación alcanza: ${ok}`);
console.log(`  ALGÚN papel vence antes de la autorización: ${problemas.length}`);
console.log(`     de esas, el papel YA está vencido hoy: ${graves.length}   <- gente entrando con documentación vencida`);
console.log(`  no se pudo leer ningún vencimiento (no se puede saber): ${sinVencLeido}`);
console.log(`  sin el .eml en disco (purgado a los 3 meses): ${sinEml}`);

console.log('\n=== YA VENCIDAS HOY (mirar primero) ===');
for (const p of graves) {
  const v = p.vencidos[0];
  console.log(`  ${p.nro ?? `#${p.id}`} · ${p.local} · ${p.personas} persona(s) · autorizadas hasta ${p.hasta}`);
  console.log(`      ${v.tipo} "${v.archivo}" vencía el ${v.venc} — hace ${Math.abs(dias(hoy, v.venc))} días`);
}

console.log('\n=== VENCEN ANTES DE QUE TERMINE LA AUTORIZACIÓN ===');
for (const p of problemas.filter((x) => !x.yaVencido)) {
  const v = p.vencidos[0];
  console.log(`  ${p.nro ?? `#${p.id}`} · ${p.local} · ${p.personas} persona(s) · autorizadas hasta ${p.hasta}`);
  console.log(`      ${v.tipo} "${v.archivo}" vence el ${v.venc} — ${dias(p.hasta, v.venc)} días antes`);
}
