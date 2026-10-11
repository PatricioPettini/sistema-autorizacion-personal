import { eq, or, like } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { nowIso } from '../../lib/datetime.js';

/** Normaliza un CUIL/CUIT: solo dígitos. */
export function normalizeCuil(cuil: string): string {
  return (cuil || '').replace(/\D/g, '');
}

/** Prefijos válidos de CUIL/CUIT: 20/23/24/27 personas, 30/33/34 personas jurídicas. */
const PREFIJOS_CUIL = ['20', '23', '24', '27', '30', '33', '34'];

/** Verifica un CUIL de verdad: largo, prefijo y dígito verificador (módulo 11). */
export function esCuilValido(valor: string): boolean {
  const n = normalizeCuil(valor);
  if (n.length !== 11) return false;
  if (!PREFIJOS_CUIL.includes(n.slice(0, 2))) return false;
  const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = mult.reduce((acc, m, i) => acc + m * Number(n[i]), 0);
  let ver = 11 - (suma % 11);
  if (ver === 11) ver = 0;
  if (ver === 10) return false;
  return ver === Number(n[10]);
}

/**
 * Decide qué es CUIL y qué es DNI a partir de lo que vino en la planilla.
 *
 * La columna de CUIL trae cualquier cosa: un DNI con ceros adelante (Excel rellena a 11), un DNI
 * pelado, un número inventado. Guardar eso como CUIL rompe el reconocimiento de la persona: la
 * próxima vez que llega con su DNI limpio no coincide con nada y se crea una segunda ficha. Pasó
 * de verdad — un mismo empleado quedó dos veces, una con "00094959396" como CUIL y otra con
 * 94959396 como DNI, cada una con su autorización.
 *
 * Regla: solo se guarda como CUIL lo que ES un CUIL. Lo que no lo es pero parece un DNI (7 u 8
 * dígitos al quitarle los ceros de adelante) se guarda como DNI.
 *
 * `dniConfiable` dice si el DNI vino en los datos o si se dedujo de los dígitos del medio del
 * CUIL. Un DNI deducido sirve para GUARDAR (la columna es NOT NULL) pero no para BUSCAR: dos
 * CUIL distintos que difieren solo en el verificador tienen el mismo medio, y matchear por ahí
 * fusionaría a dos personas diferentes en una sola ficha.
 */
export function interpretarDocumento(cuilCrudo?: string | null, dniCrudo?: string | null): { cuil: string; dni: string; dniConfiable: boolean } {
  const c = normalizeCuil(cuilCrudo ?? '');
  const d = normalizeDni(dniCrudo ?? '');
  const dniLimpio = d.replace(/^0+/, '');

  const esDni = (x: string) => x.length >= 7 && x.length <= 8;
  // El DNI de la planilla se toma solo si PARECE un DNI. Muchas planillas repiten el CUIL en la
  // columna DNI, y así se guardaban documentos de 11 dígitos en el campo DNI: un número que no
  // existe en ningún documento y que Seguridad no puede encontrar al buscar a la persona en la
  // puerta. Cuando no sirve, el DNI se saca del propio CUIL (son los 8 dígitos del medio) y queda
  // marcado como no confiable, así no se usa para emparejar personas.
  const conCuil = (cuil: string) => (esDni(dniLimpio)
    ? { cuil, dni: dniLimpio, dniConfiable: true }
    : { cuil, dni: cuil.slice(2, 10).replace(/^0+/, ''), dniConfiable: false });

  // Un CUIL válido trae el DNI adentro: son los 8 dígitos del medio.
  if (esCuilValido(c)) return conCuil(c);

  // 11 dígitos con prefijo de CUIL pero verificador mal: casi siempre es un CUIL mal tipeado.
  // Se conserva tal cual —perderlo sería peor— para que una persona lo corrija.
  if (c.length === 11 && PREFIJOS_CUIL.includes(c.slice(0, 2))) return conCuil(c);

  // 10 dígitos con prefijo de CUIL: es un CUIL al que le falta el verificador (se corta al copiar y
  // pegar). No se adivina: se prueba cuál de los diez dígitos lo hace válido, y sólo si hay
  // exactamente uno se acepta. Sin esto la misma persona entraba dos veces —una con el CUIL bien y
  // otra con el CUIL cortado—, que es como se duplicaron GARCIA y CASTILLO.
  if (c.length === 10 && PREFIJOS_CUIL.includes(c.slice(0, 2))) {
    const completos = '0123456789'.split('').map((v) => c + v).filter(esCuilValido);
    if (completos.length === 1) return conCuil(completos[0]);
  }

  // Lo que no es un CUIL pero parece un DNI (7 u 8 dígitos sin los ceros de adelante) es un DNI.
  const cLimpio = c.replace(/^0+/, '');
  if (esDni(dniLimpio)) return { cuil: '', dni: dniLimpio, dniConfiable: true };
  if (esDni(cLimpio)) return { cuil: '', dni: cLimpio, dniConfiable: true };

  // Ni CUIL ni DNI reconocible: se guarda lo que vino, sin inventarle un CUIL.
  return { cuil: '', dni: dniLimpio || cLimpio || d || c, dniConfiable: !!dniLimpio };
}

/** Formatea un CUIL: 20306550097 -> 20-30655009-7 */
export function formatCuil(cuil: string): string {
  const n = normalizeCuil(cuil);
  if (n.length !== 11) return n;
  return `${n.slice(0, 2)}-${n.slice(2, 10)}-${n.slice(10)}`;
}

// --- Compatibilidad DNI (bases viejas / utilidades) ---
export function normalizeDni(dni: string): string {
  return (dni || '').replace(/\D/g, '');
}
export function formatDni(dni: string): string {
  const n = normalizeDni(dni);
  return n.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

const FALTA = '(a completar)';

/**
 * ¿Esto parece el nombre de una persona?
 *
 * Cuando el correo no trae Excel, la lista de personas se busca en el cuerpo, y ahí el parser
 * levanta pedazos de la firma del remitente y los toma por una fila de la tabla. Pasó de verdad:
 * de "Valeria Keller · Gerente Suc 10 · (+54.11) 2312-5766" salió una persona llamada "(+54.11)"
 * con documento 23125766 — ocho dígitos, que pasa cualquier validación de DNI. Lo que no pasa es
 * el nombre: un nombre tiene letras y no tiene dígitos.
 *
 * Se exige poco a propósito (dos letras y ningún dígito): un nombre mal cortado se corrige a mano
 * en la ficha, pero un teléfono metido como persona ensucia el padrón y se autoriza a un fantasma.
 */
export function pareceNombreDePersona(nombre?: string | null, apellido?: string | null): boolean {
  const limpio = `${nombre ?? ''} ${apellido ?? ''}`.split(FALTA).join(' ').trim();
  if (/\d/.test(limpio)) return false;
  return (limpio.match(/\p{L}/gu) ?? []).length >= 2;
}
const esMayus = (w: string) => w.length > 1 && w === w.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(w);

/**
 * Separa un "nombre completo" en nombre + apellido, tolerando los formatos usuales:
 *  - "Apellido, Nombre"            -> coma: lo de antes es apellido.
 *  - "APELLIDO COMPUESTO Nombre"   -> palabras iniciales en MAYÚSCULAS = apellido.
 *  - "Nombre Apellido"             -> (por defecto) primera palabra nombre, resto apellido.
 */
export function splitNombreCompleto(full: string): { nombre: string; apellido: string } {
  const s = (full || '').trim().replace(/\s+/g, ' ');
  if (!s) return { nombre: FALTA, apellido: FALTA };

  if (s.includes(',')) {
    const [ape, ...rest] = s.split(',');
    const apellido = ape.trim();
    const nombre = rest.join(',').trim();
    return { nombre: nombre || FALTA, apellido: apellido || FALTA };
  }

  const parts = s.split(' ').filter(Boolean);
  if (parts.length === 1) return { nombre: parts[0], apellido: FALTA };

  // Apellido en MAYÚSCULAS al inicio y nombre en minúsculas/Título después
  // (ej. "MARQUEZ ESTEBAN Antonio" -> apellido "MARQUEZ ESTEBAN", nombre "Antonio").
  let up = 0;
  while (up < parts.length && esMayus(parts[up])) up++;
  if (up >= 1 && up < parts.length) {
    return { nombre: parts.slice(up).join(' '), apellido: parts.slice(0, up).join(' ') };
  }

  return { nombre: parts[0], apellido: parts.slice(1).join(' ') };
}

const esPlaceholder = (v: string | null | undefined) => {
  const t = (v || '').trim();
  return t === '' || t === FALTA || /^\d+$/.test(t); // vacío, "(a completar)" o un número (bug viejo)
};

export function findPersonaByCuil(cuil: string) {
  const norm = normalizeCuil(cuil);
  if (!norm) return null;
  return db.select().from(schema.personas).where(eq(schema.personas.cuil, norm)).get() ?? null;
}

/**
 * Busca a una persona por el número que le lee Seguridad EN LA PUERTA.
 *
 * El documento que la persona muestra dice el DNI, no el CUIL, y el CUIL trae el DNI adentro (son
 * los 8 dígitos del medio). Buscar solo por la columna `cuil` exacta obligaba a tipear los 11
 * dígitos, que nadie tiene a mano: con el DNI del documento no encontraba a nadie.
 *
 * Acepta los dos: 11 dígitos busca el CUIL (o un DNI cargado como 11, que todavía quedan algunos),
 * 7 u 8 dígitos busca el DNI y además el CUIL que lo contenga.
 */
export function findPersonaByDocumento(valor: string) {
  const n = (valor || '').replace(/\D/g, '');
  if (!n) return null;
  if (n.length === 11) {
    const porCuil = db.select().from(schema.personas)
      .where(or(eq(schema.personas.cuil, n), eq(schema.personas.dni, n))).get();
    if (porCuil) return porCuil;
    // La misma persona puede estar cargada SOLO con su DNI, y el CUIL lo contiene. Se busca por
    // los 8 del medio, pero solo si el verificador da: con un CUIL mal tipeado esos dígitos no
    // son confiables y encontraríamos a otra persona.
    if (!esCuilValido(n)) return null;
    const delMedio = n.slice(2, 10).replace(/^0+/, '');
    return db.select().from(schema.personas).where(eq(schema.personas.dni, delMedio)).get() ?? null;
  }
  if (n.length >= 7 && n.length <= 8) {
    // El medio de un CUIL son 8 dígitos: un DNI de 7 va con un cero adelante.
    const medio = n.padStart(8, '0');
    return db.select().from(schema.personas)
      .where(or(eq(schema.personas.dni, n), like(schema.personas.cuil, `__${medio}_`))).get() ?? null;
  }
  return db.select().from(schema.personas).where(eq(schema.personas.dni, n)).get() ?? null;
}

export interface PersonaInput {
  cuil?: string;
  dni?: string;
  nombre: string;
  apellido: string;
}

/**
 * Busca por CUIL y, si no, por DNI; si no existe la crea. Nunca duplica.
 * Acepta identificar por CUIL (11 díg.) o por DNI (7-8 díg.). La columna `dni` es
 * NOT NULL UNIQUE: guardamos el DNI real, o el CUIL si es lo único que hay.
 * Además, si la persona existente tenía nombre placeholder ("(a completar)", vacío o
 * un número de un import viejo mal leído) y ahora llega el nombre real, lo corrige.
 */
export function findOrCreatePersona(input: PersonaInput): { persona: typeof schema.personas.$inferSelect; created: boolean } {
  const { cuil, dni, dniConfiable } = interpretarDocumento(input.cuil, input.dni);

  let existing = cuil ? findPersonaByCuil(cuil) : null;
  // Solo se busca por DNI si el DNI vino en los datos. Con uno deducido del medio del CUIL, dos
  // personas con CUIL parecido terminarían en la misma ficha.
  if (!existing && dni && dniConfiable) existing = db.select().from(schema.personas).where(eq(schema.personas.dni, dni)).get() ?? null;
  // El DNI deducido del medio del CUIL se usa para buscar solo si el CUIL es VÁLIDO (el
  // verificador confirma los dígitos del medio) y la ficha que lo tiene no declara OTRO CUIL. Un
  // DNI identifica a una persona: el prefijo 20/27 solo dice el tipo. Sin esto, una planilla que
  // lista a la misma persona dos veces —una fila con su DNI y otra con su CUIL, pasa seguido—
  // reventaba con "UNIQUE constraint failed: personas.dni" al insertar la segunda.
  if (!existing && dni && !dniConfiable && esCuilValido(cuil)) {
    const porDeducido = db.select().from(schema.personas).where(eq(schema.personas.dni, dni)).get() ?? null;
    if (porDeducido && (!porDeducido.cuil || porDeducido.cuil === cuil)) existing = porDeducido;
  }
  // Y al revés: viene un DNI y la persona ya está cargada con su CUIL. Buscar sólo en la columna
  // DNI no la encuentra cuando esa ficha tiene el CUIL guardado ahí (pasa cuando el DNI deducido
  // chocaba con otra ficha). Así se duplicó PERALTA: la misma persona con el CUIL y con el DNI.
  if (!existing && dni && dniConfiable) {
    const medio = dni.padStart(8, '0');
    const porCuilCargado = db.select().from(schema.personas).where(like(schema.personas.cuil, `__${medio}_`)).get() ?? null;
    // Si la entrada trae su propio CUIL y no es el de esa ficha, son dos personas distintas.
    if (porCuilCargado && (!cuil || porCuilCargado.cuil === cuil)) existing = porCuilCargado;
  }
  if (existing) {
    const inNombre = (input.nombre || '').trim();
    const inApellido = (input.apellido || '').trim();
    const setCuil = cuil && !existing.cuil ? cuil : existing.cuil;
    const setNombre = esPlaceholder(existing.nombre) && !esPlaceholder(inNombre) ? inNombre : existing.nombre;
    const setApellido = esPlaceholder(existing.apellido) && !esPlaceholder(inApellido) ? inApellido : existing.apellido;
    if (setCuil !== existing.cuil || setNombre !== existing.nombre || setApellido !== existing.apellido) {
      const actualizado = db
        .update(schema.personas)
        .set({ cuil: setCuil, nombre: setNombre, apellido: setApellido, updatedAt: nowIso() })
        .where(eq(schema.personas.id, existing.id))
        .returning()
        .get();
      return { persona: actualizado, created: false };
    }
    return { persona: existing, created: false };
  }

  // `dni` es NOT NULL UNIQUE. Si el que corresponde ya lo tiene otra ficha que NO es esta persona,
  // se guarda el CUIL en su lugar antes que fallar. Y si tampoco se puede, se explica por qué: un
  // "UNIQUE constraint failed" en el respaldo no le dice nada a quien tiene que resolverlo.
  const libre = (v: string) => !!v && !db.select().from(schema.personas).where(eq(schema.personas.dni, v)).get();
  const dniFinal = [dni, cuil].find(libre);
  if (!dniFinal) {
    const choca = db.select().from(schema.personas).where(eq(schema.personas.dni, dni || cuil)).get();
    throw new Error(`No se pudo dar de alta a ${input.apellido}, ${input.nombre}: el documento ${dni || cuil} ya lo tiene `      + `${choca ? `${choca.apellido}, ${choca.nombre} (CUIL ${choca.cuil ?? 'sin cargar'})` : 'otra ficha'}. Revisalo a mano.`);
  }
  const persona = db
    .insert(schema.personas)
    .values({ cuil: cuil || null, dni: dniFinal, nombre: input.nombre.trim(), apellido: input.apellido.trim() })
    .returning()
    .get();
  return { persona, created: true };
}

/**
 * Fichas que podrían ser la MISMA persona que la que se está por cargar, sin serlo exactamente.
 *
 * El duplicado que ninguna búsqueda por documento puede evitar es el typo: un dígito cambiado da
 * un número que existe y es de otra persona. La única red posible es avisar antes de crear la
 * ficha —"ya hay alguien que se llama igual", "ya hay alguien con un documento a un dígito"— y que
 * decida quien está cargando. No bloquea nada: informa.
 */
export interface PersonaParecida {
  id: number;
  nombre: string;
  apellido: string;
  dni: string | null;
  cuil: string | null;
  motivo: 'MISMO_NOMBRE' | 'DOCUMENTO_PARECIDO';
}

const sinAcentos = (s: string) =>
  (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Las fichas mezclan "Perez, Jose" y "Jose, Perez": se comparan las palabras, no el orden. */
function clavePorNombre(nombre?: string | null, apellido?: string | null): string {
  return sinAcentos(`${apellido ?? ''} ${nombre ?? ''}`).split(' ').filter((w) => w.length >= 3).sort().join(' ');
}

/** ¿Dos documentos del mismo largo que difieren en UN dígito? Es la forma del typo. */
function aUnDigito(a: string, b: string): boolean {
  if (a.length !== b.length || a === b) return false;
  let distintos = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++distintos > 1) return false;
  return distintos === 1;
}

export function buscarPersonasParecidas(input: { cuil?: string; dni?: string; nombre?: string; apellido?: string }): PersonaParecida[] {
  const doc = normalizeCuil(input.cuil ?? '') || normalizeDni(input.dni ?? '');
  const clave = clavePorNombre(input.nombre, input.apellido);
  if (!doc && !clave) return [];

  const exacta = doc ? findPersonaByDocumento(doc) : null;
  const out = new Map<number, PersonaParecida>();

  for (const p of db.select().from(schema.personas).all()) {
    // La que ya es la misma persona no es "parecida": esa la resuelve la búsqueda por documento.
    if (exacta && p.id === exacta.id) continue;

    const docP = [normalizeDni(p.dni ?? ''), normalizeCuil(p.cuil ?? '')].filter(Boolean);
    if (doc && docP.some((d) => aUnDigito(d, doc))) {
      out.set(p.id, { id: p.id, nombre: p.nombre, apellido: p.apellido, dni: p.dni, cuil: p.cuil, motivo: 'DOCUMENTO_PARECIDO' });
      continue;
    }
    if (clave && clavePorNombre(p.nombre, p.apellido) === clave) {
      out.set(p.id, { id: p.id, nombre: p.nombre, apellido: p.apellido, dni: p.dni, cuil: p.cuil, motivo: 'MISMO_NOMBRE' });
    }
  }
  // Primero el documento parecido: un typo es más grave que un homónimo.
  return [...out.values()].sort((a, b) => (a.motivo === b.motivo ? 0 : a.motivo === 'DOCUMENTO_PARECIDO' ? -1 : 1)).slice(0, 5);
}
