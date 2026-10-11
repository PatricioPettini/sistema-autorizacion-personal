// Vuelca las filas crudas de las planillas que el lector NO pudo explicar del todo, para ver el
// formato real y decidir qué falta cubrir. Sólo lectura.
//
// Uso:  node scripts/ver-planillas-fallidas.mjs [--max N]

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { parseSpreadsheet, filasAPersonas } from '../backend/dist/lib/xlsx.js';

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const MAX = Number(arg('--max') ?? 8);

const storage = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const db = new Database(path.join(storage, 'data', 'sistema.db'), { readonly: true });

const solicitudes = db.prepare(`
  SELECT s.id, s.nro_orden AS nro, l.nombre AS local, e.raw_stored_path AS raw
  FROM solicitudes s JOIN locales l ON l.id = s.local_id
  JOIN email_messages e ON e.id = s.email_message_id
  WHERE e.raw_stored_path IS NOT NULL ORDER BY s.id DESC
`).all();
const personasDe = db.prepare(`
  SELECT p.dni, p.cuil FROM solicitud_personas sp JOIN personas p ON p.id = sp.persona_id WHERE sp.solicitud_id = ?
`);

const esExcel = (n, ct) => /\.(xlsx?|xlsm|ods|csv|tsv)$/i.test(n ?? '') || /spreadsheet|excel|csv/i.test(ct ?? '');
const soloDig = (v) => String(v ?? '').replace(/\D/g, '');
function claveDni(p) {
  const dni = soloDig(p.dni).replace(/^0+/, '');
  if (dni.length >= 7 && dni.length <= 8) return dni;
  const cuil = soloDig(p.cuil ?? p.dni);
  if (cuil.length === 11) return cuil.slice(2, 10).replace(/^0+/, '');
  return null;
}

let mostradas = 0;
for (const s of solicitudes) {
  if (mostradas >= MAX) break;
  if (!fs.existsSync(s.raw)) continue;
  let parsed;
  try { parsed = await simpleParser(fs.readFileSync(s.raw)); } catch { continue; }
  const cargadas = new Set(personasDe.all(s.id).map(claveDni).filter(Boolean));
  if (cargadas.size === 0) continue;

  for (const a of parsed.attachments ?? []) {
    if (mostradas >= MAX) break;
    const nombre = a.filename ?? '';
    if (a.contentDisposition === 'inline' || !esExcel(nombre, a.contentType)) continue;

    let filas = [], gente = [];
    try { filas = parseSpreadsheet(nombre, a.content); gente = filasAPersonas(filas); } catch (e) {
      console.log(`\n### ${s.nro ?? s.id} · ${s.local} · "${nombre}" — NO SE PUDO ABRIR: ${e.message}`);
      mostradas++;
      continue;
    }
    const leidas = new Set(gente.map(claveDni).filter(Boolean));
    const faltan = [...cargadas].filter((k) => !leidas.has(k));
    if (faltan.length === 0) continue;

    mostradas++;
    console.log(`\n### ${s.nro ?? s.id} · ${s.local} · "${nombre}"`);
    console.log(`    cargadas ${cargadas.size} · leídas ${leidas.size} · faltan ${faltan.length}: ${faltan.join(', ')}`);
    console.log(`    filas en la planilla: ${filas.length}`);
    filas.slice(0, 25).forEach((f, i) => {
      const linea = JSON.stringify(f);
      if (linea !== '[]' && !/^\[(""|,)*\]$/.test(linea)) console.log(`    F${i}| ${linea.slice(0, 220)}`);
    });
    console.log(`    -> el lector sacó: ${JSON.stringify(gente.slice(0, 6))}`);
  }
}
console.log(`\n(mostradas ${mostradas} planillas)`);
