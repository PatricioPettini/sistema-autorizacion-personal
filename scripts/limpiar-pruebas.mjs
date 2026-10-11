// Limpia las solicitudes de PRUEBA y deja solo las reales, reiniciando el número de orden.
//
// Conserva las solicitudes cuyo asunto de email coincide con el patrón KEEP (por defecto
// "bensimon" o "peques") y borra TODAS las demás con sus filas dependientes. Después pone
// nro_orden = NULL en las que quedan, así la próxima revisión arranca en OA-AAAA-0001.
//
// Uso:
//   node scripts/limpiar-pruebas.mjs                 # DRY-RUN: solo muestra qué haría
//   node scripts/limpiar-pruebas.mjs --apply         # ejecuta el borrado
//   node scripts/limpiar-pruebas.mjs --apply --prune-personas   # además borra personas huérfanas
//   KEEP="bensimon|peques" node scripts/limpiar-pruebas.mjs --apply
//
// La ruta de la base sale de STORAGE_PATH (igual que la app). En Fly:
//   fly ssh console -C "node scripts/limpiar-pruebas.mjs"          (revisar)
//   fly ssh console -C "node scripts/limpiar-pruebas.mjs --apply"  (aplicar)

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const APPLY = process.argv.includes('--apply');
const PRUNE_PERSONAS = process.argv.includes('--prune-personas');
const KEEP = new RegExp(process.env.KEEP || 'bensimon|peques', 'i');

const storage = process.env.STORAGE_PATH
  ? (path.isAbsolute(process.env.STORAGE_PATH) ? process.env.STORAGE_PATH : path.resolve(process.cwd(), process.env.STORAGE_PATH))
  : path.resolve(process.cwd(), 'storage');
const dbPath = path.join(storage, 'data', 'sistema.db');
if (!fs.existsSync(dbPath)) { console.error('No existe la base:', dbPath); process.exit(1); }

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

// Todas las solicitudes con su asunto (o "manual" si no tiene email) y datos de contexto.
const sols = db.prepare(`
  SELECT s.id, s.nro_orden AS nroOrden, s.email_message_id AS emailId,
         e.asunto AS asunto, l.nombre AS local,
         (SELECT count(*) FROM solicitud_personas sp WHERE sp.solicitud_id = s.id) AS personas
  FROM solicitudes s
  LEFT JOIN email_messages e ON e.id = s.email_message_id
  LEFT JOIN locales l ON l.id = s.local_id
  ORDER BY s.id
`).all();

const keep = sols.filter((s) => s.asunto && KEEP.test(s.asunto));
const keepEmailIds = new Set(keep.map((s) => s.emailId).filter((x) => x != null));
// Conservar todas las hermanas del mismo email de una que se conserva.
const conservadas = sols.filter((s) => (s.emailId != null && keepEmailIds.has(s.emailId)) || keep.includes(s));
const conservadasIds = new Set(conservadas.map((s) => s.id));
const aBorrar = sols.filter((s) => !conservadasIds.has(s.id));

const fmt = (s) => `#${s.id} · ${s.asunto ? JSON.stringify(s.asunto) : '(manual)'} · local=${s.local} · ${s.personas} pers · orden=${s.nroOrden ?? '—'}`;
console.log(`Base: ${dbPath}`);
console.log(`Patrón KEEP: /${KEEP.source}/i\n`);
console.log(`CONSERVAR (${conservadas.length}):`);
for (const s of conservadas) console.log('  ✔', fmt(s));
console.log(`\nBORRAR (${aBorrar.length}):`);
for (const s of aBorrar) console.log('  ✗', fmt(s));

if (aBorrar.length === 0) { console.log('\nNada para borrar.'); process.exit(0); }

const delIds = aBorrar.map((s) => s.id);
const ph = delIds.map(() => '?').join(',');

function run() {
  // Hijas primero (FK ON). entradas -> autorizaciones -> requisitos/ai/comentarios/solicitud_personas -> solicitudes.
  db.prepare(`DELETE FROM entradas WHERE autorizacion_id IN (SELECT id FROM autorizaciones WHERE solicitud_id IN (${ph}))`).run(...delIds);
  db.prepare(`DELETE FROM autorizaciones WHERE solicitud_id IN (${ph})`).run(...delIds);
  db.prepare(`DELETE FROM requisitos_persona WHERE solicitud_id IN (${ph})`).run(...delIds);
  db.prepare(`DELETE FROM ai_analyses WHERE solicitud_id IN (${ph})`).run(...delIds);
  db.prepare(`DELETE FROM comentarios WHERE solicitud_id IN (${ph})`).run(...delIds);
  db.prepare(`DELETE FROM solicitud_personas WHERE solicitud_id IN (${ph})`).run(...delIds);
  db.prepare(`DELETE FROM solicitudes WHERE id IN (${ph})`).run(...delIds);

  // Reiniciar número de orden en las que quedan.
  const r = db.prepare(`UPDATE solicitudes SET nro_orden = NULL WHERE nro_orden IS NOT NULL`).run();
  console.log(`\nnro_orden reiniciado en ${r.changes} solicitud(es).`);

  if (PRUNE_PERSONAS) {
    // Personas que ya no están en ninguna solicitud ni tienen ingresos/autorizaciones.
    const pr = db.prepare(`
      DELETE FROM personas WHERE id NOT IN (SELECT persona_id FROM solicitud_personas)
        AND id NOT IN (SELECT persona_id FROM autorizaciones)
        AND id NOT IN (SELECT persona_id FROM entradas)
        AND id NOT IN (SELECT persona_id FROM requisitos_persona)
    `).run();
    console.log(`Personas huérfanas borradas: ${pr.changes}.`);
  }
}

if (!APPLY) {
  console.log('\n[DRY-RUN] No se borró nada. Volvé a correr con --apply para ejecutar.');
  process.exit(0);
}

const tx = db.transaction(run);
tx();
console.log('\n✔ Limpieza aplicada.');
