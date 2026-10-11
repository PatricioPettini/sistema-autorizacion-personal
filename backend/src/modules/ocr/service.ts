import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface OcrResult {
  text: string | null;
  source: 'PDF_TEXT' | 'OCR_IMAGE' | 'NONE';
  ok: boolean;
  note?: string;
}

let worker: any = null;
let workerLangPath: string | undefined;

/** Carpeta local para archivos de idioma de Tesseract (permite OCR sin Internet). */
function localLangPath(): string | undefined {
  const dir = path.join(env.storagePath, 'ocr');
  const lang = env.ocrLangs.split('+')[0] || 'spa';
  if (fs.existsSync(path.join(dir, `${lang}.traineddata`)) || fs.existsSync(path.join(dir, `${lang}.traineddata.gz`))) {
    return dir;
  }
  return undefined;
}

async function getWorker() {
  if (worker) return worker;
  const { createWorker } = await import('tesseract.js');
  workerLangPath = localLangPath();
  // Si hay datos locales se usan (offline); si no, tesseract.js los descarga la primera vez.
  worker = await createWorker(env.ocrLangs, undefined, workerLangPath ? { langPath: workerLangPath } : undefined);
  return worker;
}

/** OCR de una imagen. Si falla (p.ej. sin datos de idioma y sin Internet), devuelve ok:false sin romper. */
export async function ocrImage(buffer: Buffer): Promise<OcrResult> {
  try {
    const w = await getWorker();
    const { data } = await w.recognize(buffer);
    const text = (data?.text ?? '').trim();
    return { text: text || null, source: 'OCR_IMAGE', ok: true };
  } catch (err) {
    logger.warn({ err }, 'OCR de imagen no disponible; se marcará para revisión manual.');
    return { text: null, source: 'NONE', ok: false, note: 'OCR no disponible.' };
  }
}

/** Extrae texto de un PDF con pdfjs-dist. Si es un PDF escaneado sin texto, devuelve ok:false. */
export async function extractPdfText(buffer: Buffer): Promise<OcrResult> {
  try {
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(buffer);
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((it: any) => (typeof it.str === 'string' ? it.str : '')).join(' ') + '\n';
    }
    await doc.destroy();
    text = text.trim();
    if (text.length >= 20) return { text, source: 'PDF_TEXT', ok: true };
    return { text: null, source: 'NONE', ok: false, note: 'PDF sin texto (probablemente escaneado). Requiere revisión manual.' };
  } catch (err) {
    logger.warn({ err }, 'No se pudo leer el texto del PDF.');
    return { text: null, source: 'NONE', ok: false, note: 'No se pudo leer el PDF.' };
  }
}

export async function shutdownOcr(): Promise<void> {
  if (worker) {
    try {
      await worker.terminate();
    } catch {
      /* ignore */
    }
    worker = null;
  }
}
