// Cierre de datos: asigna número de orden a las solicitudes que quedan y purga TODO
// lo que sea de prueba y ya no esté ligado a esas solicitudes (personas, emails, locales
// y su documentación). Idempotente. Dry-run por defecto.
//
// "Ligado" = referenciado por alguna solicitud que exista al momento de correr:
//   - personas que están en solicitud_personas
//   - emails referenciados por alguna solicitud
//   - locales referenciados por alguna solicitud (+ el placeholder "(Sin asignar)")
//
// Uso:
//   node scripts/finalizar-datos.mjs            # DRY-RUN: muestra qué haría
//   node scripts/finalizar-datos.mjs --apply    # aplica
// En Fly:
//   fly ssh console -C "node /app/scripts/finalizar-datos.mjs"
//   fly ssh console -C "node /app/scripts/finalizar-datos.mjs --apply"

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const APPLY = process.argv.includes('--apply');
const PREFIJO = 'OA';
const PLACEHOLDER = '(Sin asignar)';

const storage = process.env.STORAGE_PATH
  ? (path.isAbsolute(process.env.STORAGE_PATH) ? process.env.STORAGE_PATH : path.resolve(process.cwd(), process.env.STORAGE_PATH))
  : path.resolve(process.cwd(), 'storage');
const dbPath = path.join(storage, 'data', 'sistema.db');
if (!fs.existsSync(dbPath)) { console.error('No existe la base:', dbPath); process.exit(1); }

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
const nowIso = () => new Date().toISOString();
const anio = String(new Date().getFullYear());

console.log(`Base: ${dbPath}\n`);

// --- 1) Número de orden para las solicitudes que quedan sin uno ---
// Orden cronológico por fecha del email (o creación). NO tocamos updated_at para no
// alterar el orden del listado.
const sinOrden = db.prepare(`
  SELECT s.id, e.asunto FROM solicitudes s
  LEFT JOIN email_messages e ON e.id = s.email_message_id
  WHERE s.nro_orden IS NULL
  ORDER BY COALESCE(e.fecha_email, s.created_at), s.id
`).all();

const ultimo = db.prepare(`SELECT nro_orden FROM solicitudes WHERE nro_orden LIKE ? ORDER BY nro_orden DESC LIMIT 1`).get(`${PREFIJO}-${anio}-%`);
let seq = ultimo ? Number(ultimo.nro_orden.split('-').pop()) : 0;

const asignaciones = sinOrden.map((s) => {
  seq += 1;
  return { id: s.id, asunto: s.asunto, nro: `${PREFIJO}-${anio}-${String(seq).padStart(4, '0')}` };
});

console.log(`NÚMERO DE ORDEN a asignar (${asignaciones.length}):`);
for (const a of asignaciones) console.log(`  #${a.id} · ${a.asunto ? JSON.stringify(a.asunto) : '(manual)'} -> ${a.nro}`);
if (asignaciones.length === 0) console.log('  (todas ya tienen número)');

// --- 2) Inventario de lo que se purga ---
const cnt = (sql) => db.prepare(sql).get().c;
const purgePersonas = cnt(`SELECT count(*) c FROM personas WHERE id NOT IN (SELECT persona_id FROM solicitud_personas)`);
const purgeEmails = cnt(`SELECT count(*) c FROM email_messages WHERE id NOT IN (SELECT email_message_id FROM solicitudes WHERE email_message_id IS NOT NULL)`);
const purgeLocales = cnt(`SELECT count(*) c FROM locales WHERE nombre != '${PLACEHOLDER}' AND id NOT IN (SELECT local_id FROM solicitudes)`);
const purgeDocs = cnt(`SELECT count(*) c FROM documentos WHERE persona_id NOT IN (SELECT persona_id FROM solicitud_personas)`);

console.log(`\nPURGA (datos de prueba sin solicitud):`);
console.log(`  personas huérfanas:  ${purgePersonas}`);
console.log(`  emails huérfanos:    ${purgeEmails}`);
console.log(`  locales de prueba:   ${purgeLocales}  (se conserva "${PLACEHOLDER}" y los usados)`);
console.log(`  documentos:          ${purgeDocs}`);
console.log(`\nCONSERVA: ${db.prepare('SELECT count(*) c FROM solicitudes').get().c} solicitud(es), ` +
  `${db.prepare('SELECT count(DISTINCT persona_id) c FROM solicitud_personas').get().c} persona(s), ` +
  `${db.prepare('SELECT count(DISTINCT email_message_id) c FROM solicitudes WHERE email_message_id IS NOT NULL').get().c} email(s).`);

if (!APPLY) {
  console.log('\n[DRY-RUN] No se cambió nada. Corré con --apply para ejecutar.');
  process.exit(0);
}

const run = db.transaction(() => {
  // Asignar números de orden.
  const upd = db.prepare(`UPDATE solicitudes SET nro_orden = ? WHERE id = ?`);
  for (const a of asignaciones) upd.run(a.nro, a.id);

  // Purga en orden seguro (hijas primero). Personas que no están en ninguna solicitud:
  const NP = `SELECT persona_id FROM solicitud_personas`;
  db.prepare(`DELETE FROM entradas WHERE persona_id NOT IN (${NP})`).run();
  db.prepare(`DELETE FROM autorizaciones WHERE persona_id NOT IN (${NP})`).run();
  db.prepare(`DELETE FROM requisitos_persona WHERE persona_id NOT IN (${NP})`).run();
  db.prepare(`DELETE FROM ai_analyses WHERE persona_id NOT IN (${NP})`).run();
  db.prepare(`DELETE FROM document_versions WHERE documento_id IN (SELECT id FROM documentos WHERE persona_id NOT IN (${NP}))`).run();
  db.prepare(`DELETE FROM documentos WHERE persona_id NOT IN (${NP})`).run();
  db.prepare(`DELETE FROM personas WHERE id NOT IN (${NP})`).run();

  // Emails huérfanos (los que no referencia ninguna solicitud).
  const KE = `SELECT email_message_id FROM solicitudes WHERE email_message_id IS NOT NULL`;
  db.prepare(`DELETE FROM processing_jobs WHERE email_message_id NOT IN (${KE})`).run();
  db.prepare(`DELETE FROM document_versions WHERE email_message_id IS NOT NULL AND email_message_id NOT IN (${KE})`).run();
  db.prepare(`DELETE FROM email_messages WHERE id NOT IN (${KE})`).run();

  // Locales de prueba: primero soltar referencias de emails que apunten a un local a borrar.
  const KL = `SELECT local_id FROM solicitudes`;
  db.prepare(`UPDATE email_messages SET local_id = NULL WHERE local_id IS NOT NULL AND local_id NOT IN (${KL}) AND local_id != (SELECT id FROM locales WHERE nombre = '${PLACEHOLDER}')`).run();
  db.prepare(`DELETE FROM locales WHERE nombre != '${PLACEHOLDER}' AND id NOT IN (${KL})`).run();
});

run();
console.log('\n✔ Listo: números de orden asignados y datos de prueba purgados.');
console.log('Solicitudes ahora:');
for (const s of db.prepare(`SELECT s.id, s.nro_orden nro, l.nombre local, e.asunto FROM solicitudes s LEFT JOIN locales l ON l.id=s.local_id LEFT JOIN email_messages e ON e.id=s.email_message_id ORDER BY s.updated_at DESC`).all())
  console.log(`  #${s.id} · orden=${s.nro ?? '—'} · local=${s.local} · ${JSON.stringify(s.asunto)}`);
