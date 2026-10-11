import { db, schema } from '../db/client.js';

export interface AuditInput {
  userId?: number | null;
  accion: string;
  entidad?: string | null;
  entidadId?: string | number | null;
  detalle?: unknown;
  ip?: string | null;
}

/** Registra una acción en la auditoría. Nunca lanza: la auditoría no debe romper el flujo. */
export function audit(input: AuditInput): void {
  try {
    db.insert(schema.auditLog)
      .values({
        userId: input.userId ?? null,
        accion: input.accion,
        entidad: input.entidad ?? null,
        entidadId: input.entidadId != null ? String(input.entidadId) : null,
        detalleJson: input.detalle !== undefined ? JSON.stringify(input.detalle) : null,
        ip: input.ip ?? null,
      })
      .run();
  } catch {
    // Silencioso a propósito.
  }
}
