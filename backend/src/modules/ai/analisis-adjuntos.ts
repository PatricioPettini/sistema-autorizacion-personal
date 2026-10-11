import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { todayLocal } from '../../lib/datetime.js';
import { extractPdfText } from '../ocr/service.js';
import { esCuilValido, normalizeCuil, normalizeDni } from '../personas/service.js';
import { classifyDocument, extractPeople, extractEmision, extractVencimiento, extractEmpresa } from './classifier.js';

/**
 * Lee la documentación que llegó por correo y dice qué es y de quién habla.
 *
 * No aprueba, no rechaza y no cambia ningún estado: solo muestra lo que dice el papel, para que el
 * que revisa no tenga que abrir nueve PDF y buscar los CUIL a ojo. Todo lo que devuelve está
 * escrito en el documento; si algo no se pudo leer, lo dice.
 *
 * Se apaga entero con ANALISIS_ADJUNTOS=0: la pantalla vuelve exactamente a lo de antes.
 *
 * A propósito NO hace OCR. `extractPdfText` es rápido (pdfjs, sin imagen), pero el OCR de un
 * escaneo tarda segundos por página y esto corre cuando alguien abre la solicitud. Un PDF escaneado
 * o una foto se informan como "no se pudo leer", que es la verdad y es accionable.
 */

/** Del código que devuelve el clasificador al tipo de documento que exige el sistema. */
const CODIGO_A_TIPO: Record<string, string> = {
  ART: 'NOMINA_ART',
  SEGURO_VIDA: 'SEGURO_VIDA_COLECTIVO',
  MONOTRIBUTO: 'PAGO_MONOTRIBUTO',
  CLAUSULA_NO_REPETICION: 'CLAUSULA_NO_REPETICION',
};

export interface AdjuntoAnalizado {
  emailId: number;
  index: number;
  filename: string;
  /** Código del tipo de documento del sistema, si se reconoció. */
  tipo: string | null;
  tipoNombre: string | null;
  confianza: number;
  emision: string | null;
  vencimiento: string | null;
  empresa: { nombre: string | null; cuit: string | null } | null;
  /** Las personas que MENCIONA el papel (las de la nómina de una ART, por ejemplo). */
  personas: { dni: string; nombre: string | null; apellido: string | null }[];
  leido: boolean;
  nota: string | null;
}

export interface PersonaCubierta {
  personaId: number;
  nombre: string;
  dni: string | null;
  /** Archivos que la nombran. */
  en: string[];
}

export interface AnalisisSolicitud {
  activo: boolean;
  adjuntos: AdjuntoAnalizado[];
  /** Cruce contra las personas de la solicitud. */
  cubiertas: PersonaCubierta[];
  sinCubrir: PersonaCubierta[];
  /** DNI que aparecen en los papeles y no están en la solicitud. */
  ajenas: { dni: string; nombre: string | null; apellido: string | null; en: string }[];
  sinLeer: number;
  /**
   * Hasta cuándo alcanza la documentación: el vencimiento MÁS TEMPRANO de todos los papeles.
   * La autorización no puede durar más que el documento que se vence primero. Es una sugerencia
   * para no tipear la fecha a mano; la confirma el que revisa.
   */
  vigenciaSugerida: { fecha: string; archivos: string[]; vencida: boolean } | null;
}

/**
 * Los adjuntos no cambian una vez escrito el .eml, así que el análisis de uno se puede cachear para
 * siempre. Se acota el tamaño para no acumular sin techo en una máquina de 512 MB.
 */
const cache = new Map<string, AdjuntoAnalizado>();
const CACHE_MAX = 400;

/** Identificadores con los que se puede reconocer a una persona en un papel. */
function documentosDe(p: { dni: string | null; cuil: string | null }): Set<string> {
  const ids = new Set<string>();
  const dni = normalizeDni(p.dni ?? '').replace(/^0+/, '');
  if (dni.length >= 7 && dni.length <= 8) ids.add(dni);
  const cuil = normalizeCuil(p.cuil ?? '');
  // El CUIL contiene al DNI, pero los dígitos del medio solo son confiables si el verificador da.
  if (esCuilValido(cuil)) ids.add(cuil.slice(2, 10).replace(/^0+/, ''));
  return ids;
}

async function analizarUno(emailId: number, index: number, filename: string, contentType: string | undefined, buffer: Buffer): Promise<AdjuntoAnalizado> {
  const clave = `${emailId}:${index}:${buffer.length}`;
  const hit = cache.get(clave);
  if (hit) return hit;

  const base: AdjuntoAnalizado = {
    emailId, index, filename, tipo: null, tipoNombre: null, confianza: 0,
    emision: null, vencimiento: null, empresa: null, personas: [], leido: false, nota: null,
  };

  const esPdf = /pdf/i.test(contentType ?? '') || /\.pdf$/i.test(filename);
  let texto: string | null = null;
  if (esPdf) {
    const r = await extractPdfText(buffer);
    texto = r.text;
    if (!r.ok) base.nota = r.note ?? 'No se pudo leer el PDF.';
  } else {
    base.nota = 'No es un PDF: no se lee su contenido.';
  }

  if (texto) {
    base.leido = true;
    const c = classifyDocument(texto, filename);
    base.confianza = c.confianza;
    if (c.codigo) {
      base.tipo = CODIGO_A_TIPO[c.codigo] ?? c.codigo;
      base.tipoNombre = db.select({ nombre: schema.documentTypes.nombre }).from(schema.documentTypes)
        .where(eq(schema.documentTypes.codigo, base.tipo)).get()?.nombre ?? null;
    }
    base.emision = extractEmision(texto);
    base.vencimiento = extractVencimiento(texto);
    // Un papel no puede vencer antes de emitirse. Cuando eso pasa, lo que se leyó no es el
    // vencimiento sino la fecha de INICIO de la cobertura: muchos certificados de ART dicen
    // "Vigencia: 01/09/2023" refiriéndose a cuándo empieza la afiliación, no a cuándo termina.
    // Preferimos no saber la fecha antes que informar un vencimiento inventado.
    if (base.vencimiento && base.emision && base.vencimiento < base.emision) {
      base.vencimiento = null;
      base.nota = 'La fecha de vigencia del papel es anterior a su emisión: es el inicio, no el vencimiento.';
    }
    base.empresa = extractEmpresa(texto);
    base.personas = extractPeople(texto).map((p) => ({ dni: p.dni, nombre: p.nombre, apellido: p.apellido }));
  }

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(clave, base);
  return base;
}

/**
 * Analiza la documentación de una solicitud y la cruza contra su gente.
 *
 * `adjuntos` viene de quien ya abrió los .eml (el endpoint de documentación), para no volver a
 * parsear los correos acá.
 */
export async function analizarSolicitud(
  solicitudId: number,
  adjuntos: { emailId: number; index: number; filename: string; contentType?: string; content: Buffer }[],
): Promise<AnalisisSolicitud> {
  if (!env.analisisAdjuntos) {
    return { activo: false, adjuntos: [], cubiertas: [], sinCubrir: [], ajenas: [], sinLeer: 0, vigenciaSugerida: null };
  }

  const analizados: AdjuntoAnalizado[] = [];
  for (const a of adjuntos) {
    try {
      analizados.push(await analizarUno(a.emailId, a.index, a.filename, a.contentType, a.content));
    } catch (err) {
      logger.warn({ err }, `No se pudo analizar el adjunto ${a.filename}`);
    }
  }

  // --- Cruce contra las personas de la solicitud -------------------------------------------
  const personas = db
    .select({ id: schema.personas.id, nombre: schema.personas.nombre, apellido: schema.personas.apellido, dni: schema.personas.dni, cuil: schema.personas.cuil })
    .from(schema.solicitudPersonas)
    .innerJoin(schema.personas, eq(schema.personas.id, schema.solicitudPersonas.personaId))
    .where(eq(schema.solicitudPersonas.solicitudId, solicitudId))
    .all();

  const cubiertas: PersonaCubierta[] = [];
  const sinCubrir: PersonaCubierta[] = [];
  for (const p of personas) {
    const ids = documentosDe(p);
    const en = analizados
      .filter((a) => a.personas.some((x) => ids.has(x.dni.replace(/^0+/, ''))))
      .map((a) => a.filename);
    const fila: PersonaCubierta = {
      personaId: p.id,
      nombre: `${p.apellido}, ${p.nombre}`,
      dni: [...ids][0] ?? null,
      en,
    };
    (en.length > 0 ? cubiertas : sinCubrir).push(fila);
  }

  // Gente que nombran los papeles y no está en la solicitud. Suele ser el resto de la nómina de la
  // ART (normal), pero también delata una ART que no es de este grupo.
  const idsSolicitud = new Set<string>();
  for (const p of personas) for (const id of documentosDe(p)) idsSolicitud.add(id);
  const ajenas: AnalisisSolicitud['ajenas'] = [];
  const vistas = new Set<string>();
  for (const a of analizados) {
    for (const p of a.personas) {
      const dni = p.dni.replace(/^0+/, '');
      if (idsSolicitud.has(dni) || vistas.has(dni)) continue;
      vistas.add(dni);
      ajenas.push({ dni, nombre: p.nombre, apellido: p.apellido, en: a.filename });
    }
  }

  const vencimientos = analizados.filter((a) => a.vencimiento);
  const primero = vencimientos.map((a) => a.vencimiento!).sort()[0] ?? null;

  return {
    activo: true,
    adjuntos: analizados,
    cubiertas,
    sinCubrir,
    ajenas,
    sinLeer: analizados.filter((a) => !a.leido).length,
    vigenciaSugerida: primero
      ? {
          fecha: primero,
          archivos: vencimientos.filter((a) => a.vencimiento === primero).map((a) => a.filename),
          vencida: primero < todayLocal(),
        }
      : null,
  };
}

/** Para los tests: el cache es global y los adjuntos se identifican por tamaño. */
export function limpiarCacheAnalisis(): void {
  cache.clear();
}

