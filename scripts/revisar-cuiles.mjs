// Diagnóstico y reparación de las fichas con el CUIL inválido.
//
// Sólo repara lo que se puede DEMOSTRAR con lo que ya está cargado. Nunca elige entre dos
// candidatos: un DNI adivinado es peor que un DNI faltante, porque la ficha queda cruzando contra
// la nómina equivocada y nadie se entera.
//
// Tres reglas, las tres sin invención:
//
//   A) El campo CUIL tiene un DNI con ceros a la izquierda ("00028472153" = DNI 28472153).
//      Un CUIL nunca empieza con 0: los prefijos son 20/23/24/27/30/33/34. El número se mueve al
//      campo DNI y el CUIL se vacía — el prefijo y el verificador no están en ningún lado, y el
//      sistema ya sabe buscar por DNI.
//
//   B) Falta el dígito verificador ("2026490696" = 10 dígitos: prefijo + DNI). El verificador NO
//      se adivina: se calcula con módulo 11 a partir de los otros diez.
//
//   C) Están bien el prefijo y el DNI, y el único dígito equivocado es el verificador. Se detecta
//      porque los 8 dígitos del medio coinciden con el DNI que la ficha ya tiene cargado aparte.
//      Ese DNI es el testigo; sin testigo no se toca.
//
// Todo lo demás se lista para verificar contra el papel. Queda a propósito sin arreglar: hay
// fichas donde cambiar un solo dígito da siete CUIL válidos distintos, con siete DNI distintos.
//
// Uso:
//   node scripts/revisar-cuiles.mjs             # DRY-RUN: sólo informa
//   node scripts/revisar-cuiles.mjs --apply     # aplica A, B y C
// En Fly:
//   fly ssh console -C "node /app/scripts/revisar-cuiles.mjs"

import Database from 'better-sqlite3';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const storage = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const dbPath = path.join(storage, 'data', 'sistema.db');
const db = new Database(dbPath);

const soloDigitos = (s) => String(s ?? '').replace(/[^0-9]/g, '');

// Copia EXACTA de esCuilValido / PREFIJOS_CUIL del backend (personas/service.ts). Si diverge, este
// script "arreglaría" CUIL que el sistema sigue rechazando.
const PREFIJOS_CUIL = ['20', '23', '24', '27', '30', '33', '34'];
const MULT = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** El verificador que le corresponde a esos 10 dígitos, o null si el módulo 11 da 10 (no existe). */
function verificadorDe(diez) {
  const suma = MULT.reduce((acc, m, i) => acc + m * Number(diez[i]), 0);
  let ver = 11 - (suma % 11);
  if (ver === 11) ver = 0;
  return ver === 10 ? null : ver;
}

function esCuilValido(n) {
  if (!/^[0-9]{11}$/.test(n)) return false;
  if (!PREFIJOS_CUIL.includes(n.slice(0, 2))) return false;
  return verificadorDe(n.slice(0, 10)) === Number(n[10]);
}

const dniDe = (cuil) => cuil.slice(2, 10).replace(/^0+/, '');
const esDni = (d) => /^[0-9]{7,8}$/.test(d);

/** El DNI que la ficha ya tiene cargado aparte, si es un DNI y no el CUIL copiado en ese campo. */
function dniTestigo(p) {
  const d = soloDigitos(p.dni).replace(/^0+/, '');
  return esDni(d) ? d : null;
}

/** Sólo informativo: todos los CUIL válidos a un dígito de distancia. */
function correccionesAUnDigito(cuil) {
  const out = new Set();
  for (let i = 0; i < 11; i++) {
    for (let d = 0; d <= 9; d++) {
      if (Number(cuil[i]) === d) continue;
      const cand = cuil.slice(0, i) + d + cuil.slice(i + 1);
      if (esCuilValido(cand)) out.add(cand);
    }
  }
  return [...out];
}

const personas = db.prepare('SELECT id, nombre, apellido, cuil, dni FROM personas').all();
const invalidas = personas.filter((p) => {
  const c = soloDigitos(p.cuil);
  return c.length > 0 && !esCuilValido(c);
});

const arreglos = [];   // { p, cuil, dni, regla, desc }
const aMano = [];      // { p, motivo, sugerencias }

for (const p of invalidas) {
  const c = soloDigitos(p.cuil);

  // A) es un DNI con ceros adelante, no un CUIL
  if (c.startsWith('0')) {
    const dni = c.replace(/^0+/, '');
    if (esDni(dni)) {
      arreglos.push({ p, cuil: null, dni, regla: 'A', desc: `es el DNI ${dni} con ceros adelante; se vacía el CUIL` });
    } else {
      aMano.push({ p, motivo: `empieza con 0 pero sin los ceros quedan ${dni.length} dígitos, no un DNI` });
    }
    continue;
  }

  // B) falta el dígito verificador
  if (c.length === 10 && PREFIJOS_CUIL.includes(c.slice(0, 2)) && esDni(c.slice(2).replace(/^0+/, ''))) {
    const ver = verificadorDe(c);
    if (ver !== null) {
      const cuil = c + String(ver);
      arreglos.push({ p, cuil, dni: dniDe(cuil), regla: 'B', desc: `le faltaba el verificador; se calcula ${ver}` });
      continue;
    }
  }

  if (c.length !== 11) {
    aMano.push({ p, motivo: `tiene ${c.length} dígitos, no 11` });
    continue;
  }

  // C) el DNI cargado aparte confirma los 10 primeros: el error está en el verificador
  const testigo = dniTestigo(p);
  if (testigo && PREFIJOS_CUIL.includes(c.slice(0, 2)) && dniDe(c) === testigo) {
    const ver = verificadorDe(c.slice(0, 10));
    if (ver !== null) {
      arreglos.push({ p, cuil: c.slice(0, 10) + String(ver), dni: testigo, regla: 'C', desc: `el DNI cargado (${testigo}) confirma los 10 primeros; el verificador era ${ver}` });
      continue;
    }
  }

  const sug = correccionesAUnDigito(c);
  aMano.push({
    p,
    motivo: sug.length === 0 ? 'ningún cambio de un dígito lo hace válido' : `${sug.length} corrección(es) posible(s), ninguna demostrable`,
    sugerencias: sug,
  });
}

// El DNI es UNIQUE: si el que se recupera ya es de otra ficha, estamos ante un duplicado (la misma
// persona cargada dos veces) y eso se resuelve fusionando, no pisando un campo. Se saca del lote.
const porDni = new Map();
for (const p of personas) {
  const d = soloDigitos(p.dni).replace(/^0+/, '');
  if (d) (porDni.get(d) ?? porDni.set(d, []).get(d)).push(p.id);
}
for (let i = arreglos.length - 1; i >= 0; i--) {
  const a = arreglos[i];
  const otros = (porDni.get(a.dni) ?? []).filter((id) => id !== a.p.id);
  if (otros.length > 0) {
    aMano.push({ p: a.p, motivo: `el DNI ${a.dni} que se recupera ya es de la ficha #${otros.join(', #')} — es un duplicado, hay que fusionar` });
    arreglos.splice(i, 1);
  }
}

console.log(`Base: ${dbPath}`);
console.log(`Personas: ${personas.length} · con CUIL inválido: ${invalidas.length}`);
console.log(`  se arreglan solas: ${arreglos.length}  (A: ${arreglos.filter((a) => a.regla === 'A').length} · B: ${arreglos.filter((a) => a.regla === 'B').length} · C: ${arreglos.filter((a) => a.regla === 'C').length})`);
console.log(`  hay que verificarlas contra el papel: ${aMano.length}`);

console.log('\n--- SE ARREGLAN SOLAS ---');
for (const a of arreglos) {
  console.log(`  [${a.regla}] #${a.p.id} ${a.p.apellido}, ${a.p.nombre}: cuil ${a.p.cuil} / dni ${a.p.dni ?? '—'}`);
  console.log(`        -> cuil ${a.cuil ?? '(vacío)'} / dni ${a.dni} — ${a.desc}`);
}

console.log('\n--- A VERIFICAR CONTRA EL PAPEL ---');
for (const x of aMano) {
  console.log(`  #${x.p.id} ${x.p.apellido}, ${x.p.nombre}: ${x.p.cuil} — ${x.motivo}`);
  if (x.sugerencias?.length) {
    console.log(`        posibles: ${x.sugerencias.map((c) => `${c} (DNI ${dniDe(c)})`).join(' | ')}`);
  }
}

if (!APPLY) {
  console.log('\nDRY-RUN. Nada se modificó. Para aplicar: --apply');
  process.exit(0);
}

const upd = db.prepare('UPDATE personas SET cuil = ?, dni = ? WHERE id = ?');
db.transaction((filas) => {
  for (const f of filas) upd.run(f.cuil, f.dni, f.p.id);
})(arreglos);
console.log(`\nAplicado: ${arreglos.length} ficha(s).`);
