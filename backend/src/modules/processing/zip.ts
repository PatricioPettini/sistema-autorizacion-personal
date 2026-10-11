import AdmZip from 'adm-zip';
import path from 'node:path';
import { env } from '../../config/env.js';
import { isAllowedFile } from '../../lib/files.js';
import { logger } from '../../lib/logger.js';

export interface ExtractedFile {
  filename: string; // solo nombre base saneado
  buffer: Buffer;
}

export interface ZipResult {
  files: ExtractedFile[];
  ignored: string[]; // entradas no permitidas / inseguras
  error?: string;
}

/** Detecta nombres de entrada peligrosos (Zip Slip / path traversal / null byte). */
export function isUnsafeEntry(rawName: string): boolean {
  return rawName.includes('..') || path.isAbsolute(rawName) || rawName.includes('\0') || /^[A-Za-z]:[\\/]/.test(rawName);
}

/**
 * Extrae en memoria los archivos permitidos de un ZIP.
 * Protecciones: rechaza rutas con traversal (../), limita el tamaño total
 * descomprimido (anti ZIP-bomb), ignora tipos no permitidos y nunca ejecuta nada.
 */
export function extractZip(buffer: Buffer): ZipResult {
  const files: ExtractedFile[] = [];
  const ignored: string[] = [];
  const maxTotal = env.rules.maxZipUncompressedMb * 1024 * 1024;
  const maxFile = env.rules.maxFileMb * 1024 * 1024;
  let total = 0;

  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    logger.warn({ err }, 'ZIP corrupto o ilegible.');
    return { files, ignored, error: 'El archivo ZIP está dañado o no se pudo abrir.' };
  }

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const rawName = entry.entryName;

    // Protección Zip Slip / path traversal.
    if (isUnsafeEntry(rawName)) {
      ignored.push(rawName);
      logger.warn(`Entrada de ZIP insegura ignorada: ${rawName}`);
      continue;
    }

    const base = path.basename(rawName);
    if (!isAllowedFile(base)) {
      ignored.push(rawName);
      continue;
    }

    // Control de tamaño declarado antes de descomprimir.
    const declared = (entry.header as any)?.size ?? 0;
    if (declared > maxFile || total + declared > maxTotal) {
      ignored.push(rawName);
      logger.warn(`Entrada de ZIP demasiado grande ignorada: ${rawName}`);
      continue;
    }

    let data: Buffer;
    try {
      data = entry.getData();
    } catch {
      ignored.push(rawName);
      continue;
    }
    if (data.length > maxFile || total + data.length > maxTotal) {
      ignored.push(rawName);
      continue;
    }
    total += data.length;
    files.push({ filename: base, buffer: data });
  }

  return { files, ignored };
}
