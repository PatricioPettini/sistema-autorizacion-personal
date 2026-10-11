import { describe, it, expect } from 'vitest';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { safeJoin, sanitizeName, isAllowedFile, isZip } from '../lib/files.js';
import { extractZip, isUnsafeEntry } from '../modules/processing/zip.js';

describe('seguridad de archivos', () => {
  it('safeJoin permite rutas internas', () => {
    const base = path.resolve('/tmp/base');
    expect(safeJoin(base, 'a', 'b.pdf')).toBe(path.resolve(base, 'a', 'b.pdf'));
  });

  it('safeJoin bloquea path traversal', () => {
    const base = path.resolve('/tmp/base');
    expect(() => safeJoin(base, '..', '..', 'etc', 'passwd')).toThrow();
  });

  it('sanitizeName quita caracteres peligrosos y acentos', () => {
    expect(sanitizeName('Perón/../x*.pdf')).not.toContain('/');
    expect(sanitizeName('Perón')).toBe('Peron');
  });

  it('valida extensiones permitidas', () => {
    expect(isAllowedFile('dni.pdf')).toBe(true);
    expect(isAllowedFile('foto.JPG')).toBe(true);
    expect(isAllowedFile('virus.exe')).toBe(false);
    expect(isAllowedFile('macro.docm')).toBe(false);
  });

  it('detecta ZIP', () => {
    expect(isZip('docs.zip')).toBe(true);
    expect(isZip('docs.pdf')).toBe(false);
  });
});

describe('extracción de ZIP', () => {
  it('extrae archivos permitidos e ignora los no permitidos', () => {
    const zip = new AdmZip();
    zip.addFile('DNI.pdf', Buffer.from('%PDF-1.4 dni'));
    zip.addFile('notas.txt', Buffer.from('texto'));
    zip.addFile('malware.exe', Buffer.from('MZ'));
    const res = extractZip(zip.toBuffer());
    expect(res.files.map((f) => f.filename)).toContain('DNI.pdf');
    expect(res.files.find((f) => f.filename === 'notas.txt')).toBeUndefined();
    expect(res.ignored.length).toBeGreaterThanOrEqual(2);
  });

  it('detecta entradas peligrosas (Zip Slip / path traversal)', () => {
    expect(isUnsafeEntry('../../evil.pdf')).toBe(true);
    expect(isUnsafeEntry('a/../../evil.pdf')).toBe(true);
    expect(isUnsafeEntry('C:\\Windows\\x.pdf')).toBe(true);
    expect(isUnsafeEntry('/etc/passwd')).toBe(true);
    expect(isUnsafeEntry('evil\0.pdf')).toBe(true);
    expect(isUnsafeEntry('DNI.pdf')).toBe(false);
    expect(isUnsafeEntry('subcarpeta/DNI.pdf')).toBe(false);
  });
});
