// Descarga los datos de idioma de Tesseract (español) para permitir OCR SIN Internet.
// Ejecutar UNA vez con conexión:  node scripts/descargar-ocr.mjs
// Los archivos se guardan en  <STORAGE_PATH>/ocr  y el sistema los usa automáticamente.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnv(name, fallback) {
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)\\s*$`));
      if (m) return m[1].trim();
    }
  }
  return fallback;
}

let storage = readEnv('STORAGE_PATH', './storage');
storage = path.isAbsolute(storage) ? storage : path.resolve(root, storage);
const langs = readEnv('OCR_LANGS', 'spa').split('+');
const outDir = path.join(storage, 'ocr');
fs.mkdirSync(outDir, { recursive: true });

const BASE = 'https://tessdata.projectnaptha.com/4.0.0';

for (const lang of langs) {
  const url = `${BASE}/${lang}.traineddata.gz`;
  const outFile = path.join(outDir, `${lang}.traineddata`);
  if (fs.existsSync(outFile)) {
    console.log(`Ya existe: ${lang}.traineddata`);
    continue;
  }
  process.stdout.write(`Descargando ${lang}.traineddata ... `);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const gz = Buffer.from(await res.arrayBuffer());
    const data = zlib.gunzipSync(gz);
    fs.writeFileSync(outFile, data);
    console.log(`OK (${(data.length / 1024 / 1024).toFixed(1)} MB)`);
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    console.log('  Verificá tu conexión a Internet e intentá de nuevo.');
  }
}
console.log(`\nListo. Los datos de OCR quedaron en:\n  ${outDir}`);
