import { normalizeDni } from '../personas/service.js';

export interface Classification {
  codigo: string | null;
  confianza: number; // 0..1
  candidatos: { codigo: string; score: number }[];
}

// Palabras clave por tipo de documento (en minúscula, sin acentos).
//
// El match es por PALABRA COMPLETA, no por substring. No es un detalle: con `includes`, la palabra
// "art" matcheaba dentro de "cuarto", "departamento", "partida" y "carta", así que un PDF con el
// texto "el cuarto departamento envia la partida" se clasificaba como Nómina ART con 99% de
// confianza. Una frase larga pesa más que una palabra suelta, porque "art" aparece en cualquier
// lado y "aseguradora de riesgos del trabajo" no.
const KEYWORDS: Record<string, string[]> = {
  ART: ['art', 'aseguradora de riesgos', 'riesgos del trabajo', 'contrato de afiliacion', 'certificado de afiliacion', 'experta art', 'ley 24.557', '24.557', 'asegurada por', 'nomina'],
  SEGURO_VIDA: ['seguro de vida', 'vida colectivo', 'seguro colectivo', 'poliza de vida', 'vida obligatorio', 'beneficiario', 'suma asegurada'],
  MONOTRIBUTO: ['monotributo', 'monotributista', 'regimen simplificado', 'recategorizacion', 'constancia de monotributo'],
  CLAUSULA_NO_REPETICION: ['clausula de no repeticion', 'no repeticion', 'renuncia a repetir', 'cencosud'],
  // Los dos que faltaban, y son documentación OBLIGATORIA: sin ellos un F931 o un pago de ARCA
  // caían en ART (por la "art" de "departamento") o quedaban sin reconocer.
  FORM_931: ['formulario 931', 'f931', 'f 931', '931', 'declaracion jurada', 'cargas sociales', 'sicoss', 'seguridad social'],
  PAGO_ARCA: ['arca', 'agencia de recaudacion y control aduanero', 'volante electronico de pago', 'vep', 'comprobante de pago'],
};

// Pistas por nombre de archivo.
const FILENAME_HINTS: Record<string, string[]> = {
  ART: ['art', 'nomina'],
  SEGURO_VIDA: ['seguro', 'vida'],
  MONOTRIBUTO: ['monotributo', 'mono'],
  CLAUSULA_NO_REPETICION: ['clausula', 'norepeticion', 'no repeticion', 'repeticion', 'cencosud'],
  FORM_931: ['931', 'f931', 'ddjj'],
  PAGO_ARCA: ['arca', 'afip', 'vep'],
};

/**
 * Deja el texto como una tira de palabras separadas por un espacio y rodeada de espacios, para
 * poder buscar una frase completa con un simple `includes` sin que matchee dentro de otra palabra.
 */
function enPalabras(s: string): string {
  const limpio = normalize(s).replace(/[^a-z0-9]+/g, ' ').trim();
  return ` ${limpio} `;
}

/** ¿Aparece la frase como palabra(s) completa(s)? */
function contiene(textoEnPalabras: string, frase: string): boolean {
  return textoEnPalabras.includes(enPalabras(frase));
}

/** Cuántas palabras tiene la frase: una frase larga es mucha más evidencia que una palabra suelta. */
const peso = (frase: string) => enPalabras(frase).trim().split(' ').length;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export function classifyDocument(text: string | null, filename: string): Classification {
  const t = enPalabras(text ?? '');
  const fn = enPalabras(filename);
  const scores: Record<string, number> = {};
  // Si el PDF no tiene texto (escaneado), nos apoyamos más en el nombre del archivo.
  const sinTexto = t.trim().length < 20;
  const fnWeight = sinTexto ? 1.0 : 0.5;

  for (const [codigo, words] of Object.entries(KEYWORDS)) {
    let score = 0;
    for (const w of words) if (contiene(t, w)) score += peso(w);
    for (const h of FILENAME_HINTS[codigo] ?? []) if (contiene(fn, h)) score += fnWeight * peso(h);
    if (score > 0) scores[codigo] = score;
  }

  const candidatos = Object.entries(scores)
    .map(([codigo, score]) => ({ codigo, score }))
    .sort((a, b) => b.score - a.score);

  if (candidatos.length === 0) return { codigo: null, confianza: 0, candidatos: [] };

  const top = candidatos[0];
  const total = candidatos.reduce((s, c) => s + c.score, 0);
  // Confianza: proporción del score del ganador, acotada.
  const confianza = Math.min(0.99, total > 0 ? top.score / total : 0);
  // Solo asignamos si hay una ventaja razonable.
  const codigo = confianza >= 0.5 && top.score >= 1 ? top.codigo : null;
  return { codigo, confianza, candidatos };
}

/** Extrae un DNI (7-8 dígitos) del texto. Devuelve null si no hay uno claro. */
export function extractDni(text: string | null): string | null {
  if (!text) return null;
  // Buscar patrones tipo 32.361.606 o 32361606
  const matches = text.match(/\b\d{1,2}[.\s]?\d{3}[.\s]?\d{3}\b/g) ?? [];
  for (const m of matches) {
    const norm = normalizeDni(m);
    if (norm.length >= 7 && norm.length <= 8) return norm;
  }
  return null;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Formas societarias: marcan que la tira de mayúsculas es una empresa y no una persona. */
const MARCAS_EMPRESA = new Set(['SA', 'SRL', 'SAU', 'SAIC', 'SACIF', 'SAICF', 'SAS', 'SH', 'LTDA', 'SCA', 'SE']);

const NAME_STOP = new Set([
  'DNI', 'SEXO', 'SEX', 'NACIONALIDAD', 'NATIONALITY', 'EJEMPLAR', 'REPUBLICA', 'ARGENTINA', 'MERCOSUR',
  'DOCUMENTO', 'DOCUMENT', 'NACIONAL', 'IDENTIDAD', 'REGISTRO', 'MINISTERIO', 'INTERIOR', 'SURNAME', 'NAME',
  'APELLIDO', 'APELLIDOS', 'NOMBRE', 'NOMBRES', 'CUIL', 'CUIT', 'FECHA', 'DATE', 'NACIMIENTO', 'BIRTH',
  'TRAMITE', 'DOMICILIO', 'FIRMA', 'M', 'F',
  // Encabezados de la nómina ART
  'TIPO', 'EMPLEADO', 'EMPLEADOS', 'DECLARADOS', 'RAZON', 'SOCIAL', 'CONTRATO', 'VIGENCIA', 'EXPERTA', 'ART',
  'ASEGURADORA', 'RIESGOS', 'TRABAJO', 'CERTIFICADO', 'AFILIACION', 'FOLIO', 'PAGINA',
  // Vocabulario de las pólizas: son las filas de coberturas, no personas. Sin esto entraban como
  // gente "GASTOS DE SEPELIO", "SUMA ASEGURADA" o "TERCERA EDAD".
  'POLIZA', 'PRESTACIONAL', 'CONDICION', 'SUMA', 'ASEGURADA', 'ASEGURADO', 'GASTOS', 'SEPELIO',
  'TERCERA', 'EDAD', 'CAPITAL', 'PROVINCIA', 'ACTIVA', 'PRIMA', 'COBERTURA', 'COBERTURAS',
  'BENEFICIARIO', 'MUERTE', 'ACCIDENTAL', 'INCAPACIDAD', 'PARCIAL', 'PERMANENTE', 'REEMBOLSO',
  'FRANQUICIA', 'PLAN', 'BASICO', 'NOMINA', 'ALIANZAS', 'SOCIEDAD', 'ANONIMA', 'SEGUROS', 'SEGURO',
]);

/**
 * Las tiras de 2 o más palabras en MAYÚSCULAS del segmento ("APELLIDO NOMBRE").
 *
 * Devuelve todas y en orden, porque cuál sirve depende de dónde está el número: si el nombre va
 * antes, la que vale es la ÚLTIMA (la pegada al número); si va después, la PRIMERA. Antes esto
 * arrancaba desde el principio del segmento y se rendía a las 2 palabras que no fueran nombre, así
 * que en una fila de tabla real ("Fecha de alta  JULIAN DAVID  CORTES  46325229") cortaba en
 * "Fecha de alta" y no encontraba a nadie.
 */
/**
 * Dos palabras de al menos tres letras. Sin este piso, "EMPLEADOS DECLARADOS EN EL CONTRATO" deja
 * "EN EL" como si fuera un apellido y un nombre.
 */
const sirveComoNombre = (words: string[]) => words.filter((w) => w.length >= 3).length >= 2;

function nameRuns(seg: string): string[][] {
  const runs: string[][] = [];
  let actual: string[] = [];
  for (const tok of seg.split(/\s+/)) {
    if (/^[A-ZÁÉÍÓÚÑ]{2,}$/.test(tok) && !NAME_STOP.has(tok) && !MARCAS_EMPRESA.has(tok)) {
      actual.push(tok);
      continue;
    }
    // "ON MARCA SA" no es una persona. Descartar la tira entera, no cortarla: si sólo se cortara,
    // "ON MARCA" seguiría pasando por nombre. En un certificado de ART la razón social está en el
    // encabezado, justo antes del primer CUIL, y hacía creer que los nombres van ANTES del número:
    // con eso, cada CUIL se quedaba con el nombre de la persona SIGUIENTE.
    if (sirveComoNombre(actual) && !MARCAS_EMPRESA.has(tok)) runs.push(actual);
    actual = [];
  }
  if (sirveComoNombre(actual)) runs.push(actual);
  return runs;
}

/**
 * Arma apellido y nombre de una tira de mayúsculas, según en qué orden los escribe el documento.
 *
 * Las nóminas de ART ponen "APELLIDO NOMBRE" y las constancias de seguro "NOMBRE APELLIDO", y el
 * papel lo dice en el encabezado de la tabla ("Apellido y Nombres" contra "Nombre/s Apellido/s").
 * Sin mirar eso, la mitad de los documentos entra con el nombre y el apellido cambiados.
 */
function comoNombre(words: string[], apellidoPrimero: boolean) {
  if (apellidoPrimero) {
    return { apellido: titleCase(words[0]), nombre: titleCase(words.slice(1, 4).join(' ')) };
  }
  return {
    apellido: titleCase(words[words.length - 1]),
    nombre: titleCase(words.slice(0, -1).slice(0, 3).join(' ')),
  };
}

/**
 * ¿El documento escribe primero el apellido?
 *
 * Sólo se invierte si las dos palabras están JUNTAS, como en el encabezado de una tabla
 * ("Nombre/s  Apellido/s  D.N.I."). Buscándolas sueltas por todo el texto se invertía de más: un
 * certificado de ART cuya tabla dice "Nombre del Empleado" nombraba "apellido" en la letra chica,
 * a dos páginas de distancia, y entraba toda la nómina al revés.
 */
function apellidoVaPrimero(text: string): boolean {
  const t = normalize(text);
  const JUNTAS = 40;
  for (let i = t.indexOf('apellido'); i >= 0; i = t.indexOf('apellido', i + 1)) {
    const antes = t.lastIndexOf('nombre', i);
    const despues = t.indexOf('nombre', i);
    if (antes >= 0 && i - antes <= JUNTAS) return false; // "Nombre ... Apellido"
    if (despues >= 0 && despues - i <= JUNTAS) return true; // "Apellido ... Nombre"
  }
  return true; // la convención de las nóminas
}

/**
 * El papel dice qué es ese número, y no es un documento. Si lo dice, le creemos: sin esto entraban
 * como personas el "N° de folio" (con el nombre de quien confeccionó el papel al lado) y los
 * números de contrato y de póliza.
 */
function esOtroNumero(text: string, start: number): boolean {
  const antes = normalize(text.slice(Math.max(0, start - 26), start));
  return /(folio|contrato|poliza|expediente|tramite|factura|recibo|comprobante|transaccion|sucursal|cuenta|orden)\W{0,12}$/.test(antes);
}

/** La tira de mayúsculas más cercana al número: la última si el nombre va antes, la primera si va después. */
function nameSequence(seg: string, lado: 'antes' | 'despues' = 'despues', apellidoPrimero = true): { nombre: string; apellido: string } | null {
  const runs = nameRuns(seg);
  if (runs.length === 0) return null;
  return comoNombre(lado === 'antes' ? runs[runs.length - 1] : runs[0], apellidoPrimero);
}

/** Toma las palabras en MAYÚSCULAS que siguen a una etiqueta, hasta encontrar otra palabra o stop-word. */
function grabNameAfter(text: string, labelRe: RegExp): string | null {
  const m = text.match(labelRe);
  if (!m || m.index === undefined) return null;
  const rest = text.slice(m.index + m[0].length);
  const words: string[] = [];
  let skipped = 0;
  for (const tok of rest.split(/\s+/)) {
    if (/^[A-ZÁÉÍÓÚÑ]{2,}$/.test(tok) && !NAME_STOP.has(tok)) words.push(tok);
    else if (words.length === 0 && skipped++ < 2) continue; // saltar "/ Surname" etc. antes del valor
    else break;
  }
  return words.length ? words.slice(0, 3).join(' ') : null;
}

/** Extrae Apellido/Nombre desde el texto de un documento (ej. DNI). null si no se puede.
 *  Soporta el formato bilingüe del DNI argentino: "Apellido / Surname" y "Nombre / Name". */
export function extractNombreApellido(text: string | null): { nombre: string; apellido: string } | null {
  if (!text) return null;
  const apellido = grabNameAfter(text, /apellidos?\s*(?:\/?\s*surname)?\s*[:\-]?\s*/i);
  const nombre = grabNameAfter(text, /nombres?\s*(?:\/?\s*name)?\s*[:\-]?\s*/i);
  if (apellido && nombre) return { apellido: titleCase(apellido), nombre: titleCase(nombre) };
  return null;
}

export interface ExtractedPerson {
  dni: string;
  nombre: string | null;
  apellido: string | null;
}

const COMA_NAME = /([A-ZÁÉÍÓÚÑ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ]{2,})?)\s*,\s*([A-ZÁÉÍÓÚÑ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ]{2,})?)/g;

/** Deduce Apellido/Nombre en un segmento de texto, tomando la coincidencia MÁS CERCANA al final
 *  (la más próxima al DNI, para no confundirse con la persona anterior de la planilla). */
function nameFromSegment(seg: string): { nombre: string; apellido: string } | null {
  // Patrón "APELLIDO, NOMBRE": tomar la última aparición del segmento.
  let last: RegExpMatchArray | null = null;
  COMA_NAME.lastIndex = 0;
  let mm: RegExpExecArray | null;
  while ((mm = COMA_NAME.exec(seg))) last = mm;
  if (last) return { apellido: titleCase(last[1].trim()), nombre: titleCase(last[2].trim()) };
  // Etiquetas Apellido:/Nombre:
  const etiq = extractNombreApellido(seg);
  if (etiq) return etiq;
  return null;
}

/**
 * Extrae TODAS las personas presentes en un texto (una planilla/PDF puede tener varias).
 * Para cada DNI se busca el nombre en el segmento que va desde el DNI anterior hasta este,
 * evitando así arrastrar el nombre de la persona previa. El nombre es best-effort (puede
 * quedar null y lo completa/verifica Seguridad). Nunca inventa nombres.
 */
/** Deriva el DNI de un CUIL/CUIT de persona (8 dígitos del medio, sin el 0 de relleno). */
export function dniFromCuil(cuil: string): string | null {
  const digits = cuil.replace(/\D/g, '');
  if (digits.length !== 11) return null;
  const prefijo = digits.slice(0, 2);
  // Prefijos de PERSONA física (20,23,24,25,26,27). Empresas: 30/33/34 -> no es persona.
  if (!['20', '23', '24', '25', '26', '27'].includes(prefijo)) return null;
  return digits.slice(2, 10).replace(/^0+/, '');
}

const esDigito = (c: string) => c >= '0' && c <= '9';

/**
 * ¿El número está solo, o es un pedazo de uno más grande?
 *
 * Es la diferencia entre un documento y un importe. En un F931 todo son pesos con separador de
 * miles: de "2.375.330.846,84" se recortaba "2.375.330" y quedaba como el DNI 2375330. Una
 * solicitud llegó a ofrecer 22 "personas" que eran los totales del formulario.
 */
function numeroSuelto(text: string, start: number, end: number): boolean {
  const antes = text[start - 1] ?? ' ';
  const anteAntes = text[start - 2] ?? ' ';
  const despues = text[end] ?? ' ';
  const traDespues = text[end + 1] ?? ' ';
  if (esDigito(antes) || esDigito(despues)) return false;
  // Pegado a un separador que a su vez toca dígitos: es el medio de un número largo.
  if ((antes === '.' || antes === ',') && esDigito(anteAntes)) return false;
  if ((despues === '.' || despues === ',') && esDigito(traDespues)) return false;
  return true;
}

/**
 * ¿Es plata y no un documento?
 *
 * Dos señales. El signo peso adelante, y el número redondo: los importes de las pólizas vienen con
 * separador de miles y terminan en cero ("Suma asegurada 50.098.533"), y ahí no hay ningún "$" que
 * los delate. Un DNI que termine en tres ceros existe pero es rarísimo; una suma asegurada que no
 * termine en cero, prácticamente no.
 */
function esPlata(text: string, start: number, raw: string): boolean {
  for (let i = start - 1; i >= 0 && i >= start - 3; i--) {
    const c = text[i];
    if (c === '$') return true;
    if (c !== ' ') break;
  }
  const digitos = raw.replace(/\D/g, '');
  return /[.\s]/.test(raw) && digitos.endsWith('000');
}

/** ¿Hay un "tel" justo antes? Los 0800 y los teléfonos tienen la misma forma que un documento. */
function esTelefono(text: string, start: number): boolean {
  return /tel[eé]?f?o?n?o?\.?:?\s*[+\d\s()-]{0,14}$/i.test(text.slice(Math.max(0, start - 30), start));
}

export function extractPeople(text: string | null): ExtractedPerson[] {
  if (!text) return [];
  // 1) Encontrar todos los identificadores válidos (CUIL de persona o DNI).
  const re = /(\d{2}[-\s]?\d{8}[-\s]?\d|\d{1,2}[.\s]?\d{3}[.\s]?\d{3})/g;
  const found: { dni: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[1];
    if (!numeroSuelto(text, m.index, m.index + raw.length)) continue;
    const soloDigitos = raw.replace(/\D/g, '');
    let dni: string | null = null;
    if (soloDigitos.length === 11) {
      dni = dniFromCuil(raw); // CUIL de persona; CUIT de empresa (30/33/34) -> null
    } else if (soloDigitos.length >= 7 && soloDigitos.length <= 8) {
      // Un número de 7 u 8 dígitos solo es un documento si algo lo respalda.
      //
      // Antes alcanzaba con que tuviera puntos, y eso estaba mal en las dos direcciones: aceptaba
      // el teléfono "0800 555 9998" y el importe "$ 12.625.850", y rechazaba la fila de una tabla
      // de verdad ("JULIAN DAVID  CORTES  46325229"), que no lleva puntos ni la palabra DNI al lado.
      // Ahora lo que respalda es que tenga la etiqueta antes, o un nombre pegado.
      if (!esPlata(text, m.index, raw) && !esTelefono(text, m.index) && !esOtroNumero(text, m.index) && soloDigitos[0] !== '0') {
        const antes = text.slice(Math.max(0, m.index - 40), m.index);
        const despues = text.slice(m.index + raw.length, m.index + raw.length + 40);
        const conEtiqueta = /(dni|documento|docum|l\.?c|l\.?e)\W*$/.test(normalize(antes));
        const conNombre = !!(nameFromSegment(antes) || nameSequence(antes, 'antes') || nameSequence(despues, 'despues'));
        if (conEtiqueta || conNombre) dni = soloDigitos;
      }
    }
    if (dni) found.push({ dni, start: m.index, end: m.index + raw.length });
  }

  if (found.length === 0) return [];

  // 2) Decidir de qué lado del número está el nombre, UNA VEZ para todo el documento.
  //
  // Hay dos formatos y no se pueden mezclar por fila: la planilla escribe "PEREZ, JUAN - DNI 35..."
  // (nombre antes) y la nómina de ART escribe "CUIL 20... PEREZ JUAN" (nombre después). Probar
  // primero un lado y si falla el otro parece más tolerante, pero es peor: cuando a una fila de una
  // nómina no se le puede leer el nombre (el PDF lo cortó, p.ej. "SANCHEZ ANAH-"), el lado de atrás
  // devuelve el nombre de la persona ANTERIOR y esa fila queda con el nombre de otro. Un nombre
  // vacío se completa a mano; un nombre de otra persona no se nota.
  // El nombre tiene que estar PEGADO al número. Sin este tope, el primer identificador se llevaba
  // como nombre cualquier cosa desde el arranque del documento: en un F931 terminaba con el usuario
  // logueado en ARCA, que está en el encabezado, a miles de caracteres del número.
  const CERCA = 120;
  const segAntes = (i: number) => {
    const desde = Math.max(i > 0 ? found[i - 1].end : 0, found[i].start - CERCA);
    return text.slice(desde, found[i].start);
  };
  const segDespues = (i: number) => {
    const hasta = Math.min(i < found.length - 1 ? found[i + 1].start : text.length, found[i].end + CERCA);
    return text.slice(found[i].end, hasta);
  };

  // El primer identificador es el único que decide sin ambigüedad: lo que hay ANTES es el
  // encabezado y lo que hay DESPUÉS sólo puede ser su propio nombre. En el medio de la lista, el
  // texto que está antes de una fila es exactamente el que está después de la anterior, así que
  // contar filas empata cuando son pocas.
  const hayAntes = (i: number) => !!(nameFromSegment(segAntes(i)) || nameSequence(segAntes(i), 'antes'));
  const hayDespues = (i: number) => !!nameSequence(segDespues(i), 'despues');

  let nombreVaDespues: boolean;
  if (hayDespues(0) && !hayAntes(0)) nombreVaDespues = true;
  else if (hayAntes(0) && !hayDespues(0)) nombreVaDespues = false;
  else {
    // La primera fila no alcanza: se mira toda la lista y, si aun así empata, gana "antes", que es
    // el formato de las planillas.
    let aciertosAntes = 0;
    let aciertosDespues = 0;
    for (let i = 0; i < found.length; i++) {
      if (hayAntes(i)) aciertosAntes++;
      if (hayDespues(i)) aciertosDespues++;
    }
    nombreVaDespues = aciertosDespues > aciertosAntes;
  }

  // 3) Aplicar ese criterio a todas las filas. Si de ese lado no hay nombre, queda null.
  const apellidoPrimero = apellidoVaPrimero(text);
  const people: ExtractedPerson[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < found.length; i++) {
    const cur = found[i];
    if (seen.has(cur.dni)) continue;
    seen.add(cur.dni);
    const name = nombreVaDespues
      ? nameSequence(segDespues(i), 'despues', apellidoPrimero)
      : nameFromSegment(segAntes(i)) || nameSequence(segAntes(i), 'antes', apellidoPrimero);
    people.push({ dni: cur.dni, apellido: name?.apellido ?? null, nombre: name?.nombre ?? null });
  }
  return people;
}

/** Detecta si la documentación es de una Empresa o de un Monotributista. null si no está claro. */
export function detectCategoria(text: string | null): 'EMPRESA' | 'MONOTRIBUTISTA' | null {
  if (!text) return null;
  const t = normalize(text);
  const empresa = ['931', 'formulario 931', 'cargas sociales', 'nomina', 'declaracion jurada', 'seguridad social'].filter((k) => t.includes(k)).length;
  const mono = ['monotributo', 'monotributista', 'regimen simplificado', 'recategorizacion'].filter((k) => t.includes(k)).length;
  if (empresa > 0 && empresa >= mono) return 'EMPRESA';
  if (mono > 0 && mono > empresa) return 'MONOTRIBUTISTA';
  return null;
}

const MESES: Record<string, string> = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10', noviembre: '11', diciembre: '12',
};

const iso = (y: string, mo: string, d: string) => {
  if (y.length === 2) y = `20${y}`;
  const s = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isNaN(new Date(s).getTime()) ? null : s;
};

/** Extrae la fecha de EMISIÓN del documento (YYYY-MM-DD). null si no se puede determinar.
 *  Soporta "05/08/2026" y el formato de carta "12 de agosto de 2026".
 *  Evita confundirse con fechas de vigencia ("hasta el 31 de julio de 2027"). */
export function extractEmision(text: string | null): string | null {
  if (!text) return null;
  const t = normalize(text);
  let m: RegExpExecArray | null;

  // 1) Fecha del encabezado de la carta ("... Buenos Aires, 12 de agosto de 2026").
  m = /buenos aires[,\s]+(?:a\s+)?(\d{1,2})\s+de\s+([a-zñ]+)\s+de\s+(\d{4})/.exec(t);
  if (m && MESES[m[2]]) { const d = iso(m[3], MESES[m[2]], m[1]); if (d) return d; }
  m = /buenos aires[,\s]+(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(t);
  if (m) { const d = iso(m[3], m[2], m[1]); if (d) return d; }

  // 2) Fecha junto a una etiqueta de emisión/pago.
  m = /(emision|emitido|emitida|fecha de emision|fecha de pago|de pago|pago)[^0-9]{0,20}(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(t);
  if (m) { const d = iso(m[4], m[3], m[2]); if (d) return d; }

  // 3) Primera fecha del texto que NO venga después de "hasta" (evita fechas de vigencia).
  const noEsHasta = (idx: number) => !/hasta\s*(?:el\s*)?$/.test(t.slice(Math.max(0, idx - 12), idx));
  const reTxt = /(\d{1,2})\s+de\s+([a-zñ]+)\s+de\s+(\d{4})/g;
  while ((m = reTxt.exec(t))) {
    if (MESES[m[2]] && noEsHasta(m.index)) { const d = iso(m[3], MESES[m[2]], m[1]); if (d) return d; }
  }
  const reNum = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/g;
  while ((m = reNum.exec(t))) {
    if (noEsHasta(m.index)) { const d = iso(m[3], m[2], m[1]); if (d) return d; }
  }
  return null;
}

/** Extrae la empresa contratista (nombre + CUIT) de un documento. null si no se detecta. */
// extractEmpresa vive en empresa.ts: distinguir al contratante de la aseguradora dentro del mismo
// papel resulto tener suficiente logica propia como para leerse aparte.
export { extractEmpresa } from './empresa.js';

/** Extrae una fecha de vencimiento del texto (formato de salida YYYY-MM-DD). null si no hay. */
export function extractVencimiento(text: string | null): string | null {
  if (!text) return null;
  const t = normalize(text);
  // Buscar cerca de la palabra "vencimiento" / "vence" / "validez" / "hasta".
  // El año va de 2 o 4 dígitos, nunca 3: con {2,4} un "14/08/202" cortado en el PDF daba el año
  // 202 y salía una fecha del año 202 d.C. como vencimiento.
  const re = /(vencimiento|vence|validez|hasta|vigencia)([^0-9]{0,20})(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})(?![0-9])/g;
  let match: RegExpExecArray | null;
  const fechas: string[] = [];
  while ((match = re.exec(t))) {
    // "vigencia DESDE el 20/09/2017" es la fecha de INICIO, no el vencimiento. Sin este filtro, un
    // certificado sin fecha de fin devolvía su fecha de arranque como vencimiento, y salían
    // documentos de 2026 "vencidos" en 2017.
    if (/(desde|a partir|inicio)/.test(match[0])) continue;
    const d = match[3].padStart(2, '0');
    const mo = match[4].padStart(2, '0');
    let y = match[5];
    if (y.length === 2) y = `20${y}`;
    const iso = `${y}-${mo}-${d}`;
    if (!isNaN(new Date(iso).getTime())) fechas.push(iso);
  }
  if (fechas.length === 0) return null;
  // La más lejana suele ser el vencimiento.
  fechas.sort();
  return fechas[fechas.length - 1];
}
