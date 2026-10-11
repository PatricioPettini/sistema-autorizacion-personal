// Fichas que son la MISMA persona cargada dos veces. Sólo lectura.
//
// Busca por dos caminos distintos, porque los duplicados se generan de dos formas:
//
//   A) Por documento: el DNI de una es los 8 del medio del CUIL de la otra. Pasa cuando alguien
//      carga a la persona con el DNI y otro día con el CUIL, y el sistema no las cruza.
//   B) Por nombre: mismo apellido y nombre (sin acentos, sin orden), con documentos distintos.
//      Ahí casi siempre uno de los dos está mal tipeado.
//
// Uso:  node scripts/buscar-duplicados.mjs [--nombre "perez"]

import Database from 'better-sqlite3';
import path from 'node:path';

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const FILTRO = (arg('--nombre') ?? '').toLowerCase();

const storage = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const db = new Database(path.join(storage, 'data', 'sistema.db'), { readonly: true });

const personas = db.prepare('SELECT id, nombre, apellido, cuil, dni, categoria, empresa FROM personas').all();

const soloDig = (v) => String(v ?? '').replace(/\D/g, '');
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
/** Las fichas mezclan "Perez, Jose" y "Jose, Perez": se comparan las palabras, no el orden. */
const clavePorNombre = (p) => [...norm(`${p.apellido} ${p.nombre}`).split(' ')].filter((w) => w.length >= 3).sort().join(' ');
const medioDelCuil = (c) => (soloDig(c).length === 11 ? soloDig(c).slice(2, 10).replace(/^0+/, '') : null);

const usos = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM solicitud_personas WHERE persona_id = ?) AS solicitudes,
    (SELECT COUNT(*) FROM autorizaciones   WHERE persona_id = ?) AS autorizaciones,
    (SELECT COUNT(*) FROM documentos       WHERE persona_id = ?) AS documentos,
    (SELECT COUNT(*) FROM entradas         WHERE persona_id = ?) AS ingresos
`);
const resumen = (id) => {
  const u = usos.get(id, id, id, id);
  return `solicitudes ${u.solicitudes} · autorizaciones ${u.autorizaciones} · documentos ${u.documentos} · ingresos ${u.ingresos}`;
};
const linea = (p) => `#${p.id} ${p.apellido}, ${p.nombre} — dni ${p.dni ?? '—'} · cuil ${p.cuil ?? '—'}`;

// --- A) el DNI de una está adentro del CUIL de la otra -------------------------------------
const porDni = new Map();
for (const p of personas) {
  const d = soloDig(p.dni).replace(/^0+/, '');
  if (d) (porDni.get(d) ?? porDni.set(d, []).get(d)).push(p);
}
const porDocumento = [];
for (const p of personas) {
  const medio = medioDelCuil(p.cuil);
  if (!medio) continue;
  for (const otra of porDni.get(medio) ?? []) {
    if (otra.id === p.id) continue;
    if (soloDig(otra.cuil) === soloDig(p.cuil)) continue; // mismo CUIL: no es este caso
    porDocumento.push([p, otra]);
  }
}

// --- B) mismo nombre, documentos distintos --------------------------------------------------
const porNombre = new Map();
for (const p of personas) {
  const k = clavePorNombre(p);
  if (k.split(' ').length < 2) continue; // un nombre de una sola palabra no alcanza para afirmar nada
  (porNombre.get(k) ?? porNombre.set(k, []).get(k)).push(p);
}
const mismosNombres = [...porNombre.values()].filter((g) => g.length > 1);

const pasaFiltro = (p) => !FILTRO || norm(`${p.apellido} ${p.nombre}`).includes(FILTRO);

console.log(`Personas: ${personas.length}`);
console.log(`\n=== A) El DNI de una ficha es el que está adentro del CUIL de la otra: ${porDocumento.length} par(es) ===`);
for (const [a, b] of porDocumento) {
  if (!pasaFiltro(a) && !pasaFiltro(b)) continue;
  console.log(`  ${linea(a)}`);
  console.log(`      ${resumen(a.id)}`);
  console.log(`  ${linea(b)}`);
  console.log(`      ${resumen(b.id)}\n`);
}

console.log(`=== B) Mismo apellido y nombre con documentos distintos: ${mismosNombres.length} grupo(s) ===`);
for (const g of mismosNombres) {
  if (!g.some(pasaFiltro)) continue;
  for (const p of g) {
    console.log(`  ${linea(p)}`);
    console.log(`      ${resumen(p.id)}`);
  }
  console.log('');
}
