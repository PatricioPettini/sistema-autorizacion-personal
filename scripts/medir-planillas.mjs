// INFORME (sólo lectura): ¿de dónde salió la gente de cada solicitud, y qué se le escapa al lector?
//
// Para cada solicitud con su .eml en disco, lee las planillas adjuntas, el cuerpo del correo y los
// PDF, y compara lo que el lector saca contra las personas que REALMENTE quedaron cargadas en esa
// solicitud. Así se ve qué formatos cubre hoy y cuáles se pierden, con nombre y archivo, en vez de
// adivinar sobre un caso suelto.
//
// Uso:  node scripts/medir-planillas.mjs [--detalle N]
// En Fly:  fly ssh console -C "node /app/scripts/medir-planillas.mjs"

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { parsePersonasSpreadsheet } from '../backend/dist/lib/xlsx.js';
import { parsePersonasFromBody } from '../backend/dist/modules/processing/body-table.js';
import { extractPdfText } from '../backend/dist/modules/ocr/service.js';
import { extractPeople } from '../backend/dist/modules/ai/classifier.js';

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const DETALLE = Number(arg('--detalle') ?? 12);

const storage = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const db = new Database(path.join(storage, 'data', 'sistema.db'), { readonly: true });

const solicitudes = db.prepare(`
  SELECT s.id, s.nro_orden AS nro, l.nombre AS local, e.raw_stored_path AS raw
  FROM solicitudes s
  JOIN locales l ON l.id = s.local_id
  JOIN email_messages e ON e.id = s.email_message_id
  WHERE e.raw_stored_path IS NOT NULL
  ORDER BY s.id DESC
`).all();

const personasDe = db.prepare(`
  SELECT p.dni, p.cuil FROM solicitud_personas sp
  JOIN personas p ON p.id = sp.persona_id WHERE sp.solicitud_id = ?
`);

const esExcel = (n, ct) => /\.(xlsx?|xlsm|ods|csv|tsv)$/i.test(n ?? '') || /spreadsheet|excel|csv/i.test(ct ?? '');
const esPdf = (n, ct) => /\.pdf$/i.test(n ?? '') || /pdf/i.test(ct ?? '');
const soloDig = (v) => String(v ?? '').replace(/\D/g, '');

/** El identificador comparable de una persona: el DNI (el CUIL lo contiene en el medio). */
function claveDni(p) {
  const dni = soloDig(p.dni).replace(/^0+/, '');
  if (dni.length >= 7 && dni.length <= 8) return dni;
  const cuil = soloDig(p.cuil ?? p.dni);
  if (cuil.length === 11) return cuil.slice(2, 10).replace(/^0+/, '');
  return null;
}

const r = {
  total: 0, sinPersonasCargadas: 0,
  excelCubreTodo: 0, excelParcial: 0, excelNoLeyoNada: 0, sinExcel: 0,
  cuerpoCubreTodo: 0, pdfCubreTodo: 0, nadieCubre: 0,
  sinNombre: 0, conNombre: 0,
};
const formatos = new Map();   // extensión -> {n, leyo}
const fallas = [];

for (const s of solicitudes) {
  if (!fs.existsSync(s.raw)) continue;
  let parsed;
  try { parsed = await simpleParser(fs.readFileSync(s.raw)); } catch { continue; }
  r.total++;

  const cargadas = new Set(personasDe.all(s.id).map(claveDni).filter(Boolean));
  if (cargadas.size === 0) { r.sinPersonasCargadas++; continue; }

  const deExcel = new Set(); const dePdf = new Set(); const archivosExcel = [];
  let hayExcel = false;

  for (const a of parsed.attachments ?? []) {
    const nombre = a.filename ?? '';
    if (a.contentDisposition === 'inline') continue;
    if (esExcel(nombre, a.contentType)) {
      hayExcel = true;
      const ext = (nombre.match(/\.[a-z0-9]+$/i)?.[0] ?? '(sin ext)').toLowerCase();
      let gente = [];
      try { gente = parsePersonasSpreadsheet(nombre, a.content); } catch { /* formato ilegible */ }
      const f = formatos.get(ext) ?? { n: 0, leyo: 0 };
      f.n++; if (gente.length > 0) f.leyo++;
      formatos.set(ext, f);
      archivosExcel.push(`${nombre} (${gente.length})`);
      for (const g of gente) {
        const k = claveDni(g);
        if (k) deExcel.add(k);
        if ((g.nombreCompleto ?? '').trim() || (g.nombre ?? '').trim()) r.conNombre++; else r.sinNombre++;
      }
    } else if (esPdf(nombre, a.contentType)) {
      const t = await extractPdfText(a.content);
      if (t.ok && t.text) for (const g of extractPeople(t.text)) { const k = claveDni(g); if (k) dePdf.add(k); }
    }
  }

  const delCuerpo = new Set(parsePersonasFromBody(parsed.html || undefined, parsed.text || undefined).map(claveDni).filter(Boolean));
  const cubre = (set) => [...cargadas].every((k) => set.has(k));
  const cuantas = (set) => [...cargadas].filter((k) => set.has(k)).length;

  if (!hayExcel) r.sinExcel++;
  else if (cubre(deExcel)) r.excelCubreTodo++;
  else if (deExcel.size === 0) r.excelNoLeyoNada++;
  else r.excelParcial++;

  if (cubre(delCuerpo)) r.cuerpoCubreTodo++;
  if (cubre(dePdf)) r.pdfCubreTodo++;

  const mejor = Math.max(cuantas(deExcel), cuantas(delCuerpo), cuantas(dePdf));
  if (mejor < cargadas.size) {
    r.nadieCubre++;
    fallas.push({
      nro: s.nro ?? `#${s.id}`, local: s.local, cargadas: cargadas.size,
      excel: cuantas(deExcel), cuerpo: cuantas(delCuerpo), pdf: cuantas(dePdf),
      archivos: archivosExcel.join('; ') || '(sin planilla adjunta)',
    });
  }
}

const pct = (n) => (r.total === 0 ? '—' : `${((n / r.total) * 100).toFixed(0)}%`);

console.log(`Solicitudes con .eml en disco: ${r.total}`);
console.log(`  sin personas cargadas (nada que comparar): ${r.sinPersonasCargadas}`);
console.log('\n--- ¿La planilla adjunta explica la gente que quedó cargada? ---');
console.log(`  la lee entera:                 ${r.excelCubreTodo}  (${pct(r.excelCubreTodo)})`);
console.log(`  la lee a medias:               ${r.excelParcial}  (${pct(r.excelParcial)})`);
console.log(`  hay planilla y no leyó a nadie: ${r.excelNoLeyoNada}  (${pct(r.excelNoLeyoNada)})`);
console.log(`  no vino planilla:              ${r.sinExcel}  (${pct(r.sinExcel)})`);

console.log('\n--- Las otras dos fuentes ---');
console.log(`  la tabla del cuerpo del mail alcanza sola: ${r.cuerpoCubreTodo}`);
console.log(`  los PDF adjuntos alcanzan solos:           ${r.pdfCubreTodo}`);
console.log(`  NINGUNA fuente explica toda la gente:      ${r.nadieCubre}  <- lo que hoy se carga a mano`);

console.log('\n--- Nombres que saca el lector de planillas ---');
console.log(`  con nombre: ${r.conNombre}  ·  SIN nombre: ${r.sinNombre}`);

console.log('\n--- Por formato de archivo ---');
for (const [ext, f] of [...formatos.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${ext.padEnd(8)} ${String(f.n).padStart(3)} archivos · leyó gente en ${f.leyo} (${((f.leyo / f.n) * 100).toFixed(0)}%)`);
}

console.log(`\n--- Casos donde falta gente (primeros ${DETALLE}) ---`);
for (const f of fallas.slice(0, DETALLE)) {
  console.log(`  ${f.nro} · ${f.local}: cargadas ${f.cargadas} · leídas → excel ${f.excel}, cuerpo ${f.cuerpo}, pdf ${f.pdf}`);
  console.log(`      planillas: ${f.archivos}`);
}
