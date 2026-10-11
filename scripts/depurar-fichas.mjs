// Dos limpiezas puntuales sobre las fichas con el CUIL inválido, las dos demostrables.
//
//  A) El campo CUIL tiene un DNI con ceros PEGADOS ATRÁS ("92019352000" = DNI 92019352). Ya se
//     habían arreglado los que tenían los ceros adelante; este es el mismo error del otro lado.
//     El número se pasa al campo DNI y el CUIL se vacía: el prefijo y el verificador no están en
//     ningún lado y el sistema sabe buscar por DNI.
//
//  B) Fichas de prueba: el CUIL es un relleno (todos los dígitos iguales, o 12345678963) Y la
//     ficha NO está enganchada a nada —ninguna solicitud, autorización, documento, requisito,
//     entrada ni análisis—. Esa segunda condición es la importante: una persona real con el CUIL
//     mal tipeado SIEMPRE está en alguna solicitud, así que nunca entra en este lote por más que
//     su CUIL parezca basura.
//
// Uso:
//   node scripts/depurar-fichas.mjs            # DRY-RUN: muestra qué haría
//   node scripts/depurar-fichas.mjs --apply    # aplica
// En Fly:
//   fly ssh console -C "node /app/scripts/depurar-fichas.mjs"

import Database from 'better-sqlite3';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const storage = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const db = new Database(path.join(storage, 'data', 'sistema.db'));

const soloDigitos = (s) => String(s ?? '').replace(/[^0-9]/g, '');
const esDni = (d) => /^[0-9]{7,8}$/.test(d);

const PREFIJOS_CUIL = ['20', '23', '24', '27', '30', '33', '34'];
const MULT = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
function esCuilValido(n) {
  if (!/^[0-9]{11}$/.test(n)) return false;
  if (!PREFIJOS_CUIL.includes(n.slice(0, 2))) return false;
  const suma = MULT.reduce((acc, m, i) => acc + m * Number(n[i]), 0);
  let ver = 11 - (suma % 11);
  if (ver === 11) ver = 0;
  if (ver === 10) return false;
  return ver === Number(n[10]);
}

/** Todo lo que puede colgar de una persona. Si hay algo, la ficha se usa y no se toca. */
const ENGANCHES = [
  ['solicitud_personas', 'está en una solicitud'],
  ['autorizaciones', 'tiene autorizaciones'],
  ['documentos', 'tiene documentación'],
  ['requisitos_persona', 'tiene requisitos'],
  ['entradas', 'tiene ingresos registrados'],
  ['ai_analyses', 'tiene análisis'],
];
const contar = ENGANCHES.map(([tabla, motivo]) => ({
  motivo,
  stmt: db.prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE persona_id = ?`),
}));
const contarSolicitudTitular = db.prepare('SELECT COUNT(*) AS n FROM solicitudes WHERE persona_id = ?');

function usosDe(id) {
  const usos = [];
  for (const c of contar) if (c.stmt.get(id).n > 0) usos.push(c.motivo);
  if (contarSolicitudTitular.get(id).n > 0) usos.push('es titular de una solicitud');
  return usos;
}

/** Un CUIL que es relleno: todos los dígitos iguales, o el clásico 1234567... */
function esRelleno(c) {
  if (/^(\d)\1+$/.test(c)) return true;
  return /^1234567/.test(c);
}

const personas = db.prepare('SELECT id, nombre, apellido, cuil, dni FROM personas').all();
const invalidas = personas.filter((p) => {
  const c = soloDigitos(p.cuil);
  return c.length > 0 && !esCuilValido(c);
});

const aArreglar = [];
const aBorrar = [];
const noSeTocan = [];

for (const p of invalidas) {
  const c = soloDigitos(p.cuil);

  // A) DNI con ceros atrás
  if (c.length === 11 && /0+$/.test(c)) {
    const sinCeros = c.replace(/0+$/, '');
    if (esDni(sinCeros)) { aArreglar.push({ p, dni: sinCeros }); continue; }
  }

  // B) relleno y sin enganches
  if (esRelleno(c)) {
    const usos = usosDe(p.id);
    if (usos.length === 0) aBorrar.push({ p });
    else noSeTocan.push({ p, motivo: usos.join(', ') });
  }
}

console.log(`Personas: ${personas.length} · con CUIL inválido: ${invalidas.length}`);
console.log(`  A) el CUIL es un DNI con ceros atrás: ${aArreglar.length}`);
console.log(`  B) fichas de prueba sin usar (se borran): ${aBorrar.length}`);
console.log(`  el CUIL parece relleno PERO la ficha se usa (NO se toca): ${noSeTocan.length}`);

console.log('\n--- A) PASAR EL NÚMERO AL CAMPO DNI ---');
for (const a of aArreglar) {
  console.log(`  #${a.p.id} ${a.p.apellido}, ${a.p.nombre}: cuil ${a.p.cuil} -> cuil (vacío) / dni ${a.dni}`);
}

console.log('\n--- B) BORRAR (fichas de prueba, sin nada colgando) ---');
for (const b of aBorrar) console.log(`  #${b.p.id} ${b.p.apellido}, ${b.p.nombre}: ${b.p.cuil}`);

console.log('\n--- NO SE TOCAN (el CUIL parece relleno pero la ficha se usa) ---');
for (const n of noSeTocan) console.log(`  #${n.p.id} ${n.p.apellido}, ${n.p.nombre}: ${n.p.cuil} — ${n.motivo}`);

if (!APPLY) {
  console.log('\nDRY-RUN. Nada se modificó. Para aplicar: --apply');
  process.exit(0);
}

const upd = db.prepare('UPDATE personas SET cuil = NULL, dni = ? WHERE id = ?');
const del = db.prepare('DELETE FROM personas WHERE id = ?');
db.transaction(() => {
  for (const a of aArreglar) upd.run(a.dni, a.p.id);
  for (const b of aBorrar) del.run(b.p.id);
})();
console.log(`\nAplicado: ${aArreglar.length} corregida(s), ${aBorrar.length} borrada(s).`);
