// Fusiona dos fichas que son la MISMA persona: todo lo que cuelga de la que sobra pasa a la que
// queda, y recién entonces se borra la que sobra.
//
// Fusionar no es borrar una: cada ficha puede tener solicitudes, autorizaciones, documentos e
// ingresos. Borrar la duplicada a secas perdería el historial de ingreso de esa persona, que es
// justamente lo que el sistema existe para poder demostrar.
//
// Cuál queda: la que tiene el CUIL válido manda, porque su verificador confirma los 8 dígitos del
// medio, que son el DNI. Si ninguna lo tiene, se elige con --queda.
//
// Uso:
//   node scripts/fusionar-personas.mjs --queda 3838 --sobra 4080           # DRY-RUN
//   node scripts/fusionar-personas.mjs --queda 3838 --sobra 4080 --apply
//
// Y de paso se corrige la ficha que queda, porque muchas duplicadas vienen con el apellido y el
// nombre invertidos o con el CUIL metido en el campo DNI:
//   ... --dni 43018568 --apellido Peralta --nombre Martina

import Database from 'better-sqlite3';
import path from 'node:path';

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const QUEDA = Number(arg('--queda'));
const SOBRA = Number(arg('--sobra'));
// Varias fichas duplicadas tienen ademas el apellido y el nombre invertidos, o el CUIL guardado en
// el campo DNI. Se corrigen en la misma pasada: separarlo en dos pasos deja la base a medio arreglar.
const CORRIGE = { dni: arg('--dni'), nombre: arg('--nombre'), apellido: arg('--apellido') };

if (!QUEDA || !SOBRA || QUEDA === SOBRA) {
  console.log('Faltan --queda <id> y --sobra <id> (distintos).');
  process.exit(1);
}

const storage = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const db = new Database(path.join(storage, 'data', 'sistema.db'));

const traer = db.prepare('SELECT id, nombre, apellido, cuil, dni, categoria, empresa FROM personas WHERE id = ?');
const queda = traer.get(QUEDA);
const sobra = traer.get(SOBRA);
if (!queda || !sobra) { console.log('Alguna de las dos fichas no existe.'); process.exit(1); }

const linea = (p) => `#${p.id} ${p.apellido}, ${p.nombre} — dni ${p.dni ?? '—'} · cuil ${p.cuil ?? '—'}`;

/** Todo lo que apunta a una persona. El orden importa: primero se mueve, al final se borra. */
const TABLAS = ['solicitud_personas', 'autorizaciones', 'documentos', 'requisitos_persona', 'entradas', 'ai_analyses'];
const contar = (tabla, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE persona_id = ?`).get(id).n;

console.log(`QUEDA  ${linea(queda)}`);
console.log(`SOBRA  ${linea(sobra)}`);
console.log('\nSe va a mover:');
let total = 0;
for (const t of TABLAS) {
  const n = contar(t, SOBRA);
  total += n;
  if (n > 0) console.log(`  ${t.padEnd(20)} ${n}`);
}
if (total === 0) console.log('  (nada: la ficha que sobra no tiene nada colgando)');

// Datos que la ficha que queda podría completar con lo de la otra. Nunca se pisa un dato cargado.
const completar = {};
// Sólo se copia si PARECE un CUIL. Varias duplicadas tienen en ese campo un DNI con ceros
// adelante ("00094959396"): copiarlo sería mudar la basura a la ficha buena.
const pareceCuil = (c) => /^[0-9]{11}$/.test(String(c ?? '')) && ['20', '23', '24', '27', '30', '33', '34'].includes(String(c).slice(0, 2));
if (!queda.cuil && pareceCuil(sobra.cuil)) completar.cuil = sobra.cuil;
if (!queda.categoria && sobra.categoria) completar.categoria = sobra.categoria;
if (!queda.empresa && sobra.empresa) completar.empresa = sobra.empresa;
for (const [k, v] of Object.entries(CORRIGE)) if (v) completar[k] = v;
if (Object.keys(completar).length) console.log('Se completa/corrige en la que queda: ' + JSON.stringify(completar));

if (!APPLY) {
  console.log('\nDRY-RUN. Nada se modificó. Para aplicar: --apply');
  process.exit(0);
}

db.transaction(() => {
  for (const t of TABLAS) {
    // Las tablas con UNIQUE (persona + algo) romperían si la persona que queda ya tiene esa fila.
    // En ese caso la de la duplicada se descarta: la que queda ya tiene ese dato.
    const filas = db.prepare(`SELECT rowid AS rid FROM ${t} WHERE persona_id = ?`).all(SOBRA);
    for (const f of filas) {
      try {
        db.prepare(`UPDATE ${t} SET persona_id = ? WHERE rowid = ?`).run(QUEDA, f.rid);
      } catch {
        db.prepare(`DELETE FROM ${t} WHERE rowid = ?`).run(f.rid);
      }
    }
  }
  // `solicitudes.persona_id` es el contacto legacy de la solicitud, opcional pero apunta a personas.
  db.prepare('UPDATE solicitudes SET persona_id = ? WHERE persona_id = ?').run(QUEDA, SOBRA);
  // La duplicada se borra ANTES de copiarle sus datos a la que queda: `cuil` y `dni` son UNIQUE, y
  // copiar el CUIL mientras la otra ficha todavía lo tiene rompe con "UNIQUE constraint failed".
  db.prepare('DELETE FROM personas WHERE id = ?').run(SOBRA);
  if (Object.keys(completar).length) {
    const sets = Object.keys(completar).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE personas SET ${sets} WHERE id = ?`).run(...Object.values(completar), QUEDA);
  }
  db.prepare(`INSERT INTO audit_log (accion, entidad, entidad_id, detalle_json) VALUES (?, ?, ?, ?)`)
    .run('PERSONA_FUSIONADA', 'persona', String(QUEDA), JSON.stringify({ absorbio: SOBRA, movidas: total, completar }));
})();

console.log(`\nFusionadas: #${SOBRA} pasó a #${QUEDA} (${total} fila(s) movidas) y se borró.`);
