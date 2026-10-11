/**
 * De qué empresa habla un papel.
 *
 * Suena trivial y no lo es: en un certificado de ART conviven DOS empresas, la que contrata y la
 * aseguradora que emite. Agarrando el primer "CUIT" que aparece se termina informando el de la
 * aseguradora —que está en el pie de cada hoja— en vez del del empleador, y entonces el dato no
 * sirve para lo único que importa, que es notar si el local mandó la ART de otra empresa.
 *
 * Dos cosas lo hacen difícil en los PDF reales:
 *  - La etiqueta viene escrita "C.U.I.T", con puntos.
 *  - El texto sale desordenado: el valor puede quedar ANTES de su etiqueta
 *    ("30-71680837-4 : DELTA FACILITY SERVICES Empresa C.U.I.T Contrato").
 *
 * Por eso no se busca "la etiqueta y después el número", sino todos los CUIT de empresa del
 * documento, quedándose con el que está más cerca de una palabra que hable del contratante.
 */

/** Prefijos de CUIT de persona jurídica. Los de persona física (20/23/24/27) no son la empresa. */
const PREFIJOS_EMPRESA = ['30', '33', '34'];

/** Palabras que marcan al contratante, no a quien emite el papel. */
const ETIQUETAS_CONTRATANTE = ['razon social', 'empresa', 'asegurada', 'asegurado', 'contratante', 'empleador'];

/** Cerca = en la misma zona del texto. Más lejos que esto ya es otra parte del documento. */
const CERCA = 160;

function normalizar(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

interface Candidato {
  cuit: string;
  /** Dónde arranca en el texto, para medir contra las etiquetas. */
  pos: number;
}

/** Todos los CUIT de empresa del documento, en orden de aparición. */
function cuitsDeEmpresa(text: string): Candidato[] {
  const out: Candidato[] = [];
  const re = /(\d{2})[-\s.]?(\d{8})[-\s.]?(\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!PREFIJOS_EMPRESA.includes(m[1])) continue;
    const cuit = `${m[1]}${m[2]}${m[3]}`;
    // El mismo CUIT repetido (el pie de página de cada hoja) cuenta una sola vez, la primera.
    if (out.some((c) => c.cuit === cuit)) continue;
    out.push({ cuit, pos: m.index });
  }
  return out;
}

/** Dónde aparece cada palabra que habla del contratante. */
function posicionesDeEtiquetas(t: string): number[] {
  const pos: number[] = [];
  for (const etiqueta of ETIQUETAS_CONTRATANTE) {
    let desde = 0;
    for (;;) {
      const i = t.indexOf(etiqueta, desde);
      if (i < 0) break;
      pos.push(i);
      desde = i + etiqueta.length;
    }
  }
  return pos;
}

/**
 * Saca las letras sueltas de las puntas. La corrida de mayúsculas se come la inicial de la palabra
 * siguiente ("GMRA S.A.U. N" cuando después viene "Nomina"), y esa letra no es parte del nombre.
 */
function recortarLetrasSueltas(s: string): string {
  const palabras = s.split(' ').filter(Boolean);
  while (palabras.length > 0 && /^[A-ZÁÉÍÓÚÑ]$/.test(palabras[palabras.length - 1])) palabras.pop();
  while (palabras.length > 0 && /^[A-ZÁÉÍÓÚÑ]$/.test(palabras[0])) palabras.shift();
  return palabras.join(' ');
}

/**
 * El nombre de la empresa alrededor de una posición: la tira de palabras en MAYÚSCULAS más larga
 * que haya justo antes o justo después. En los certificados el nombre está pegado a la etiqueta,
 * de un lado o del otro según cómo haya salido la tabla.
 */
function nombreCerca(text: string, pos: number): string | null {
  const antes = text.slice(Math.max(0, pos - 90), pos);
  const despues = text.slice(pos, Math.min(text.length, pos + 90));
  const re = /[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ&.\s]{3,60}(?:S\.?\s?A\.?\s?U?\.?|S\.?\s?R\.?\s?L\.?)?/g;

  const candidatos: string[] = [];
  for (const trozo of [antes, despues]) {
    for (const m of trozo.matchAll(re)) {
      const limpio = recortarLetrasSueltas(m[0].replace(/\s+/g, ' ').trim());
      // Dos palabras como mínimo: un "CUIT" suelto o una sigla no son una razón social.
      if (limpio.split(' ').length >= 2) candidatos.push(limpio);
    }
  }
  if (candidatos.length === 0) return null;
  candidatos.sort((a, b) => b.length - a.length);
  return candidatos[0];
}

export function extractEmpresa(text: string | null): { nombre: string | null; cuit: string | null } | null {
  if (!text) return null;
  const t = normalizar(text);

  const candidatos = cuitsDeEmpresa(text);
  const etiquetas = posicionesDeEtiquetas(t);

  let cuit: string | null = null;
  let posElegida = -1;
  if (candidatos.length > 0) {
    // El CUIT que está más cerca de una palabra que nombre al contratante. Si ninguno está cerca,
    // el primero del documento: el encabezado habla del contratante y el pie de quien emite.
    let mejor = candidatos[0];
    let mejorDistancia = Infinity;
    for (const c of candidatos) {
      for (const e of etiquetas) {
        const d = Math.abs(c.pos - e);
        if (d < mejorDistancia) { mejorDistancia = d; mejor = c; }
      }
    }
    cuit = mejorDistancia <= CERCA ? mejor.cuit : candidatos[0].cuit;
    posElegida = mejorDistancia <= CERCA ? mejor.pos : candidatos[0].pos;
  }

  // El nombre se busca alrededor de la etiqueta más cercana al CUIT elegido; sin CUIT, alrededor de
  // la primera etiqueta que haya.
  let nombre: string | null = null;
  const refs = posElegida >= 0
    ? [...etiquetas].sort((a, b) => Math.abs(a - posElegida) - Math.abs(b - posElegida))
    : etiquetas;
  for (const ref of refs.slice(0, 3)) {
    nombre = nombreCerca(text, ref);
    if (nombre) break;
  }

  if (!nombre && !cuit) return null;
  return { nombre, cuit };
}
