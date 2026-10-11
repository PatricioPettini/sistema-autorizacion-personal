import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Aislar el almacenamiento en una carpeta temporal ANTES de importar cualquier módulo
// que lea la configuración (env.ts lee process.env al importarse).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-test-'));
process.env.STORAGE_PATH = tmp;
process.env.SESSION_SECRET = 'test-secret-para-vitest-1234567890';
process.env.NODE_ENV = 'test';
process.env.MAIL_POLL_MINUTES = '0';
process.env.EXPIRY_ALERT_DAYS = '15';
