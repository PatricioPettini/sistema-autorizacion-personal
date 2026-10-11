import AdmZip from 'adm-zip';
import path from 'node:path';
import { parseXls } from './xls.js';

/**
 * Lectores mínimos de planillas SIN dependencias externas. Soportamos los formatos
 * que llegan por email desde los encargados de los locales:
 *   - .xlsx / .xlsm (Office Open XML): ZIP con XML.
 *   - .ods           (OpenDocument):  ZIP con content.xml.
 *   - .csv / .tsv    (texto plano):   delimitador auto-detectado (coma, punto y coma o tab).
 * Cada lector devuelve una matriz de filas/celdas como texto.
 */

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Convierte una referencia de columna ("A", "B", "AA") a índice base 0. */
function colToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function parseXlsx(buffer: Buffer): string[][] {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    return [];
  }

  // 1) Cadenas compartidas
  const shared: string[] = [];
  const ssEntry = zip.getEntry('xl/sharedStrings.xml');
  if (ssEntry) {
    const xml = ssEntry.getData().toString('utf8');
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = siRe.exec(xml))) {
      const inner = m[1];
      const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      let t: RegExpExecArray | null;
      let val = '';
      while ((t = tRe.exec(inner))) val += t[1];
      shared.push(decodeXmlEntities(val));
    }
  }

  // 2) Primera hoja
  let sheetXml = '';
  const s1 = zip.getEntry('xl/worksheets/sheet1.xml');
  if (s1) {
    sheetXml = s1.getData().toString('utf8');
  } else {
    const any = zip.getEntries().find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.entryName));
    if (any) sheetXml = any.getData().toString('utf8');
  }
  if (!sheetXml) return [];

  // 3) Filas y celdas
  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(sheetXml))) {
    const rowInner = r[1];
    const cells: string[] = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c: RegExpExecArray | null;
    while ((c = cRe.exec(rowInner))) {
      const attrs = c[1] ?? '';
      const body = c[2] ?? '';
      const refM = attrs.match(/r="([A-Z]+)\d+"/);
      const idx = refM ? colToIndex(refM[1]) : cells.length;
      const typeM = attrs.match(/t="([^"]+)"/);
      const type = typeM ? typeM[1] : 'n';
      let value = '';
      if (type === 's') {
        const vM = body.match(/<v>([\s\S]*?)<\/v>/);
        if (vM) value = shared[parseInt(vM[1], 10)] ?? '';
      } else if (type === 'inlineStr') {
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t: RegExpExecArray | null;
        let val = '';
        while ((t = tRe.exec(body))) val += t[1];
        value = decodeXmlEntities(val);
      } else {
        const vM = body.match(/<v>([\s\S]*?)<\/v>/);
        if (vM) value = decodeXmlEntities(vM[1]);
      }
      cells[idx] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

/**
 * Lector mínimo de archivos .ods (OpenDocument Spreadsheet). Igual que el .xlsx,
 * es un ZIP; los datos viven en content.xml (table:table-row / table:table-cell).
 * Lee la primera tabla. Respeta table:number-columns-repeated (celdas repetidas).
 */
export function parseOds(buffer: Buffer): string[][] {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    return [];
  }
  const entry = zip.getEntry('content.xml');
  if (!entry) return [];
  const xml = entry.getData().toString('utf8');

  // Primera tabla (una hoja del .ods).
  const tableM = xml.match(/<table:table\b[\s\S]*?<\/table:table>/);
  const tableXml = tableM ? tableM[0] : xml;

  const rows: string[][] = [];
  const rowRe = /<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(tableXml))) {
    const cells: string[] = [];
    const cellRe = /<table:(?:covered-)?table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(r[1]))) {
      const attrs = c[1] ?? '';
      const body = c[2] ?? '';
      const repM = attrs.match(/table:number-columns-repeated="(\d+)"/);
      const rep = repM ? Math.min(parseInt(repM[1], 10), 1024) : 1; // cap defensivo
      // El texto de la celda son sus <text:p> (uno o varios).
      const pRe = /<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g;
      let p: RegExpExecArray | null;
      let val = '';
      while ((p = pRe.exec(body))) val += (val ? ' ' : '') + p[1];
      val = decodeXmlEntities(val.replace(/<[^>]+>/g, '')); // quitar tags internos (<text:s/>, etc.)
      for (let i = 0; i < rep; i++) cells.push(val);
    }
    rows.push(cells);
  }
  return rows;
}

/** Parte una línea CSV/TSV respetando comillas dobles. */
function splitDelimited(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // comilla escapada ""
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Lee CSV/TSV. Autodetecta el delimitador (coma, punto y coma o tab). */
export function parseDelimited(buffer: Buffer): string[][] {
  const text = buffer.toString('utf8').replace(/^﻿/, ''); // saca el BOM
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  // Delimitador = el que más aparece en la primera línea (';' es común en configuraciones ES).
  const first = lines[0];
  const cont = (d: string) => first.split(d).length - 1;
  const delim = cont('\t') >= cont(';') && cont('\t') >= cont(',') ? '\t' : cont(';') >= cont(',') ? ';' : ',';
  return lines.map((l) => splitDelimited(l, delim));
}

/** Dispatcher: elige el lector según la extensión del archivo. */
export function parseSpreadsheet(filename: string, buffer: Buffer): string[][] {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.ods') return parseOds(buffer);
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') return parseDelimited(buffer);
  if (ext === '.xlsx' || ext === '.xlsm') return parseXlsx(buffer);
  if (ext === '.xls') return parseXls(buffer);
  // Sin extensión reconocible: probar por contenido.
  // OLE2 (.xls viejo) empieza con la firma D0CF11E0.
  if (buffer.length >= 8 && buffer.readUInt32LE(0) === 0xe011cfd0) { const x = parseXls(buffer); if (x.length) return x; }
  const rows = parseXlsx(buffer); // ZIP → xlsx
  if (rows.length) return rows;
  const ods = parseOds(buffer); // ZIP → ods
  if (ods.length) return ods;
  return parseDelimited(buffer);
}

export interface ExcelPersona {
  cuil?: string; // 10-11 dígitos
  dni?: string;  // 7-8 dígitos (cuando el remitente no manda CUIL)
  nombreCompleto: string;
  // Cuando la planilla trae columnas separadas de apellido y nombre, se cargan acá
  // (así no hay que adivinar el orden). Si viene una sola columna, quedan sin definir.
  nombre?: string;
  apellido?: string;
}

const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const soloDigitos = (s: string) => (s || '').replace(/\D/g, '');
const esCuil = (s: string) => { const d = soloDigitos(s); return d.length === 10 || d.length === 11; };

// Encabezados que indican una columna con el NOMBRE + APELLIDO juntos (una sola celda).
const HINTS_COMBINADO = ['nombre y apellido', 'apellido y nombre', 'nombre completo', 'nombreyapellido', 'apellidoynombre'];
// Encabezados que indican una columna de personas (cuando no dice "nombre"/"apellido").
const HINTS_PERSONA = ['personal', 'empleado', 'trabajador', 'operario', 'persona', 'agente', 'dotacion', 'integrante', 'dependiente'];

/** Elige la mejor columna de nombres: la que más texto con letras tiene (no la del índice/número). */
function mejorColumnaTexto(rows: string[][], desde: number, excluir: Set<number>): number {
  const anchos = Math.max(...rows.slice(desde).map((r) => r.length), 0);
  let best = -1;
  let bestScore = 0;
  for (let c = 0; c < anchos; c++) {
    if (excluir.has(c)) continue;
    let score = 0;
    for (let i = desde; i < rows.length; i++) {
      const v = (rows[i][c] ?? '').trim();
      if (/[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}/.test(v)) score++;
    }
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

/** Clasifica un identificador por su cantidad de dígitos: CUIL (10-11) o DNI (7-8). */
/**
 * Una FECHA no es un documento.
 *
 * Caso real: un local mando el cronograma de visitas de su consultora en una tabla
 * "Fecha | Locales". La tabla no tiene columna de documento, asi que el lector cae en "la columna
 * de ID es la que mas valores tipo CUIL/DNI tiene", y "Jue 03/09/2026" sin los separadores queda
 * 03092026: ocho digitos, un DNI perfecto. Se dieron de alta cinco personas llamadas
 * "BK Campana", "BK Wilde"... con las fechas como documento.
 *
 * El corte es por los separadores: un DNI o un CUIL nunca se escriben con barras, y un DNI con
 * puntos (12.345.678) no tiene esta forma. No se rechazan las fechas escritas sin separador,
 * porque 03092026 tambien puede ser un DNI de verdad.
 */
export function pareceFecha(raw: string): boolean {
  return /\d{1,2}\s*[/\-.]\s*\d{1,2}\s*[/\-.]\s*\d{2,4}/.test(raw || '');
}

export function clasificarId(raw: string): { cuil?: string; dni?: string } | null {
  if (pareceFecha(raw)) return null;
  const d = (raw || '').replace(/\D/g, '');
  if (d.length >= 10 && d.length <= 11) return { cuil: d };
  if (d.length >= 7 && d.length <= 8) return { dni: d };
  return null;
}

/**
 * Interpreta una planilla (ya leída como filas) para extraer personas (CUIL o DNI + nombre).
 * Es tolerante a los formatos reales que llegan de los encargados:
 *  - columna "CUIL"/"CUIT"/"DNI"/"Documento" en cualquier posición;
 *  - nombre en una sola columna ("Nombre completo", "Personal", "Empleado", ...) o
 *    en dos columnas separadas ("Apellido" y "Nombre");
 *  - mayúsculas/minúsculas, columnas de número de orden, encabezados que no dicen "nombre".
 */
export function filasAPersonas(rows: string[][]): ExcelPersona[] {
  if (rows.length === 0) return [];

  // 1) Buscar la fila de encabezado (cuil/cuit/dni/documento) y las columnas.
  //
  // Se busca en TODA la planilla, no en las primeras filas. Las que mandan los locales suelen
  // arrancar con media pantalla de instrucciones y texto legal antes de la tabla: en una real de
  // AROMA el encabezado "DNI | APELLIDO | NOMBRE" estaba en la fila 34, así que no se encontraba y
  // las personas salían sin nombre.
  //
  // Entre varias filas candidatas gana la que además tiene columna de nombre: en una planilla el
  // texto "DNI" puede aparecer suelto en una instrucción ("completar con el DNI de cada persona")
  // antes de la tabla de verdad.
  let headerIdx = -1;
  let idCol = -1;
  let apellidoCol = -1;
  let nombreCol = -1;
  let combinadoCol = -1;
  let respaldo: { i: number; idCol: number } | null = null;
  for (let i = 0; i < rows.length; i++) {
    const celdas = rows[i].map(norm);
    const cIdx = celdas.findIndex((v) => v.includes('cuil') || v.includes('cuit') || v.includes('dni') || v.includes('documento'));
    if (cIdx < 0) continue;

    let ape = -1, nom = -1, comb = -1;
    for (let j = 0; j < celdas.length; j++) {
      if (j === cIdx) continue;
      const h = celdas[j];
      if (!h) continue;
      if (HINTS_COMBINADO.some((x) => h.includes(x))) comb = j;
      else if (h.includes('apellido')) ape = j;
      else if (h.includes('nombre')) nom = j;
      else if (comb < 0 && HINTS_PERSONA.some((x) => h.includes(x))) comb = j;
    }

    if (ape < 0 && nom < 0 && comb < 0) {
      // Sin columna de nombre: sirve sólo si no aparece nada mejor más abajo.
      if (!respaldo) respaldo = { i, idCol: cIdx };
      continue;
    }
    headerIdx = i;
    idCol = cIdx;
    apellidoCol = ape;
    nombreCol = nom;
    combinadoCol = comb;
    break;
  }
  if (headerIdx < 0 && respaldo) {
    headerIdx = respaldo.i;
    idCol = respaldo.idCol;
  }

  // 1b) Comprobar que la columna elegida tenga documentos de verdad debajo.
  //
  // Hay planillas sin encabezado donde la palabra "CUIT" se repite como etiqueta en cada fila
  // ("BENITEZ PABLO RODOLFO | CUIT | 23-29156865-3"). Ahí el buscador se queda con la columna de la
  // etiqueta, que no tiene ningún número, y la planilla entera se lee como vacía. Si la columna
  // elegida no trae documentos, se descarta el encabezado y se busca por contenido.
  if (headerIdx >= 0) {
    let conDocumento = 0;
    for (let i = headerIdx + 1; i < rows.length; i++) if (clasificarId(rows[i][idCol] ?? '')) conDocumento++;
    if (conDocumento === 0) {
      headerIdx = -1;
      idCol = -1;
      apellidoCol = -1;
      nombreCol = -1;
      combinadoCol = -1;
    }
  }

  // 2) Determinar de qué columna(s) sale el nombre.
  const desde = headerIdx >= 0 ? headerIdx + 1 : 0;
  if (headerIdx < 0) {
    // Sin encabezado: la columna de ID es la que más valores tipo CUIL/DNI tiene.
    const anchos = Math.max(...rows.map((r) => r.length), 0);
    let bestC = -1, bestScore = 0;
    for (let c = 0; c < anchos; c++) {
      let score = 0;
      for (const r of rows) if (clasificarId(r[c] ?? '')) score++;
      if (score > bestScore) { bestScore = score; bestC = c; }
    }
    idCol = bestC;
  }
  const doblesColumna = apellidoCol >= 0 && nombreCol >= 0;
  if (!doblesColumna && combinadoCol < 0 && apellidoCol < 0 && nombreCol < 0) {
    // No se identificó columna de nombre por encabezado: elegir la mejor por contenido
    // (evita agarrar la columna del número de orden).
    combinadoCol = mejorColumnaTexto(rows, desde, new Set([idCol]));
  }
  const unicaCol = combinadoCol >= 0 ? combinadoCol : apellidoCol >= 0 ? apellidoCol : nombreCol;

  // 3) Construir las personas.
  const out: ExcelPersona[] = [];
  for (let i = desde; i < rows.length; i++) {
    const id = clasificarId(rows[i][idCol] ?? '');
    if (!id) continue;
    if (doblesColumna) {
      const apellido = (rows[i][apellidoCol] ?? '').trim();
      const nombre = (rows[i][nombreCol] ?? '').trim();
      out.push({ ...id, apellido, nombre, nombreCompleto: `${nombre} ${apellido}`.trim() });
    } else {
      const nombreCompleto = (rows[i][unicaCol] ?? '').trim();
      out.push({ ...id, nombreCompleto });
    }
  }
  return out;
}

/** Lee un adjunto de planilla (xlsx/ods/csv/tsv) y devuelve las personas (CUIL + nombre). */
export function parsePersonasSpreadsheet(filename: string, buffer: Buffer): ExcelPersona[] {
  return filasAPersonas(parseSpreadsheet(filename, buffer));
}

/** Compatibilidad: lee solo .xlsx desde un buffer. */
export function parsePersonasExcel(buffer: Buffer): ExcelPersona[] {
  return filasAPersonas(parseXlsx(buffer));
}
