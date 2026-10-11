import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { env } from '../../config/env.js';

/**
 * Configuración del correo del sistema.
 *
 * Vive SOLO en el entorno (variables `MAIL_*`), no en la base ni en el panel. Antes se podía
 * editar desde Administración y eso fue justamente lo que rompió la recepción: quedó una casilla
 * cargada sin contraseña y otra apuntando a una cuenta bloqueada, y el sistema dejó de leer el
 * buzón durante días sin que nadie lo notara. Hay una sola casilla y es la de la empresa.
 *
 * Para cambiar la contraseña no hace falta desplegar:
 *   flyctl secrets set MAIL_IMAP_PASSWORD=... MAIL_SMTP_PASSWORD=... -a <app>
 * (guardar un secreto reinicia la máquina y toma el valor nuevo).
 */
export interface EmailConfig {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string;
  imapPassword: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  fromName: string;
  fromAddress: string;
  pollMinutes: number;
  processedFolder: string;
  /**
   * `YYYY-MM-DD`. Los correos ANTERIORES a esa fecha se ingresan pero quedan en el respaldo para
   * revisarlos a mano, en vez de procesarse solos. Es para el arranque después de una caída: lo
   * que llegó mientras el sistema no podía leer el buzón puede haberse cargado a mano, y crear la
   * solicitud de nuevo la duplicaría. Vacío = todo se procesa normalmente.
   */
  revisarAntesDe: string;
}

export function getEmailConfig(): EmailConfig {
  return {
    imapHost: env.mail.imapHost,
    imapPort: env.mail.imapPort,
    imapSecure: env.mail.imapSecure,
    imapUser: env.mail.imapUser,
    imapPassword: env.mail.imapPassword,
    smtpHost: env.mail.smtpHost,
    smtpPort: env.mail.smtpPort,
    smtpSecure: env.mail.smtpSecure,
    smtpUser: env.mail.smtpUser,
    smtpPassword: env.mail.smtpPassword,
    fromName: env.mail.fromName,
    fromAddress: env.mail.fromAddress,
    pollMinutes: env.mail.pollMinutes,
    processedFolder: env.mail.processedFolder,
    revisarAntesDe: env.mail.revisarAntesDe,
  };
}

/** Datos de la casilla para mostrar en Monitoreo. Nunca incluye la contraseña. */
export function getEmailConfigVisible() {
  const c = getEmailConfig();
  return {
    imapHost: c.imapHost,
    imapPort: c.imapPort,
    imapUser: c.imapUser,
    smtpHost: c.smtpHost,
    smtpPort: c.smtpPort,
    fromAddress: c.fromAddress || c.smtpUser,
    pollMinutes: c.pollMinutes,
    revisarAntesDe: c.revisarAntesDe,
    passwordCargada: !!c.imapPassword,
    smtpPasswordCargada: !!c.smtpPassword,
  };
}

/**
 * Borra la configuración de correo que quedó en la tabla `settings` de cuando se editaba desde el
 * panel. Ya no se lee, pero alguna de esas filas guarda la contraseña cifrada de una casilla que
 * se dejó de usar: no tiene sentido conservarla. Idempotente, corre al migrar.
 */
export function limpiarConfigDeCorreoEnBase(): number {
  try {
    const filas = db.select({ key: schema.settings.key }).from(schema.settings).all().filter((r) => r.key.startsWith('mail.'));
    for (const f of filas) db.delete(schema.settings).where(eq(schema.settings.key, f.key)).run();
    return filas.length;
  } catch {
    return 0;
  }
}
