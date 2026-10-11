import crypto from 'node:crypto';
import { env } from '../config/env.js';

const key = crypto.createHash('sha256').update(env.sessionSecret).digest(); // 32 bytes

/** Cifra un texto (AES-256-GCM). Devuelve base64 con iv+tag+data. */
export function encryptSecret(plain: string): string {
  if (plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${Buffer.concat([iv, tag, enc]).toString('base64')}`;
}

export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return '';
  if (!stored.startsWith('enc:')) return stored; // compatibilidad: texto plano heredado
  try {
    const raw = Buffer.from(stored.slice(4), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
