// Lector mínimo de .xls viejo (Excel 97-2003, BIFF8) SIN dependencias externas.
// Un .xls es un contenedor OLE2/CFB (Compound File) con un stream "Workbook" adentro,
// que a su vez son registros BIFF. Leemos la primera hoja: sus celdas de texto y número.
// No evalúa fórmulas ni estilos; solo extrae valores para la planilla de personas.

const ENDOFCHAIN = 0xfffffffe;

/** Lee un stream por nombre del contenedor OLE2 (Workbook/Book). Devuelve sus bytes o null. */
function readCfbStream(buf: Buffer, names: string[]): Buffer | null {
  if (buf.length < 512) return null;
  if (buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) return null; // firma D0CF11E0 A1B11AE1

  const secShift = buf.readUInt16LE(30);
  const sectorSize = 1 << secShift;
  const miniShift = buf.readUInt16LE(32);
  const miniSize = 1 << miniShift;
  const dirStart = buf.readUInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56);
  const miniFatStart = buf.readUInt32LE(60);

  const sectorOffset = (sid: number) => (sid + 1) * sectorSize;

  // DIFAT: primeras 109 entradas en el header (suficiente para archivos de hasta ~7 MB).
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const sid = buf.readUInt32LE(76 + i * 4);
    if (sid === 0xffffffff) break;
    fatSectors.push(sid);
  }
  // FAT completa.
  const fat: number[] = [];
  const perSector = sectorSize / 4;
  for (const fs of fatSectors) {
    const base = sectorOffset(fs);
    if (base + sectorSize > buf.length) break;
    for (let i = 0; i < perSector; i++) fat.push(buf.readUInt32LE(base + i * 4));
  }

  const readChain = (startSid: number, limit = Infinity): Buffer => {
    const parts: Buffer[] = [];
    let sid = startSid;
    let guard = 0;
    while (sid !== ENDOFCHAIN && sid !== 0xffffffff && guard++ < 1_000_000) {
      const off = sectorOffset(sid);
      if (off + sectorSize > buf.length) break;
      parts.push(buf.subarray(off, off + sectorSize));
      if (parts.length * sectorSize >= limit) break;
      sid = fat[sid] ?? ENDOFCHAIN;
    }
    return Buffer.concat(parts);
  };

  // Directorio.
  const dir = readChain(dirStart);
  interface Entry { name: string; type: number; start: number; size: number; }
  const entries: Entry[] = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = dir.readUInt16LE(o + 64);
    if (nameLen < 2) continue;
    const name = dir.toString('utf16le', o, o + nameLen - 2);
    entries.push({ name, type: dir.readUInt8(o + 66), start: dir.readUInt32LE(o + 116), size: dir.readUInt32LE(o + 120) });
  }

  const root = entries.find((e) => e.type === 5);
  if (!root) return null;
  const target = entries.find((e) => e.type === 2 && names.some((n) => n.toLowerCase() === e.name.toLowerCase()));
  if (!target) return null;

  // Stream grande (>= mini cutoff): sectores normales.
  if (target.size >= miniCutoff) return readChain(target.start, target.size).subarray(0, target.size);

  // Stream chico: vive en el mini-stream del root, direccionado por la mini-FAT.
  const miniStream = readChain(root.start, root.size);
  const miniFatRaw = readChain(miniFatStart);
  const miniFat: number[] = [];
  for (let i = 0; i + 4 <= miniFatRaw.length; i += 4) miniFat.push(miniFatRaw.readUInt32LE(i));
  const parts: Buffer[] = [];
  let sid = target.start;
  let guard = 0;
  while (sid !== ENDOFCHAIN && sid !== 0xffffffff && guard++ < 1_000_000) {
    const off = sid * miniSize;
    if (off + miniSize > miniStream.length) break;
    parts.push(miniStream.subarray(off, off + miniSize));
    sid = miniFat[sid] ?? ENDOFCHAIN;
  }
  return Buffer.concat(parts).subarray(0, target.size);
}

/** Lee la tabla de cadenas compartidas (SST) respetando los cortes en CONTINUE. */
function parseSst(chunks: Buffer[]): string[] {
  let ci = 0;
  let off = 0;
  const remain = () => (ci >= chunks.length ? 0 : chunks[ci].length - off);
  const next = () => { ci++; off = 0; };
  const u8 = () => { if (remain() < 1) next(); const v = chunks[ci][off]; off++; return v; };
  const u16 = () => u8() | (u8() << 8);
  const u32 = () => u8() | (u8() << 8) | (u8() << 16) | (u8() * 0x1000000);

  const total = u32(); void total;
  const unique = u32();
  const out: string[] = [];
  for (let s = 0; s < unique && ci < chunks.length; s++) {
    const cch = u16();
    const grbit = u8();
    let high = (grbit & 0x01) !== 0;
    const fExt = (grbit & 0x04) !== 0;
    const fRich = (grbit & 0x08) !== 0;
    const cRun = fRich ? u16() : 0;
    const cbExt = fExt ? u32() : 0;

    let str = '';
    let i = 0;
    while (i < cch) {
      if (remain() === 0) { next(); if (ci >= chunks.length) break; high = (u8() & 0x01) !== 0; } // grbit de continuación
      if (high) { const lo = chunks[ci][off]; const hi = chunks[ci][off + 1]; off += 2; str += String.fromCharCode(lo | (hi << 8)); }
      else { str += String.fromCharCode(chunks[ci][off]); off++; }
      i++;
    }
    // Saltar rich-runs y phonetic (no llevan grbit de continuación).
    let skip = cRun * 4 + cbExt;
    while (skip > 0) { if (remain() === 0) { next(); if (ci >= chunks.length) break; } const take = Math.min(skip, remain()); off += take; skip -= take; }
    out.push(str);
  }
  return out;
}

function rkToNum(u: number): number {
  const cents = (u & 0x02) !== 0;
  let n: number;
  if (u & 0x01) n = (u | 0) >> 2;
  else { const b = Buffer.alloc(8); b.writeUInt32LE(u & 0xfffffffc, 4); n = b.readDoubleLE(0); }
  return cents ? n / 100 : n;
}

function numToStr(v: number): string {
  if (!Number.isFinite(v)) return '';
  return Number.isInteger(v) ? v.toFixed(0) : String(v);
}

/** Lee un .xls (BIFF8) y devuelve la primera hoja como matriz de texto. */
export function parseXls(buffer: Buffer): string[][] {
  const wb = readCfbStream(buffer, ['Workbook', 'Book']);
  if (!wb) return [];

  // Partir en registros BIFF: tipo(2) + tamaño(2) + datos.
  interface Rec { type: number; data: Buffer; }
  const recs: Rec[] = [];
  let p = 0;
  while (p + 4 <= wb.length) {
    const type = wb.readUInt16LE(p);
    const size = wb.readUInt16LE(p + 2);
    if (p + 4 + size > wb.length) break;
    recs.push({ type, data: wb.subarray(p + 4, p + 4 + size) });
    p += 4 + size;
  }

  // SST (0x00FC) + sus CONTINUE (0x003C).
  let sst: string[] = [];
  const iSst = recs.findIndex((r) => r.type === 0x00fc);
  if (iSst >= 0) {
    const chunks = [recs[iSst].data];
    for (let j = iSst + 1; j < recs.length && recs[j].type === 0x003c; j++) chunks.push(recs[j].data);
    sst = parseSst(chunks);
  }

  // Recorrer la PRIMERA hoja (BOF con dt=0x0010 .. EOF) y juntar celdas.
  const cells = new Map<number, Map<number, string>>();
  let maxRow = -1, maxCol = -1;
  const put = (row: number, col: number, val: string) => {
    if (row > 200000) return;
    let r = cells.get(row); if (!r) { r = new Map(); cells.set(row, r); }
    r.set(col, val);
    if (row > maxRow) maxRow = row; if (col > maxCol) maxCol = col;
  };

  let collecting = false, done = false;
  for (const r of recs) {
    if (done) break;
    if (r.type === 0x0809) { // BOF
      const dt = r.data.length >= 4 ? r.data.readUInt16LE(2) : 0;
      collecting = dt === 0x0010; // worksheet
      continue;
    }
    if (r.type === 0x000a) { if (collecting) done = true; collecting = false; continue; } // EOF
    if (!collecting) continue;
    const d = r.data;
    switch (r.type) {
      case 0x00fd: // LABELSST
        put(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)] ?? '');
        break;
      case 0x0204: { // LABEL (cadena inline)
        const row = d.readUInt16LE(0), col = d.readUInt16LE(2);
        const cch = d.readUInt16LE(6), grbit = d.readUInt8(8);
        let s = '';
        if (grbit & 0x01) for (let i = 0; i < cch; i++) s += String.fromCharCode(d.readUInt16LE(9 + i * 2));
        else for (let i = 0; i < cch; i++) s += String.fromCharCode(d.readUInt8(9 + i));
        put(row, col, s);
        break;
      }
      case 0x0203: // NUMBER
        put(d.readUInt16LE(0), d.readUInt16LE(2), numToStr(d.readDoubleLE(6)));
        break;
      case 0x027e: // RK
        put(d.readUInt16LE(0), d.readUInt16LE(2), numToStr(rkToNum(d.readUInt32LE(6))));
        break;
      case 0x00bd: { // MULRK
        const row = d.readUInt16LE(0), colFirst = d.readUInt16LE(2);
        const n = (d.length - 6) / 6;
        for (let k = 0; k < n; k++) put(row, colFirst + k, numToStr(rkToNum(d.readUInt32LE(4 + k * 6 + 2))));
        break;
      }
      default:
        break;
    }
  }

  if (maxRow < 0) return [];
  const rows: string[][] = [];
  for (let row = 0; row <= maxRow; row++) {
    const r = cells.get(row);
    const arr: string[] = [];
    for (let col = 0; col <= maxCol; col++) arr.push(r?.get(col) ?? '');
    rows.push(arr);
  }
  return rows;
}
