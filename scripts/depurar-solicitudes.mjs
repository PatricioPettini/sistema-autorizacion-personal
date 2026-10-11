// Depura solicitudes de prueba SIN romper la deduplicación del lector de emails.
//
// Conserva las solicitudes cuyo asunto/local matchea KEEP (default "bensimon|peques"),
// borra el resto con sus dependientes, purga personas y locales que queden huérfanos,
// y asigna número de orden a las que queden sin uno.
//
// CLAVE: NO borra filas de email_messages. Esas filas son el registro que usa el lector
// IMAP para no reprocesar un mail ya visto. Si se borran, el lector vuelve a importar el
// mail desde la bandeja y recrea la solicitud. Por eso las dejamos como "tombstone".
//
// Uso:
//   node scripts/depurar-solicitudes.mjs            # DRY-RUN
//   node scripts/depurar-solicitudes.mjs --apply
//   KEEP="bensimon|peques" node scripts/depurar-solicitudes.mjs --apply

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const APPLY = process.argv.includes('--apply');
const KEEP = new RegExp(process.env.KEEP || 'bensimon|peques', 'i');
const PREFIJO = 'OA';
const PLACEHOLDER = '(Sin asignar)';

const storage = process.env.STORAGE_PATH
  ? (path.isAbsolute(process.env.STORAGE_PATH) ? process.env.STORAGE_PATH : path.resolve(process.cwd(), process.env.STORAGE_PATH))
  : path.resolve(process.cwd(), 'storage');
const dbPath = path.join(storage, 'data', 'sistema.db');
if (!fs.existsSync(dbPath)) { console.error('No existe la base:', dbPath); process.exit(1); }

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
const anio = String(new Date().getFullYear());

const sols = db.prepare(`
  SELECT s.id, s.nro_orden AS nro, e.asunto, l.nombre AS local,
         (SELECT count(*) FROM solicitud_personas sp WHERE sp.solicitud_id = s.id) AS personas
  FROM solicitudes s
  LEFT JOIN email_messages e ON e.id = s.email_message_id
  LEFT JOIN locales l ON l.id = s.local_id
  ORDER BY s.id
`).all();

const conserva = sols.filter((s) => KEEP.test(s.asunto || '') || KEEP.test(s.local || ''));
const conservaIds = new Set(conserva.map((s) => s.id));
const borrar = sols.filter((s) => !conservaIds.has(s.id));

const fmt = (s) => `#${s.id} · ${s.asunto ? JSON.stringify(s.asunto) : '(manual)'} · local=${s.local} · ${s.personas} pers · orden=${s.nro ?? '—'}`;
console.log(`Base: ${dbPath}\nKEEP: /${KEEP.source}/i\n`);
console.log(`CONSERVAR (${conserva.length}):`);
for (const s of conserva) console.log('  ✔', fmt(s));
console.log(`\nBORRAR solicitudes (${borrar.length}):`);
for (const s of borrar) console.log('  ✗', fmt(s));

// Lista de ids conservados para los subquerys. Si no hay ninguno, usamos un id imposible
// (-1) para que el subquery devuelva conjunto vacío (y NOT IN borre todo), en vez de NULL
// (que en SQLite haría que NOT IN no matchee nada).
const inList = conservaIds.size ? [...conservaIds].join(',') : '-1';
const KEEPP = `SELECT persona_id FROM solicitud_personas WHERE solicitud_id IN (${inList})`;
const KEEPL = `SELECT local_id FROM solicitudes WHERE id IN (${inList})`;

const cnt = (sql) => db.prepare(sql).get().c;
console.log(`\nADEMÁS se purgan huérfanos que queden sin solicitud:`);
console.log(`  personas:  ${cnt(`SELECT count(*) c FROM personas WHERE id NOT IN (${KEEPP})`)}`);
console.log(`  locales:   ${cnt(`SELECT count(*) c FROM locales WHERE nombre != '${PLACEHOLDER}' AND id NOT IN (${KEEPL})`)}  (se conserva "${PLACEHOLDER}")`);
console.log(`  emails:    0  (se conservan como tombstone para no reimportar)`);

// Números de orden a asignar a las que se conservan y no tienen.
const ultimo = db.prepare(`SELECT nro_orden FROM solicitudes WHERE nro_orden LIKE ? ORDER BY nro_orden DESC LIMIT 1`).get(`${PREFIJO}-${anio}-%`);
let seq = ultimo ? Number(ultimo.nro_orden.split('-').pop()) : 0;
const sinOrden = conserva.filter((s) => !s.nro).sort((a, b) => a.id - b.id);
const asign = sinOrden.map((s) => ({ id: s.id, nro: `${PREFIJO}-${anio}-${String(++seq).padStart(4, '0')}` }));
if (asign.length) { console.log('\nNÚMERO DE ORDEN a asignar:'); for (const a of asign) console.log(`  #${a.id} -> ${a.nro}`); }

if (!APPLY) { console.log('\n[DRY-RUN] No se cambió nada. Corré con --apply.'); process.exit(0); }

const delIds = borrar.map((s) => s.id);

db.transaction(() => {
  // 1) Borrar solicitudes no conservadas + dependientes (email_messages NO se toca).
  if (delIds.length) {
    const ph = delIds.join(',');
    db.prepare(`DELETE FROM entradas WHERE autorizacion_id IN (SELECT id FROM autorizaciones WHERE solicitud_id IN (${ph}))`).run();
    db.prepare(`DELETE FROM autorizaciones WHERE solicitud_id IN (${ph})`).run();
    db.prepare(`DELETE FROM requisitos_persona WHERE solicitud_id IN (${ph})`).run();
    db.prepare(`DELETE FROM ai_analyses WHERE solicitud_id IN (${ph})`).run();
    db.prepare(`DELETE FROM comentarios WHERE solicitud_id IN (${ph})`).run();
    db.prepare(`DELETE FROM solicitud_personas WHERE solicitud_id IN (${ph})`).run();
    db.prepare(`DELETE FROM solicitudes WHERE id IN (${ph})`).run();
  }

  // 2) Purgar personas huérfanas (+ su documentación y referencias).
  db.prepare(`DELETE FROM entradas WHERE persona_id NOT IN (${KEEPP})`).run();
  db.prepare(`DELETE FROM autorizaciones WHERE persona_id NOT IN (${KEEPP})`).run();
  db.prepare(`DELETE FROM requisitos_persona WHERE persona_id NOT IN (${KEEPP})`).run();
  db.prepare(`DELETE FROM ai_analyses WHERE persona_id NOT IN (${KEEPP})`).run();
  db.prepare(`DELETE FROM document_versions WHERE documento_id IN (SELECT id FROM documentos WHERE persona_id NOT IN (${KEEPP}))`).run();
  db.prepare(`DELETE FROM documentos WHERE persona_id NOT IN (${KEEPP})`).run();
  db.prepare(`DELETE FROM personas WHERE id NOT IN (${KEEPP})`).run();

  // 3) Purgar locales huérfanos. Antes, soltar la referencia de los emails tombstone.
  db.prepare(`UPDATE email_messages SET local_id = NULL WHERE local_id IS NOT NULL AND local_id NOT IN (${KEEPL}) AND local_id != (SELECT id FROM locales WHERE nombre = '${PLACEHOLDER}')`).run();
  db.prepare(`DELETE FROM locales WHERE nombre != '${PLACEHOLDER}' AND id NOT IN (${KEEPL})`).run();

  // 4) Asignar números de orden faltantes (sin tocar updated_at).
  const upd = db.prepare(`UPDATE solicitudes SET nro_orden = ? WHERE id = ?`);
  for (const a of asign) upd.run(a.nro, a.id);
})();

console.log('\n✔ Depuración aplicada. Solicitudes ahora:');
for (const s of db.prepare(`SELECT s.id, s.nro_orden nro, l.nombre local, e.asunto FROM solicitudes s LEFT JOIN locales l ON l.id=s.local_id LEFT JOIN email_messages e ON e.id=s.email_message_id ORDER BY s.updated_at DESC`).all())
  console.log(`  #${s.id} · orden=${s.nro ?? '—'} · local=${s.local} · ${JSON.stringify(s.asunto)}`);
