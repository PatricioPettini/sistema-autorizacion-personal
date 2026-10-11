import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// backend/src/config -> raíz del proyecto
const projectRoot = path.resolve(__dirname, '..', '..', '..');

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'si', 'sí'].includes(v.toLowerCase());
}

function resolveStorage(): string {
  const raw = str('STORAGE_PATH', './storage');
  const abs = path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
  return abs;
}

const storagePath = resolveStorage();

export const env = {
  projectRoot,
  nodeEnv: str('NODE_ENV', 'development'),
  isProd: str('NODE_ENV', 'development') === 'production',
  port: num('PORT', 4000),
  host: str('HOST', '127.0.0.1'),
  sessionSecret: str('SESSION_SECRET', 'dev-inseguro-cambiar-en-produccion'),

  storagePath,
  dbPath: path.join(storagePath, 'data', 'sistema.db'),
  docsPath: path.join(storagePath, 'documentos'),
  emailsPath: path.join(storagePath, 'emails'),
  backupsPath: path.join(storagePath, 'backups'),
  logsPath: path.join(storagePath, 'logs'),
  tmpPath: path.join(storagePath, 'tmp'),

  tz: str('TZ', 'America/Argentina/Buenos_Aires'),
  locale: str('LOCALE', 'es-AR'),

  mail: {
    imapHost: str('MAIL_IMAP_HOST'),
    imapPort: num('MAIL_IMAP_PORT', 993),
    imapSecure: bool('MAIL_IMAP_SECURE', true),
    imapUser: str('MAIL_IMAP_USER'),
    imapPassword: str('MAIL_IMAP_PASSWORD'),
    smtpHost: str('MAIL_SMTP_HOST'),
    smtpPort: num('MAIL_SMTP_PORT', 587),
    smtpSecure: bool('MAIL_SMTP_SECURE', false),
    smtpUser: str('MAIL_SMTP_USER'),
    smtpPassword: str('MAIL_SMTP_PASSWORD'),
    fromName: str('MAIL_FROM_NAME', 'Seguridad Shopping'),
    fromAddress: str('MAIL_FROM_ADDRESS'),
    pollMinutes: num('MAIL_POLL_MINUTES', 5),
    processedFolder: str('MAIL_PROCESSED_FOLDER'),
    // YYYY-MM-DD: los correos anteriores a esa fecha se ingresan pero van al respaldo para
    // revisarlos a mano, en vez de procesarse solos. Vacio = todo se procesa normalmente.
    revisarAntesDe: str('MAIL_REVISAR_ANTES_DE'),
    // Meses que se conservan los .eml originales en disco. 0 = no se borra nada.
    //
    // Son el 97% del almacenamiento (1,9 MB por correo, ~670 MB por mes) y crecen para siempre,
    // mientras que lo útil —las personas, los adjuntos, quién autorizó— ya está en la base. El
    // original sigue estando en la casilla: el lector no borra ni mueve nada del buzón, así que
    // el archivo de verdad es el correo, no esta copia.
    retencionMeses: num('MAIL_RETENCION_MESES', 3),
    // Avisarle solo al remitente cuando el correo no trae la lista de personas. Por defecto NO: la
    // mayoria de las veces la nomina esta adentro del PDF y se carga a mano, asi que ese correo
    // quedaba mal porque el local ya la habia mandado. El correo igual queda frenado en el
    // respaldo; para pedirla esta el boton "Pedir la nomina" adentro de la solicitud.
    avisoSinPersonas: bool('MAIL_AVISO_SIN_PERSONAS', false),
  },

  rules: {
    expiryAlertDays: num('EXPIRY_ALERT_DAYS', 15),
    // La fecha de emisión de la documentación no puede superar estos días al hacer la obra.
    emissionMaxDays: num('EMISSION_MAX_DAYS', 30),
    maxFileMb: num('MAX_FILE_MB', 25),
    maxZipUncompressedMb: num('MAX_ZIP_UNCOMPRESSED_MB', 200),
  },

  ocrLangs: str('OCR_LANGS', 'spa'),

  // Lee la documentacion que llega por correo y muestra que es y de quien habla. No aprueba ni
  // cambia ningun estado: solo informa. Con 0 la pantalla vuelve exactamente a lo de antes.
  analisisAdjuntos: bool('ANALISIS_ADJUNTOS', true),

  // Lectura de capturas de pantalla con IA. Es lo UNICO del sistema que sale a Internet, y manda
  // documento y nombre de personas a la API de Anthropic. Sin la key, la funcion no aparece.
  //
  // El modelo se elige por variable a proposito: claude-opus-5 es el mas preciso y es el que
  // conviene cuando un documento mal leido autoriza a quien no corresponde; claude-haiku-4-5 sale
  // como la quinta parte y alcanza para una planilla prolija. Cambiarlo no requiere tocar codigo.
  ia: {
    apiKey: str('ANTHROPIC_API_KEY', ''),
    modelo: str('IA_MODELO', 'claude-opus-5'),
  },
};

/** Crea todas las carpetas de almacenamiento si no existen. */
export function ensureStorageDirs(): void {
  for (const dir of [
    env.storagePath,
    path.dirname(env.dbPath),
    env.docsPath,
    env.emailsPath,
    env.backupsPath,
    env.logsPath,
    env.tmpPath,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
