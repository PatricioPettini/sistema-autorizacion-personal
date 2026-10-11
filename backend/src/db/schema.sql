-- Esquema del Sistema de Autorización de Personal.
-- Idempotente: se puede ejecutar múltiples veces sin romper datos existentes.
-- Mantener sincronizado con backend/src/db/schema.ts

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT 'SEGURIDAD',
  activo INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  ip TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS locales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  email TEXT,
  estado TEXT NOT NULL DEFAULT 'ACTIVO',
  observaciones TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS document_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  obligatorio INTEGER NOT NULL DEFAULT 1,
  tiene_vencimiento INTEGER NOT NULL DEFAULT 0,
  categoria TEXT NOT NULL DEFAULT 'AMBOS',
  alcance TEXT NOT NULL DEFAULT 'PERSONA',
  controla_emision INTEGER NOT NULL DEFAULT 0,
  orden INTEGER NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cuil TEXT UNIQUE,
  dni TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  apellido TEXT NOT NULL,
  categoria TEXT,
  empresa TEXT,
  notas TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS email_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  remitente TEXT,
  asunto TEXT,
  cuerpo TEXT,
  fecha_email TEXT,
  fecha_recibido TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  estado TEXT NOT NULL DEFAULT 'RECEIVED',
  local_id INTEGER REFERENCES locales(id),
  raw_stored_path TEXT,
  attachments_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  huella TEXT,
  reply_solicitud_id INTEGER REFERENCES solicitudes(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS email_estado_idx ON email_messages(estado);

CREATE TABLE IF NOT EXISTS documentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id INTEGER NOT NULL REFERENCES personas(id),
  tipo_documento_id INTEGER NOT NULL REFERENCES document_types(id),
  current_version_id INTEGER,
  verificacion TEXT NOT NULL DEFAULT 'PENDIENTE',
  verificado_por_user_id INTEGER REFERENCES users(id),
  fecha_verificacion TEXT,
  fecha_vencimiento TEXT,
  nota_verificacion TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT doc_persona_tipo_uq UNIQUE (persona_id, tipo_documento_id)
);

CREATE TABLE IF NOT EXISTS document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  documento_id INTEGER NOT NULL REFERENCES documentos(id),
  version INTEGER NOT NULL DEFAULT 1,
  original_filename TEXT NOT NULL,
  normalized_filename TEXT,
  stored_path_original TEXT NOT NULL,
  stored_path_normalized TEXT,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  from_zip INTEGER NOT NULL DEFAULT 0,
  zip_name TEXT,
  email_message_id INTEGER REFERENCES email_messages(id),
  created_by_user_id INTEGER REFERENCES users(id),
  ocr_text TEXT,
  fecha_emision TEXT,
  fecha_vencimiento TEXT,
  clasificacion_confianza REAL,
  fecha_recepcion TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  fecha_procesamiento TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS docver_doc_idx ON document_versions(documento_id);
CREATE INDEX IF NOT EXISTS docver_hash_idx ON document_versions(sha256);

CREATE TABLE IF NOT EXISTS solicitud_documentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  solicitud_id INTEGER NOT NULL REFERENCES solicitudes(id),
  tipo_documento_id INTEGER NOT NULL REFERENCES document_types(id),
  original_filename TEXT,
  normalized_filename TEXT,
  stored_path_original TEXT,
  stored_path_normalized TEXT,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  ocr_text TEXT,
  fecha_emision TEXT,
  clasificacion_confianza REAL,
  verificacion TEXT NOT NULL DEFAULT 'PENDIENTE',
  verificado_por_user_id INTEGER REFERENCES users(id),
  fecha_verificacion TEXT,
  nota_verificacion TEXT,
  email_message_id INTEGER REFERENCES email_messages(id),
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT soldoc_sol_tipo_uq UNIQUE (solicitud_id, tipo_documento_id)
);
CREATE INDEX IF NOT EXISTS soldoc_sol_idx ON solicitud_documentos(solicitud_id);

CREATE TABLE IF NOT EXISTS solicitudes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Contacto principal (legacy). Opcional: una solicitud puede nacer sin personas
  -- (ej. un email sin Excel) y cargarse a mano después. Las personas reales
  -- viven en solicitud_personas.
  persona_id INTEGER REFERENCES personas(id),
  local_id INTEGER NOT NULL REFERENCES locales(id),
  email_message_id INTEGER REFERENCES email_messages(id),
  estado TEXT NOT NULL DEFAULT 'PENDIENTE',
  fecha_vencimiento TEXT,
  trabajo TEXT,
  -- Numero de orden de la revision (formato OA-AAAA-NNNN). Se genera al terminar la
  -- revision y lo comparten todas las solicitudes del mismo email. NULL hasta entonces.
  nro_orden TEXT,
  motivo_rechazo TEXT,
  deleted_at TEXT, -- papelera (borrado logico): NULL = activa
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS sol_estado_idx ON solicitudes(estado);
CREATE INDEX IF NOT EXISTS sol_persona_idx ON solicitudes(persona_id);
-- OJO: el indice de nro_orden NO va aca. En una base ya creada, el CREATE TABLE de arriba
-- es un no-op (la tabla existe sin la columna) pero el CREATE INDEX se ejecuta igual y falla.
-- Lo crea migrateColumns(), despues de agregar la columna con ALTER TABLE.

CREATE TABLE IF NOT EXISTS solicitud_personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  solicitud_id INTEGER NOT NULL REFERENCES solicitudes(id),
  persona_id INTEGER NOT NULL REFERENCES personas(id),
  estado TEXT NOT NULL DEFAULT 'PENDIENTE',
  motivo_rechazo TEXT,
  -- Vencimiento propio de ESTA persona. NULL = rige el de la solicitud, que es el caso normal.
  fecha_vencimiento TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT sol_persona_uq UNIQUE (solicitud_id, persona_id)
);
CREATE INDEX IF NOT EXISTS solper_sol_idx ON solicitud_personas(solicitud_id);

-- Requisitos de documentación EXTRA asignados a una persona puntual (ej. trabajo en
-- altura), además de los que exige su categoría (empresa/monotributista). Se agregan
-- durante la revisión. El tipo referenciado suele tener categoria='EXTRA' (no auto-aplica).
CREATE TABLE IF NOT EXISTS requisitos_persona (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id INTEGER NOT NULL REFERENCES personas(id),
  tipo_documento_id INTEGER NOT NULL REFERENCES document_types(id),
  solicitud_id INTEGER REFERENCES solicitudes(id),
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT req_persona_tipo_uq UNIQUE (persona_id, tipo_documento_id)
);
CREATE INDEX IF NOT EXISTS req_persona_idx ON requisitos_persona(persona_id);

CREATE TABLE IF NOT EXISTS requisitos_solicitud (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  solicitud_id INTEGER NOT NULL REFERENCES solicitudes(id),
  tipo_documento_id INTEGER NOT NULL REFERENCES document_types(id),
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT req_solicitud_tipo_uq UNIQUE (solicitud_id, tipo_documento_id)
);
CREATE INDEX IF NOT EXISTS req_solicitud_idx ON requisitos_solicitud(solicitud_id);

CREATE TABLE IF NOT EXISTS ai_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  solicitud_id INTEGER REFERENCES solicitudes(id),
  persona_id INTEGER NOT NULL REFERENCES personas(id),
  estado_documental TEXT,
  faltantes_json TEXT,
  observaciones TEXT,
  recomendacion TEXT,
  confianza REAL,
  detalle_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS autorizaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  solicitud_id INTEGER REFERENCES solicitudes(id),
  persona_id INTEGER NOT NULL REFERENCES personas(id),
  local_id INTEGER NOT NULL REFERENCES locales(id),
  fecha TEXT NOT NULL,
  fecha_hasta TEXT,
  hora_desde TEXT NOT NULL,
  hora_hasta TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'AUTORIZADA',
  comentario TEXT,
  autorizada_por_user_id INTEGER NOT NULL REFERENCES users(id),
  fecha_decision TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  motivo_revocacion TEXT,
  revocada_por_user_id INTEGER REFERENCES users(id),
  fecha_revocacion TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS aut_persona_idx ON autorizaciones(persona_id);
CREATE INDEX IF NOT EXISTS aut_estado_idx ON autorizaciones(estado);

CREATE TABLE IF NOT EXISTS entradas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id INTEGER NOT NULL REFERENCES personas(id),
  local_id INTEGER NOT NULL REFERENCES locales(id),
  autorizacion_id INTEGER REFERENCES autorizaciones(id),
  fecha_hora_ingreso TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ingreso_por_user_id INTEGER REFERENCES users(id),
  fecha_hora_salida TEXT,
  salida_por_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ent_persona_idx ON entradas(persona_id);
CREATE INDEX IF NOT EXISTS ent_salida_idx ON entradas(fecha_hora_salida);

CREATE TABLE IF NOT EXISTS comentarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  solicitud_id INTEGER NOT NULL REFERENCES solicitudes(id),
  user_id INTEGER REFERENCES users(id),
  contenido TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  accion TEXT NOT NULL,
  entidad TEXT,
  entidad_id TEXT,
  detalle_json TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS audit_entidad_idx ON audit_log(entidad, entidad_id);
CREATE INDEX IF NOT EXISTS audit_fecha_idx ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS processing_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  email_message_id INTEGER REFERENCES email_messages(id),
  estado TEXT NOT NULL DEFAULT 'PENDING',
  intentos INTEGER NOT NULL DEFAULT 0,
  max_intentos INTEGER NOT NULL DEFAULT 3,
  payload_json TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS job_estado_idx ON processing_jobs(estado);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Registro de correos que ENVÍA el sistema (avisos al remitente). Sirve para
-- verlos dentro del sistema y para detectar respuestas a nuestros avisos.
CREATE TABLE IF NOT EXISTS sent_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  in_reply_to TEXT,
  destinatario TEXT,
  asunto TEXT,
  cuerpo TEXT,
  tipo TEXT,
  solicitud_id INTEGER REFERENCES solicitudes(id),
  email_message_id INTEGER REFERENCES email_messages(id),
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS sent_message_id_idx ON sent_emails(message_id);
CREATE INDEX IF NOT EXISTS sent_solicitud_idx ON sent_emails(solicitud_id);
