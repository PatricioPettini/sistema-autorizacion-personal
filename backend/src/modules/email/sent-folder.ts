import { ImapFlow } from 'imapflow';
import { getEmailConfig } from '../config/service.js';
import { logger } from '../../lib/logger.js';

/** Cliente IMAP con la config actual (o null si no está configurado). */
function buildClient() {
  const c = getEmailConfig();
  if (!c.imapHost) return null;
  return new ImapFlow({
    host: c.imapHost,
    port: c.imapPort,
    secure: c.imapSecure,
    auth: { user: c.imapUser, pass: c.imapPassword },
    logger: false,
  });
}

/**
 * Deja una copia de un correo enviado en la carpeta "Enviados" del buzón IMAP.
 * Busca la carpeta por su rol especial (\Sent) y, si no, por nombres comunes
 * (Sent, Enviados, INBOX.Sent, ...). Best-effort: si no encuentra o falla, no rompe.
 */
export async function appendToSent(raw: Buffer): Promise<boolean> {
  // Algunos proveedores archivan solos en Enviados lo que sale por su SMTP, y copiarlo de nuevo
  // por IMAP deja el correo duplicado. Gmail es el caso conocido; la casilla actual
  // (el proveedor de correo, servidor propio) NO archiva sola, así que acá la copia sí hace falta.
  if (/(^|\.)gmail\.com$/i.test(getEmailConfig().imapHost.trim())) return false;
  const client = buildClient();
  if (!client) return false;
  try {
    await client.connect();
    const cajas = await client.list();
    let destino: string | null = null;
    for (const mb of cajas) {
      if ((mb as any).specialUse === '\\Sent') { destino = mb.path; break; }
    }
    if (!destino) {
      const candidatos = ['Sent', 'Enviados', 'Sent Items', 'Elementos enviados', 'INBOX.Sent', 'INBOX.Enviados'];
      const existentes = new Set(cajas.map((m) => m.path));
      destino = candidatos.find((c) => existentes.has(c)) ?? null;
    }
    if (!destino) { logger.warn('No se encontró la carpeta "Enviados" en el buzón IMAP.'); return false; }
    await client.append(destino, raw, ['\\Seen']);
    return true;
  } catch (err) {
    logger.warn({ err }, 'Fallo al copiar a la carpeta Enviados (IMAP).');
    return false;
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}
