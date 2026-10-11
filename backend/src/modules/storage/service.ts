import fs from 'node:fs';
import { eq, and, desc } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { env } from '../../config/env.js';
import { safeJoin, safeSegment, sanitizeName, sha256, ext } from '../../lib/files.js';
import { nowIso } from '../../lib/datetime.js';
import { audit } from '../../lib/audit.js';

export interface SaveVersionInput {
  personaId: number;
  tipoDocumentoId: number;
  buffer: Buffer;
  originalFilename: string;
  mimeType?: string | null;
  fromZip?: boolean;
  zipName?: string | null;
  emailMessageId?: number | null;
  createdByUserId?: number | null;
  fechaEmision?: string | null;
  fechaVencimiento?: string | null;
  ocrText?: string | null;
  clasificacionConfianza?: number | null;
}

export interface SaveVersionResult {
  versionId: number;
  version: number;
  duplicate: boolean;
}

function personaDirName(dni: string, apellido: string, nombre: string): string {
  return safeSegment(`${dni} - ${apellido} ${nombre}`.toUpperCase());
}

export interface SaveSolicitudDocInput {
  solicitudId: number;
  tipoDocumentoId: number;
  buffer: Buffer;
  originalFilename: string;
  mimeType?: string | null;
  createdByUserId?: number | null;
  emailMessageId?: number | null;
}

/**
 * Guarda un documento de alcance SOLICITUD (uno por solicitud+tipo). A diferencia de los
 * documentos por persona, no hay versionado: al recargar, se reemplaza el archivo y se
 * vuelve a dejar PENDIENTE de verificación.
 */
export function saveSolicitudDocument(input: SaveSolicitudDocInput): { soldocId: number } {
  const tipo = db.select().from(schema.documentTypes).where(eq(schema.documentTypes.id, input.tipoDocumentoId)).get();
  if (!tipo) throw new Error('Tipo de documento inexistente.');

  const hash = sha256(input.buffer);
  const extension = ext(input.originalFilename) || (input.mimeType === 'application/pdf' ? '.pdf' : '.bin');
  const originalSafe = sanitizeName(input.originalFilename) || `documento${extension}`;
  const normalizedName = safeSegment(`SOLICITUD_${input.solicitudId}_${tipo.codigo}`).replace(/ /g, '_') + extension;

  const baseDir = safeJoin(env.docsPath, `SOLICITUD_${input.solicitudId}`, tipo.codigo);
  const originalDir = safeJoin(baseDir, 'original');
  const normalizedDir = safeJoin(baseDir, 'normalizado');
  fs.mkdirSync(originalDir, { recursive: true });
  fs.mkdirSync(normalizedDir, { recursive: true });
  const originalPath = safeJoin(originalDir, originalSafe);
  const normalizedPath = safeJoin(normalizedDir, normalizedName);
  fs.writeFileSync(originalPath, input.buffer);
  fs.writeFileSync(normalizedPath, input.buffer);

  const existing = db
    .select()
    .from(schema.solicitudDocumentos)
    .where(and(eq(schema.solicitudDocumentos.solicitudId, input.solicitudId), eq(schema.solicitudDocumentos.tipoDocumentoId, input.tipoDocumentoId)))
    .get();

  const values = {
    originalFilename: input.originalFilename,
    normalizedFilename: normalizedName,
    storedPathOriginal: originalPath,
    storedPathNormalized: normalizedPath,
    mimeType: input.mimeType ?? null,
    sizeBytes: input.buffer.length,
    sha256: hash,
    // Un archivo nuevo vuelve el documento a PENDIENTE (hay que re-verificarlo).
    verificacion: 'PENDIENTE',
    verificadoPorUserId: null,
    fechaVerificacion: null,
    emailMessageId: input.emailMessageId ?? null,
    createdByUserId: input.createdByUserId ?? null,
    updatedAt: nowIso(),
  };

  let soldocId: number;
  if (existing) {
    db.update(schema.solicitudDocumentos).set(values).where(eq(schema.solicitudDocumentos.id, existing.id)).run();
    soldocId = existing.id;
  } else {
    const row = db.insert(schema.solicitudDocumentos).values({ solicitudId: input.solicitudId, tipoDocumentoId: input.tipoDocumentoId, ...values }).returning().get();
    soldocId = row.id;
  }

  audit({
    userId: input.createdByUserId ?? null,
    accion: 'SOLICITUD_DOC_CARGADO',
    entidad: 'solicitud_documento',
    entidadId: soldocId,
    detalle: { tipo: tipo.codigo, solicitudId: input.solicitudId },
  });
  return { soldocId };
}

/**
 * Guarda un documento como nueva versión:
 * - conserva el archivo ORIGINAL (nombre tal cual llegó),
 * - guarda una copia NORMALIZADA con nombre estandarizado,
 * - nunca sobreescribe versiones anteriores,
 * - deduplica por hash (si el archivo es idéntico al actual, no crea versión).
 */
export function saveDocumentVersion(input: SaveVersionInput): SaveVersionResult {
  const persona = db.select().from(schema.personas).where(eq(schema.personas.id, input.personaId)).get();
  const tipo = db.select().from(schema.documentTypes).where(eq(schema.documentTypes.id, input.tipoDocumentoId)).get();
  if (!persona || !tipo) throw new Error('Persona o tipo de documento inexistente.');

  const hash = sha256(input.buffer);

  // Documento (slot persona+tipo)
  let documento = db
    .select()
    .from(schema.documentos)
    .where(and(eq(schema.documentos.personaId, input.personaId), eq(schema.documentos.tipoDocumentoId, input.tipoDocumentoId)))
    .get();
  if (!documento) {
    documento = db
      .insert(schema.documentos)
      .values({ personaId: input.personaId, tipoDocumentoId: input.tipoDocumentoId })
      .returning()
      .get();
  }

  // Dedup: si el archivo actual tiene el mismo hash, no crear versión nueva.
  if (documento.currentVersionId) {
    const current = db.select().from(schema.documentVersions).where(eq(schema.documentVersions.id, documento.currentVersionId)).get();
    if (current?.sha256 === hash) {
      return { versionId: current.id, version: current.version, duplicate: true };
    }
  }

  const last = db
    .select()
    .from(schema.documentVersions)
    .where(eq(schema.documentVersions.documentoId, documento.id))
    .orderBy(desc(schema.documentVersions.version))
    .get();
  const nextVersion = (last?.version ?? 0) + 1;
  const vTag = `v${String(nextVersion).padStart(3, '0')}`;

  const pDir = personaDirName(persona.dni, persona.apellido, persona.nombre);
  const extension = ext(input.originalFilename) || (input.mimeType === 'application/pdf' ? '.pdf' : '.bin');
  const originalSafe = sanitizeName(input.originalFilename) || `documento${extension}`;
  const normalizedName = safeSegment(`${persona.apellido}_${persona.nombre}_${tipo.codigo}_${vTag}`).replace(/ /g, '_') + extension;

  const originalDir = safeJoin(env.docsPath, pDir, tipo.codigo, vTag, 'original');
  const normalizedDir = safeJoin(env.docsPath, pDir, tipo.codigo, vTag, 'normalizado');
  fs.mkdirSync(originalDir, { recursive: true });
  fs.mkdirSync(normalizedDir, { recursive: true });

  const originalPath = safeJoin(originalDir, originalSafe);
  const normalizedPath = safeJoin(normalizedDir, normalizedName);
  fs.writeFileSync(originalPath, input.buffer);
  fs.writeFileSync(normalizedPath, input.buffer);

  const version = db
    .insert(schema.documentVersions)
    .values({
      documentoId: documento.id,
      version: nextVersion,
      originalFilename: input.originalFilename,
      normalizedFilename: normalizedName,
      storedPathOriginal: originalPath,
      storedPathNormalized: normalizedPath,
      mimeType: input.mimeType ?? null,
      sizeBytes: input.buffer.length,
      sha256: hash,
      fromZip: input.fromZip ?? false,
      zipName: input.zipName ?? null,
      emailMessageId: input.emailMessageId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      ocrText: input.ocrText ?? null,
      fechaEmision: input.fechaEmision ?? null,
      fechaVencimiento: input.fechaVencimiento ?? null,
      clasificacionConfianza: input.clasificacionConfianza ?? null,
      fechaProcesamiento: nowIso(),
    })
    .returning()
    .get();

  db.update(schema.documentos).set({ currentVersionId: version.id, updatedAt: nowIso() }).where(eq(schema.documentos.id, documento.id)).run();

  audit({
    userId: input.createdByUserId ?? null,
    accion: nextVersion === 1 ? 'DOCUMENTO_CARGADO' : 'DOCUMENTO_ACTUALIZADO',
    entidad: 'documento',
    entidadId: documento.id,
    detalle: { tipo: tipo.codigo, version: nextVersion, fromZip: input.fromZip ?? false },
  });

  return { versionId: version.id, version: nextVersion, duplicate: false };
}
