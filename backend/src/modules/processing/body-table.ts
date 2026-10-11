import { filasAPersonas, clasificarId, type ExcelPersona } from '../../lib/xlsx.js';

/** Decodifica entidades HTML básicas y saca tags/espacios de una celda. */
function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>(?=)/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Convierte todas las <table> del HTML en filas/celdas de texto. */
function parseHtmlTables(html: string): string[][] {
  const rows: string[][] = [];
  const tableRe = /<table\b[\s\S]*?<\/table>/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tableRe.exec(html))) {
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let trm: RegExpExecArray | null;
    while ((trm = trRe.exec(tm[0]))) {
      const cells: string[] = [];
      const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cm: RegExpExecArray | null;
      while ((cm = tdRe.exec(trm[1]))) cells.push(stripHtml(cm[1]));
      if (cells.some((c) => c !== '')) rows.push(cells);
    }
  }
  return rows;
}

/**
 * Extrae personas (CUIL + nombre) listadas en el CUERPO de un email cuando no vino
 * un Excel adjunto: soporta tablas HTML y listas en texto plano (una persona por línea,
 * el CUIL es el token con 10+ dígitos, el resto es el nombre — igual que el pegado manual).
 */
export function parsePersonasFromBody(html?: string, text?: string): ExcelPersona[] {
  // 1) Tabla HTML: la interpretamos con el mismo lector de encabezados que el Excel.
  if (html) {
    const rows = parseHtmlTables(html);
    const personas = filasAPersonas(rows);
    if (personas.length > 0) return personas;
  }

  // 2) Texto plano: una persona por línea con un CUIL (11) o DNI (7-8) adentro.
  const out: ExcelPersona[] = [];
  const cuerpo = text ?? (html ? stripHtml(html.replace(/<\/(tr|p|div|li)>/gi, '\n')) : '');
  for (const linea of cuerpo.split(/\r?\n/)) {
    // La linea se parte en tokens y se busca el que sea un documento. `clasificarId` es la misma
    // regla que usa el lector de planillas, asi que una fecha ("Jue 03/09/2026") no pasa por
    // documento en ninguno de los dos caminos.
    const tokens = linea.split(/[\t;,|]+|\s+/).map((x) => x.trim()).filter(Boolean);
    const iId = tokens.findIndex((x) => !!clasificarId(x));
    if (iId < 0) continue;
    const id = clasificarId(tokens[iId])!;
    const nombreCompleto = tokens.filter((_, k) => k !== iId).join(' ').trim();
    out.push({ ...id, nombreCompleto });
  }
  return out;
}
