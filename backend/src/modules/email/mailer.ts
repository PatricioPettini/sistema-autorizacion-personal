import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { getEmailConfig, type EmailConfig } from '../config/service.js';
import { logger } from '../../lib/logger.js';
import { db, schema } from '../../db/client.js';
import { appendToSent } from './sent-folder.js';

export function buildTransporter(cfg: EmailConfig = getEmailConfig()) {
  if (!cfg.smtpHost) return null;
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure,
    auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPassword } : undefined,
  });
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  /** Message-ID del correo al que respondemos (para enhebrar la conversación). */
  inReplyTo?: string | null;
  /** Datos para el registro de enviados (opcional). */
  meta?: { tipo?: string; solicitudId?: number | null; emailMessageId?: number | null };
}

export interface SendResult {
  enviado: boolean;
  messageId: string | null;
}

function genMessageId(fromAddress: string): string {
  const domain = fromAddress.split('@')[1] || 'sistema.local';
  return `<${crypto.randomUUID()}@${domain}>`;
}

/**
 * Buzones que no leen a nadie: contestarles es ruido, y con los que sí responden solos se puede
 * armar un ida y vuelta infinito. (La casilla nueva estrenó el sistema contestándole cuatro
 * "falta la lista de personal" a las alertas de seguridad de Google.)
 */
export function esBuzonAutomatico(direccion: string): boolean {
  return /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?)[+.@]/i.test(direccion.trim());
}

/** Guarda el correo enviado (o el intento fallido) en el registro interno. */
function registrarEnviado(mail: OutgoingMail, messageId: string | null, ok: boolean, error?: string | null) {
  try {
    db.insert(schema.sentEmails).values({
      messageId,
      inReplyTo: mail.inReplyTo ?? null,
      destinatario: mail.to,
      asunto: mail.subject,
      cuerpo: mail.text,
      tipo: mail.meta?.tipo ?? null,
      solicitudId: mail.meta?.solicitudId ?? null,
      emailMessageId: mail.meta?.emailMessageId ?? null,
      ok,
      error: error ?? null,
    }).run();
  } catch (err) {
    logger.warn({ err }, 'No se pudo registrar el correo enviado.');
  }
}

/** Envía un email. Si SMTP no está configurado, no rompe: registra y devuelve false. */
export async function sendMail(mail: OutgoingMail): Promise<SendResult> {
  const c = getEmailConfig();
  const transporter = buildTransporter();
  // Si no se cargó "Email remitente", se usa el usuario de la cuenta SMTP.
  const fromAddress = c.fromAddress || c.smtpUser;
  if (!transporter || !fromAddress) {
    logger.warn(`SMTP no configurado; no se envió el email a ${mail.to} ("${mail.subject}").`);
    registrarEnviado(mail, null, false, 'SMTP no configurado.');
    return { enviado: false, messageId: null };
  }
  if (!mail.to) {
    logger.warn(`Email "${mail.subject}" sin destinatario; no se envió.`);
    registrarEnviado(mail, null, false, 'Sin destinatario.');
    return { enviado: false, messageId: null };
  }
  if (esBuzonAutomatico(mail.to)) {
    logger.info(`No se contesta a ${mail.to} (buzón automático).`);
    registrarEnviado(mail, null, false, 'Destinatario automático (no-reply): no se contesta.');
    return { enviado: false, messageId: null };
  }

  const messageId = genMessageId(fromAddress);
  const mailOpts = {
    from: `"${c.fromName}" <${fromAddress}>`,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    messageId,
    ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo, references: mail.inReplyTo } : {}),
  };

  try {
    await transporter.sendMail(mailOpts);
    logger.info(`Email enviado a ${mail.to}: ${mail.subject}`);
    registrarEnviado(mail, messageId, true, null);
    // Best-effort: dejar una copia en la carpeta "Enviados" del buzón IMAP.
    // Si falla (permisos, nombre de carpeta), no afecta el envío.
    try {
      const raw = await new MailComposer(mailOpts).compile().build();
      await appendToSent(raw);
    } catch (err) {
      logger.warn({ err }, 'No se pudo copiar el email a la carpeta Enviados (IMAP).');
    }
    return { enviado: true, messageId };
  } catch (err: any) {
    logger.error({ err }, `No se pudo enviar el email a ${mail.to}`);
    registrarEnviado(mail, messageId, false, err?.message ?? 'Error al enviar.');
    return { enviado: false, messageId };
  }
}

/** Verifica la conexión SMTP (opcionalmente con una config provista, ej. desde el formulario). */
export async function verifySmtp(cfg?: EmailConfig): Promise<{ ok: boolean; error?: string }> {
  const transporter = buildTransporter(cfg);
  if (!transporter) return { ok: false, error: 'Falta completar el servidor SMTP.' };
  try {
    await transporter.verify();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Error desconocido.' };
  }
}
