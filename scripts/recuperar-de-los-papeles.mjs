// Arregla fichas rotas preguntándole a la DOCUMENTACIÓN, en vez de adivinar.
//
// Dos problemas distintos con la misma solución:
//
//   - Fichas con el NOMBRE roto, que el lector del cuerpo del correo dejó como
//     "Medina Joaquin Rodrigo DNI :, -" o "ALAN DANIEL (DNI:, OVIEDO". Limpiarlas con reglas
//     obliga a adivinar qué parte es el apellido, y ahí el orden cambia de un local a otro.
//   - Fichas con el CUIL inválido, que no se pueden corregir sin el papel porque cambiando un
//     dígito salen hasta once CUIL válidos distintos.
//
// Cada uno se resuelve distinto, y la diferencia importa:
//
//   - El CUIL SÍ se toma del papel. Se busca el DNI de la persona en los PDF de sus propias
//     solicitudes y se acepta el CUIL sólo si es válido Y sus 8 dígitos del medio son ese DNI. El
//     verificador es lo que confirma que ese CUIL es de esa persona y no de otra.
//   - El nombre NO se copia del papel: se LIMPIA el que ya está. Probando, el papel le proponía a
//     una ficha el nombre "Du, Du" —dos palabras sueltas de una póliza— y a otras les daba vuelta
//     el apellido y el nombre, porque cada nómina los escribe en un orden distinto. Limpiar es
//     determinista y no cambia ninguna palabra; copiar es apostar.
//
// Uso:
//   node scripts/recuperar-de-los-papeles.mjs            # DRY-RUN
//   node scripts/recuperar-de-los-papeles.mjs --apply

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { extractPdfText } from '../backend/dist/modules/ocr/service.js';
import { extractPeople } from '../backend/dist/modules/ai/classifier.js';
import { esCuilValido } from '../backend/dist/modules/personas/service.js';

const APPLY = process.argv.includes('--apply');
const storage = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const db = new Database(path.join(storage, 'data', 'sistema.db'));

const soloDig = (v) => String(v ?? '').replace(/\D/g, '');
const sinCeros = (v) => soloDig(v).replace(/^0+/, '');

/** El nombre quedó roto: trae signos o etiquetas que no existen en el nombre de una persona. */
const nombreRoto = (p) => /[:<>()]|\b(DNI|CUIL|Nombre|Asunto|Subject)\b/i.test(`${p.apellido ?? ''} ${p.nombre ?? ''}`);
const cuilRoto = (p) => !!soloDig(p.cuil) && !esCuilValido(soloDig(p.cuil));

/**
 * Saca del nombre la basura que le dejó el lector del cuerpo, sin cambiar las palabras que hay.
 *
 * El nombre NO se copia del papel aunque el papel lo tenga: probando, a una ficha le proponía
 * "Du, Du" —dos palabras sueltas de una póliza— y a otras les daba vuelta el apellido y el nombre,
 * porque cada nómina los escribe en un orden distinto. Limpiar es determinista; copiar es apostar.
 * El CUIL sí se toma del papel, porque ahí el verificador confirma que es de esa persona.
 */
/**
 * Se valida el RESULTADO, no sólo la entrada: limpiar con reglas deja cosas como "de orden, Número"
 * o "también sumo a FERNANDEZ SANDRA VANESA ., Así", que siguen sin ser un nombre. Si lo que
 * queda no parece un nombre de persona, la ficha no se toca y va a la lista de mirar a mano.
 */
const PALABRAS_QUE_NO_VAN = /\b(orden|asunto|subject|resultado|revision|revisión|sumo|tambien|también|correo|email|mail|solicitud|fao|dni|cuil|cuit|nombre)\b/i;
function pareceNombreLimpio(apellido, nombre) {
  const junto = `${apellido} ${nombre}`.trim();
  if (PALABRAS_QUE_NO_VAN.test(junto)) return false;
  if (/[^\p{L}\s'ñÑ]/u.test(junto)) return false;          // sólo letras, espacios y apóstrofos
  const palabras = junto.split(/\s+/).filter((w) => w.length >= 2);
  return palabras.length >= 2 && palabras.length <= 6;
}

function limpiarNombre(p) {
  const limpiar = (v) => String(v ?? '')
    .replace(/\([^)]*\)?/g, ' ')          // "(DNI:" o "(franquera)"
    .split(/(?:DNI|CUIL|CUIT|Nombre|Asunto|Subject)/i)[0]
    .replace(/[:<>*·,\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let apellido = limpiar(p.apellido);
  let nombre = limpiar(p.nombre);
  // Si de un lado no quedó nada, se parte lo que sobrevivió del otro: primera palabra el apellido.
  if (!nombre && apellido.includes(' ')) {
    const w = apellido.split(' ');
    apellido = w[0];
    nombre = w.slice(1).join(' ');
  } else if (!apellido && nombre.includes(' ')) {
    const w = nombre.split(' ');
    apellido = w[0];
    nombre = w.slice(1).join(' ');
  }
  if (!apellido || !nombre) return null;           // sin las dos partes no se toca
  if (apellido === p.apellido && nombre === p.nombre) return null;  // ya estaba bien
  if (!pareceNombreLimpio(apellido, nombre)) return null;
  return { apellido, nombre };
}

const personas = db.prepare('SELECT id, nombre, apellido, cuil, dni FROM personas').all();
const rotas = personas.filter((p) => nombreRoto(p) || cuilRoto(p));

// Los PDF de las solicitudes de cada persona. Una misma solicitud sirve para todas sus personas,
// así que se abre y se lee UNA vez.
const solicitudesDe = db.prepare(`
  SELECT DISTINCT s.id, e.raw_stored_path AS raw
  FROM solicitud_personas sp
  JOIN solicitudes s ON s.id = sp.solicitud_id
  JOIN email_messages e ON e.id = s.email_message_id
  WHERE sp.persona_id = ? AND e.raw_stored_path IS NOT NULL
`);

const cache = new Map(); // raw -> Map(dni -> {nombre, apellido, cuil})
async function gentePapel(raw) {
  if (cache.has(raw)) return cache.get(raw);
  const out = new Map();
  if (fs.existsSync(raw)) {
    try {
      const parsed = await simpleParser(fs.readFileSync(raw));
      for (const a of parsed.attachments ?? []) {
        const nombre = a.filename ?? '';
        if (!/\.pdf$/i.test(nombre) && !/pdf/i.test(a.contentType ?? '')) continue;
        const t = await extractPdfText(a.content);
        if (!t.ok || !t.text) continue;
        for (const g of extractPeople(t.text)) {
          const k = sinCeros(g.dni);
          // El primero que aparezca con nombre gana: los siguientes suelen ser repeticiones.
          if (k && !out.get(k)?.apellido) out.set(k, { ...g, archivo: nombre, texto: t.text });
        }
      }
    } catch { /* un .eml ilegible no frena al resto */ }
  }
  cache.set(raw, out);
  return out;
}

/** El CUIL que el papel da para ese DNI, sólo si es válido y su medio ES ese DNI. */
function cuilDelPapel(texto, dni) {
  for (const m of texto.matchAll(/\d{2}[-\s.]?\d{8}[-\s.]?\d/g)) {
    const c = soloDig(m[0]);
    if (c.length === 11 && esCuilValido(c) && sinCeros(c.slice(2, 10)) === dni) return c;
  }
  return null;
}

const arreglos = [];
const sinRespuesta = [];

for (const p of rotas) {
  const dni = sinCeros(p.dni);
  let encontrado = null;
  for (const s of solicitudesDe.all(p.id)) {
    const gente = await gentePapel(s.raw);
    const g = gente.get(dni);
    if (g) { encontrado = g; break; }
  }
  // Sin papel igual se puede limpiar el nombre: eso no necesita ninguna fuente externa.
  if (!encontrado) {
    const soloLimpieza = limpiarNombre(p);
    if (soloLimpieza) arreglos.push({ p, cambios: soloLimpieza, archivo: '(limpieza del nombre, sin papel)' });
    else sinRespuesta.push(p);
    continue;
  }

  const cambios = {};
  const limpio = limpiarNombre(p);
  if (limpio) Object.assign(cambios, limpio);
  if (cuilRoto(p) || !p.cuil) {
    const c = cuilDelPapel(encontrado.texto, dni);
    if (c && c !== soloDig(p.cuil)) cambios.cuil = c;
  }
  if (Object.keys(cambios).length) arreglos.push({ p, cambios, archivo: encontrado.archivo });
  else sinRespuesta.push(p);
}

console.log(`Fichas con el nombre o el CUIL roto: ${rotas.length}`);
console.log(`  el papel las resuelve: ${arreglos.length}`);
console.log(`  el papel no dice nada: ${sinRespuesta.length}`);

console.log('\n--- LO QUE DICEN LOS PAPELES ---');
for (const a of arreglos) {
  console.log(`  #${a.p.id} "${a.p.apellido}, ${a.p.nombre}" — dni ${a.p.dni} · cuil ${a.p.cuil ?? '—'}`);
  const partes = [];
  if (a.cambios.apellido) partes.push(`nombre -> "${a.cambios.apellido}, ${a.cambios.nombre}"`);
  if (a.cambios.cuil) partes.push(`cuil -> ${a.cambios.cuil}`);
  console.log(`      ${partes.join(' · ')}   (de ${a.archivo})`);
}

console.log('\n--- EL PAPEL NO LAS RESUELVE (quedan para mirar a mano) ---');
for (const p of sinRespuesta) {
  console.log(`  #${p.id} "${p.apellido}, ${p.nombre}" — dni ${p.dni} · cuil ${p.cuil ?? '—'}`);
}

if (!APPLY) {
  console.log('\nDRY-RUN. Nada se modificó. Para aplicar: --apply');
  process.exit(0);
}

const upd = db.prepare('UPDATE personas SET nombre = COALESCE(?, nombre), apellido = COALESCE(?, apellido), cuil = COALESCE(?, cuil) WHERE id = ?');
let aplicados = 0;
db.transaction(() => {
  for (const a of arreglos) {
    try {
      upd.run(a.cambios.nombre ?? null, a.cambios.apellido ?? null, a.cambios.cuil ?? null, a.p.id);
      aplicados++;
    } catch (e) {
      // Un CUIL que ya tiene otra ficha es un duplicado, no un dato a pisar: se saltea y se avisa.
      console.log(`  (#${a.p.id} no se pudo: ${e.message})`);
    }
  }
  db.prepare('INSERT INTO audit_log (accion, entidad, entidad_id, detalle_json) VALUES (?, ?, ?, ?)')
    .run('PERSONAS_RECUPERADAS_DE_PAPELES', 'persona', '0', JSON.stringify({ aplicados, total: arreglos.length }));
})();

console.log(`\nAplicado: ${aplicados} ficha(s) corregidas con lo que dice su propia documentación.`);
