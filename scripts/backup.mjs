// Realiza un backup de la base de datos y la documentación.
// Uso:  node scripts/backup.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnvStorage() {
  const envPath = path.join(root, '.env');
  let storage = './storage';
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*STORAGE_PATH\s*=\s*(.+)\s*$/);
      if (m) storage = m[1].trim();
    }
  }
  return path.isAbsolute(storage) ? storage : path.resolve(root, storage);
}

const storage = readEnvStorage();
const now = new Date();
const stamp = now.toISOString().replace(/[:T]/g, '-').slice(0, 19);
const dest = path.join(storage, 'backups', `backup_${stamp}`);
fs.mkdirSync(dest, { recursive: true });

const dbDir = path.join(storage, 'data');
const docsDir = path.join(storage, 'documentos');

let copiado = false;
if (fs.existsSync(dbDir)) {
  fs.cpSync(dbDir, path.join(dest, 'data'), { recursive: true });
  copiado = true;
}
if (fs.existsSync(docsDir)) {
  fs.cpSync(docsDir, path.join(dest, 'documentos'), { recursive: true });
  copiado = true;
}

if (copiado) {
  console.log(`Backup creado en:\n  ${dest}`);
} else {
  console.log('No se encontraron datos para respaldar todavía.');
}
