// Fichas que NO son personas: las dejó el parser del cuerpo del correo antes de que se lo
// arreglara. Se llaman "Número de orden:, >" o "El 18:11 Deportiva Outlet... escribió:, >",
// salen de los encabezados de un mail reenviado y algunas quedaron colgadas de solicitudes.
//
// El criterio es estricto a propósito: sólo entra una ficha cuyo nombre trae ":", "<" o ">",
// caracteres que no existen en el nombre de una persona. Con un criterio más amplio se llevaría
// puesta gente real con el nombre mal cargado —hay fichas tipo "QUIROGA LEANDRO DANIEL DNI, ·"
// que SON una persona y necesitan que les corrijan el nombre, no que las borren.
//
// Borra también lo que cuelga de ellas, pero SÓLO si nunca se autorizó ni ingresó nadie con esa
// ficha. Una autorización dice "esta persona puede entrar" y un ingreso dice "entró": las fichas
// que tienen alguna de las dos se listan aparte y no se tocan, porque entre la basura hay alguna
// que ES una persona real con el nombre roto —"DOMINGUEZ PONCE DAMIA, :" tiene un DNI plausible y
// dos autorizaciones— y borrarla se llevaría puesto su historial.
//
// Uso:
//   node scripts/limpiar-fichas-falsas.mjs            # DRY-RUN
//   node scripts/limpiar-fichas-falsas.mjs --apply

import Database from 'better-sqlite3';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const storage = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const db = new Database(path.join(storage, 'data', 'sistema.db'));

const TABLAS = ['solicitud_personas', 'autorizaciones', 'documentos', 'requisitos_persona', 'ai_analyses'];
const contar = (tabla, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE persona_id = ?`).get(id).n;
const contarIngresos = (id) => db.prepare('SELECT COUNT(*) AS n FROM entradas WHERE persona_id = ?').get(id).n;

const personas = db.prepare('SELECT id, nombre, apellido, dni, cuil FROM personas').all();
const esFalsa = (p) => /[:<>]/.test(`${p.apellido ?? ''} ${p.nombre ?? ''}`);

const candidatas = personas.filter(esFalsa);
const aBorrar = [];
const paraMirar = [];
for (const p of candidatas) {
  const autorizada = contarIngresos(p.id) > 0 || contar('autorizaciones', p.id) > 0;
  (autorizada ? paraMirar : aBorrar).push(p);
}

console.log(`Personas: ${personas.length} · fichas que no son personas: ${candidatas.length}`);
console.log(`  se borran: ${aBorrar.length} · se saltean por tener autorizaciones o ingresos: ${paraMirar.length}`);

let colgando = 0;
console.log('\n--- SE BORRAN ---');
for (const p of aBorrar) {
  const detalle = TABLAS.map((t) => [t, contar(t, p.id)]).filter(([, n]) => n > 0);
  colgando += detalle.reduce((s, [, n]) => s + n, 0);
  console.log(`  #${p.id} "${p.apellido}, ${p.nombre}" — dni ${p.dni ?? '—'}`);
  if (detalle.length) console.log(`      cuelga: ${detalle.map(([t, n]) => `${t} ${n}`).join(' · ')}`);
}

if (paraMirar.length) {
  console.log('');
  console.log('--- NO SE TOCAN: se autorizó o ingresó a alguien con esta ficha. Mirarlas a mano ---');
  for (const p of paraMirar) {
    const detalle = [...TABLAS, 'entradas']
      .map((t) => [t, t === 'entradas' ? contarIngresos(p.id) : contar(t, p.id)])
      .filter(([, n]) => n > 0);
    console.log(`  #${p.id} "${p.apellido}, ${p.nombre}" — dni ${p.dni ?? '—'}`);
    console.log(`      cuelga: ${detalle.map(([t, n]) => `${t} ${n}`).join(' · ')}`);
  }
}

if (!APPLY) {
  console.log('\nDRY-RUN. Nada se modificó. Para aplicar: --apply');
  process.exit(0);
}

db.transaction(() => {
  for (const p of aBorrar) {
    for (const t of TABLAS) db.prepare(`DELETE FROM ${t} WHERE persona_id = ?`).run(p.id);
    db.prepare('UPDATE solicitudes SET persona_id = NULL WHERE persona_id = ?').run(p.id);
    db.prepare('DELETE FROM personas WHERE id = ?').run(p.id);
  }
  db.prepare('INSERT INTO audit_log (accion, entidad, entidad_id, detalle_json) VALUES (?, ?, ?, ?)')
    .run('PERSONAS_FALSAS_BORRADAS', 'persona', '0', JSON.stringify({
      borradas: aBorrar.map((p) => p.id), filasColgando: colgando, salteadas: paraMirar.map((p) => p.id),
    }));
})();

console.log(`\nBorradas: ${aBorrar.length} ficha(s) y ${colgando} fila(s) que colgaban de ellas.`);
