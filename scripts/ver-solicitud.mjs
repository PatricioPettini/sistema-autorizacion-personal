// Vuelca lo que el sistema lee de los PDF de UNA solicitud, para mirar un caso puntual.
// Sólo lectura.
//
// Uso:  node scripts/ver-solicitud.mjs --orden OA-2026-0214 [--texto]

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { extractPdfText } from '../backend/dist/modules/ocr/service.js';
import { classifyDocument, extractPeople } from '../backend/dist/modules/ai/classifier.js';

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const ORDEN = arg('--orden');
const VER_TEXTO = process.argv.includes('--texto');

const storage = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const db = new Database(path.join(storage, 'data', 'sistema.db'), { readonly: true });

const sol = db.prepare('SELECT id, nro_orden AS nro, email_message_id AS emailId FROM solicitudes WHERE nro_orden = ?').get(ORDEN);
if (!sol) { console.log(`No existe la solicitud ${ORDEN}`); process.exit(1); }

const personas = db.prepare(`
  SELECT p.dni, p.cuil, p.apellido, p.nombre FROM solicitud_personas sp
  JOIN personas p ON p.id = sp.persona_id WHERE sp.solicitud_id = ?
`).all(sol.id);

console.log(`Solicitud ${sol.nro} (#${sol.id}) · ${personas.length} persona(s) cargadas:`);
for (const p of personas) console.log(`  ${p.apellido}, ${p.nombre} — dni ${p.dni} · cuil ${p.cuil ?? '—'}`);

const emails = db.prepare('SELECT id, raw_stored_path AS raw FROM email_messages WHERE id = ?').all(sol.emailId);
for (const e of emails) {
  if (!e.raw || !fs.existsSync(e.raw)) { console.log('\n(sin .eml en disco)'); continue; }
  const parsed = await simpleParser(fs.readFileSync(e.raw));
  for (const a of parsed.attachments ?? []) {
    const nombre = a.filename ?? '(sin nombre)';
    if (!/\.pdf$/i.test(nombre) && !/pdf/i.test(a.contentType ?? '')) continue;
    const t = await extractPdfText(a.content);
    console.log(`\n=== ${nombre} ===`);
    if (!t.ok || !t.text) { console.log('  no se pudo leer'); continue; }
    console.log(`  tipo: ${JSON.stringify(classifyDocument(t.text, nombre))}`);
    const gente = extractPeople(t.text);
    console.log(`  personas detectadas: ${gente.length}`);
    for (const g of gente) console.log(`    ${g.dni} | ${g.apellido ?? '-'} | ${g.nombre ?? '-'}`);
    if (VER_TEXTO) {
      console.log('  --- TEXTO ---');
      console.log(t.text.slice(0, 4000).split(String.fromCharCode(10)).map((l) => '  | ' + l).join(String.fromCharCode(10)));
    }
  }
}
