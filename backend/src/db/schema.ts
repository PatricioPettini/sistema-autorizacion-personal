import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, index, unique } from 'drizzle-orm/sqlite-core';

// Timestamps: se guardan como texto ISO-8601 en UTC.
const nowSql = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
const createdAt = () => text('created_at').notNull().default(nowSql);
const updatedAt = () => text('updated_at').notNull().default(nowSql);

// ---------------------------------------------------------------------------
// Usuarios y sesiones
// ---------------------------------------------------------------------------
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nombre: text('nombre').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  // 'ADMIN' | 'SEGURIDAD'
  rol: text('rol').notNull().default('SEGURIDAD'),
  activo: integer('activo', { mode: 'boolean' }).notNull().default(true),
  lastLoginAt: text('last_login_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = sqliteTable('sessions', {
  token: text('token').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  ip: text('ip'),
  userAgent: text('user_agent'),
  expiresAt: text('expires_at').notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Locales
// ---------------------------------------------------------------------------
export const locales = sqliteTable('locales', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nombre: text('nombre').notNull().unique(),
  email: text('email'),
  // 'ACTIVO' | 'INACTIVO'
  estado: text('estado').notNull().default('ACTIVO'),
  observaciones: text('observaciones'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Tipos de documento (configurable / extensible)
// ---------------------------------------------------------------------------
export const documentTypes = sqliteTable('document_types', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  codigo: text('codigo').notNull().unique(), // FORM_931, PAGO_ARCA, ...
  nombre: text('nombre').notNull(),
  obligatorio: integer('obligatorio', { mode: 'boolean' }).notNull().default(true),
  tieneVencimiento: integer('tiene_vencimiento', { mode: 'boolean' }).notNull().default(false),
  // A qué contratista aplica: 'EMPRESA' | 'MONOTRIBUTISTA' | 'AMBOS'
  categoria: text('categoria').notNull().default('AMBOS'),
  // Alcance del documento: 'PERSONA' (uno por cada persona) | 'SOLICITUD' (uno para todo el grupo).
  alcance: text('alcance').notNull().default('PERSONA'),
  // Si controla que la fecha de emisión no supere los días máximos (30).
  controlaEmision: integer('controla_emision', { mode: 'boolean' }).notNull().default(false),
  orden: integer('orden').notNull().default(0),
  activo: integer('activo', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Personas (DNI = identificador natural)
// ---------------------------------------------------------------------------
export const personas = sqliteTable('personas', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // CUIL (11 dígitos) = identificador natural de la persona.
  cuil: text('cuil').unique(),
  // Legacy: se conserva la columna para bases existentes. En altas nuevas se guarda el CUIL.
  dni: text('dni').notNull().unique(),
  nombre: text('nombre').notNull(),
  apellido: text('apellido').notNull(),
  // Tipo de contratista: 'EMPRESA' | 'MONOTRIBUTISTA' | null (a definir).
  // Determina qué documentación es obligatoria.
  categoria: text('categoria'),
  empresa: text('empresa'),
  notas: text('notas'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Emails recibidos
// ---------------------------------------------------------------------------
export const emailMessages = sqliteTable(
  'email_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    messageId: text('message_id').notNull().unique(), // Message-ID del header
    remitente: text('remitente'),
    asunto: text('asunto'),
    cuerpo: text('cuerpo'),
    fechaEmail: text('fecha_email'),
    fechaRecibido: text('fecha_recibido').notNull().default(nowSql),
    // RECEIVED | PROCESSING | PROCESSED | NEEDS_REVIEW | ERROR
    estado: text('estado').notNull().default('RECEIVED'),
    localId: integer('local_id').references(() => locales.id),
    rawStoredPath: text('raw_stored_path'),
    attachmentsCount: integer('attachments_count').notNull().default(0),
    error: text('error'),
    // Si es una respuesta a un aviso del sistema: la solicitud original a la que pertenece
    // (para cargar la documentación corregida ahí desde el respaldo). FK a nivel SQL (schema.sql);
    // sin .references() acá para no crear un ciclo de tipos con `solicitudes`.
    replySolicitudId: integer('reply_solicitud_id'),
    // Firma del contenido (remitente + asunto + adjuntos). Sirve para reconocer el MISMO pedido
    // cuando el local lo manda a las dos casillas y no crear dos solicitudes.
    huella: text('huella'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ estadoIdx: index('email_estado_idx').on(t.estado), huellaIdx: index('email_huella_idx').on(t.huella) }),
);

// ---------------------------------------------------------------------------
// Documentos y versiones
// ---------------------------------------------------------------------------
export const documentos = sqliteTable(
  'documentos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    personaId: integer('persona_id').notNull().references(() => personas.id),
    tipoDocumentoId: integer('tipo_documento_id').notNull().references(() => documentTypes.id),
    currentVersionId: integer('current_version_id'),
    // Verificación manual (la persona de Seguridad confirma/corrige lo que detectó la IA).
    // PENDIENTE | VERIFICADO | RECHAZADO
    verificacion: text('verificacion').notNull().default('PENDIENTE'),
    verificadoPorUserId: integer('verificado_por_user_id').references(() => users.id),
    fechaVerificacion: text('fecha_verificacion'),
    // Vencimiento del documento aprobado (lo carga Seguridad al aprobar). Al pasar, el documento
    // deja de contar como válido y la persona no puede ingresar hasta renovarlo.
    fechaVencimiento: text('fecha_vencimiento'),
    notaVerificacion: text('nota_verificacion'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ personaTipoUq: unique('doc_persona_tipo_uq').on(t.personaId, t.tipoDocumentoId) }),
);

export const documentVersions = sqliteTable(
  'document_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentoId: integer('documento_id').notNull().references(() => documentos.id),
    version: integer('version').notNull().default(1),
    originalFilename: text('original_filename').notNull(),
    normalizedFilename: text('normalized_filename'),
    storedPathOriginal: text('stored_path_original').notNull(),
    storedPathNormalized: text('stored_path_normalized'),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    sha256: text('sha256'),
    fromZip: integer('from_zip', { mode: 'boolean' }).notNull().default(false),
    zipName: text('zip_name'),
    emailMessageId: integer('email_message_id').references(() => emailMessages.id),
    createdByUserId: integer('created_by_user_id').references(() => users.id),
    // Datos extraídos por OCR/IA (nunca inventados: null si no se pudo)
    ocrText: text('ocr_text'),
    fechaEmision: text('fecha_emision'),
    fechaVencimiento: text('fecha_vencimiento'),
    clasificacionConfianza: real('clasificacion_confianza'),
    fechaRecepcion: text('fecha_recepcion').notNull().default(nowSql),
    fechaProcesamiento: text('fecha_procesamiento'),
    createdAt: createdAt(),
  },
  (t) => ({ docIdx: index('docver_doc_idx').on(t.documentoId), hashIdx: index('docver_hash_idx').on(t.sha256) }),
);

// Documentos con alcance de SOLICITUD (uno para todo el grupo: Form 931, Pago ARCA,
// Cláusula, Seguro de Vida). Se suben y verifican una sola vez por (solicitud, tipo).
export const solicitudDocumentos = sqliteTable(
  'solicitud_documentos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    solicitudId: integer('solicitud_id').notNull().references(() => solicitudes.id),
    tipoDocumentoId: integer('tipo_documento_id').notNull().references(() => documentTypes.id),
    originalFilename: text('original_filename'),
    normalizedFilename: text('normalized_filename'),
    storedPathOriginal: text('stored_path_original'),
    storedPathNormalized: text('stored_path_normalized'),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    sha256: text('sha256'),
    ocrText: text('ocr_text'),
    fechaEmision: text('fecha_emision'),
    clasificacionConfianza: real('clasificacion_confianza'),
    // PENDIENTE | VERIFICADO | RECHAZADO
    verificacion: text('verificacion').notNull().default('PENDIENTE'),
    verificadoPorUserId: integer('verificado_por_user_id').references(() => users.id),
    fechaVerificacion: text('fecha_verificacion'),
    notaVerificacion: text('nota_verificacion'),
    emailMessageId: integer('email_message_id').references(() => emailMessages.id),
    createdByUserId: integer('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ solTipoUq: unique('soldoc_sol_tipo_uq').on(t.solicitudId, t.tipoDocumentoId) }),
);

// ---------------------------------------------------------------------------
// Solicitudes (workflow) y análisis IA
// ---------------------------------------------------------------------------
export const solicitudes = sqliteTable(
  'solicitudes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // Contacto principal (legacy). Opcional: una solicitud puede existir sin personas
    // hasta que se cargan a mano. El listado real está en solicitudPersonas.
    personaId: integer('persona_id').references(() => personas.id),
    localId: integer('local_id').notNull().references(() => locales.id),
    emailMessageId: integer('email_message_id').references(() => emailMessages.id),
    // PENDIENTE | EN_REVISION | OBSERVADA | AUTORIZADA | RECHAZADA | VENCIDA | REVOCADA
    estado: text('estado').notNull().default('PENDIENTE'),
    // Fecha de vencimiento ÚNICA de la solicitud (YYYY-MM-DD): hasta cuándo pueden ingresar
    // las personas autorizadas de esta solicitud. La carga el admin en la revisión.
    fechaVencimiento: text('fecha_vencimiento'),
    // Trabajo / tarea a realizar (lo carga el admin; suele venir en el cuerpo del email).
    // Seguridad lo ve al consultar la persona ("autorizado para X trabajo").
    trabajo: text('trabajo'),

    docNuevaAt: text('doc_nueva_at'),
    // Número de orden de la revisión (OA-AAAA-NNNN). Se genera al terminar la revisión
    // y lo comparten todas las solicitudes del mismo email. NULL hasta entonces.
    nroOrden: text('nro_orden'),
    motivoRechazo: text('motivo_rechazo'),
    // Papelera: si tiene fecha, la solicitud está "borrada" (no aparece en listados) pero
    // se puede restaurar. NULL = activa.
    deletedAt: text('deleted_at'),
    createdByUserId: integer('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    estadoIdx: index('sol_estado_idx').on(t.estado),
    personaIdx: index('sol_persona_idx').on(t.personaId),
    nroOrdenIdx: index('sol_nro_orden_idx').on(t.nroOrden),
  }),
);

// Personas incluidas en una solicitud (una solicitud = un local = varias personas).
// Cada persona tiene su propio estado de workflow dentro de la solicitud.
export const solicitudPersonas = sqliteTable(
  'solicitud_personas',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    solicitudId: integer('solicitud_id').notNull().references(() => solicitudes.id),
    personaId: integer('persona_id').notNull().references(() => personas.id),
    // PENDIENTE | OBSERVADA | AUTORIZADA | RECHAZADA | REVOCADA
    estado: text('estado').notNull().default('PENDIENTE'),
    motivoRechazo: text('motivo_rechazo'),
    /** Vencimiento propio de ESTA persona. null = rige el de la solicitud (el caso normal). */
    fechaVencimiento: text('fecha_vencimiento'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ uq: unique('sol_persona_uq').on(t.solicitudId, t.personaId), solIdx: index('solper_sol_idx').on(t.solicitudId) }),
);

// Requisitos de documentación EXTRA para una persona puntual (además de los de su
// categoría). Se cargan durante la revisión: ej. "trabajo en altura".
export const requisitosPersona = sqliteTable(
  'requisitos_persona',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    personaId: integer('persona_id').notNull().references(() => personas.id),
    tipoDocumentoId: integer('tipo_documento_id').notNull().references(() => documentTypes.id),
    // Solicitud desde la que se agregó (provenance/auditoría). El requisito es de la persona.
    solicitudId: integer('solicitud_id').references(() => solicitudes.id),
    createdByUserId: integer('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => ({ uq: unique('req_persona_tipo_uq').on(t.personaId, t.tipoDocumentoId), personaIdx: index('req_persona_idx').on(t.personaId) }),
);

// Requisitos EXTRA de alcance SOLICITUD: un documento adicional para TODO el grupo (como el
// Formulario 931), que el admin agrega a una solicitud puntual. Se sube/aprueba una sola vez.
export const requisitosSolicitud = sqliteTable(
  'requisitos_solicitud',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    solicitudId: integer('solicitud_id').notNull().references(() => solicitudes.id),
    tipoDocumentoId: integer('tipo_documento_id').notNull().references(() => documentTypes.id),
    createdByUserId: integer('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => ({ uq: unique('req_solicitud_tipo_uq').on(t.solicitudId, t.tipoDocumentoId), solIdx: index('req_solicitud_idx').on(t.solicitudId) }),
);

export const aiAnalyses = sqliteTable('ai_analyses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  solicitudId: integer('solicitud_id').references(() => solicitudes.id),
  personaId: integer('persona_id').notNull().references(() => personas.id),
  estadoDocumental: text('estado_documental'), // COMPLETO | INCOMPLETO | REQUIERE_REVISION
  faltantesJson: text('faltantes_json'),
  observaciones: text('observaciones'),
  recomendacion: text('recomendacion'),
  confianza: real('confianza'),
  detalleJson: text('detalle_json'),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Autorizaciones
// ---------------------------------------------------------------------------
export const autorizaciones = sqliteTable(
  'autorizaciones',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    solicitudId: integer('solicitud_id').references(() => solicitudes.id),
    personaId: integer('persona_id').notNull().references(() => personas.id),
    localId: integer('local_id').notNull().references(() => locales.id),
    fecha: text('fecha').notNull(), // YYYY-MM-DD (inicio del rango)
    fechaHasta: text('fecha_hasta'), // YYYY-MM-DD (fin del rango; null = mismo día que 'fecha')
    horaDesde: text('hora_desde').notNull(), // HH:mm
    horaHasta: text('hora_hasta').notNull(), // HH:mm
    // AUTORIZADA | REVOCADA | VENCIDA
    estado: text('estado').notNull().default('AUTORIZADA'),
    comentario: text('comentario'),
    autorizadaPorUserId: integer('autorizada_por_user_id').notNull().references(() => users.id),
    fechaDecision: text('fecha_decision').notNull().default(nowSql),
    motivoRevocacion: text('motivo_revocacion'),
    revocadaPorUserId: integer('revocada_por_user_id').references(() => users.id),
    fechaRevocacion: text('fecha_revocacion'),
    createdAt: createdAt(),
  },
  (t) => ({ personaIdx: index('aut_persona_idx').on(t.personaId), estadoIdx: index('aut_estado_idx').on(t.estado) }),
);

// ---------------------------------------------------------------------------
// Ingresos / Salidas
// ---------------------------------------------------------------------------
export const entradas = sqliteTable(
  'entradas',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    personaId: integer('persona_id').notNull().references(() => personas.id),
    localId: integer('local_id').notNull().references(() => locales.id),
    autorizacionId: integer('autorizacion_id').references(() => autorizaciones.id),
    fechaHoraIngreso: text('fecha_hora_ingreso').notNull().default(nowSql),
    ingresoPorUserId: integer('ingreso_por_user_id').references(() => users.id),
    fechaHoraSalida: text('fecha_hora_salida'),
    salidaPorUserId: integer('salida_por_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => ({ personaIdx: index('ent_persona_idx').on(t.personaId), abiertoIdx: index('ent_salida_idx').on(t.fechaHoraSalida) }),
);

// ---------------------------------------------------------------------------
// Comentarios (inmutables)
// ---------------------------------------------------------------------------
export const comentarios = sqliteTable('comentarios', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  solicitudId: integer('solicitud_id').notNull().references(() => solicitudes.id),
  userId: integer('user_id').references(() => users.id),
  contenido: text('contenido').notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Auditoría
// ---------------------------------------------------------------------------
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').references(() => users.id),
    accion: text('accion').notNull(),
    entidad: text('entidad'),
    entidadId: text('entidad_id'),
    detalleJson: text('detalle_json'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => ({ entidadIdx: index('audit_entidad_idx').on(t.entidad, t.entidadId), fechaIdx: index('audit_fecha_idx').on(t.createdAt) }),
);

// ---------------------------------------------------------------------------
// Cola de procesamiento
// ---------------------------------------------------------------------------
export const processingJobs = sqliteTable(
  'processing_jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tipo: text('tipo').notNull(), // PROCESS_EMAIL, ...
    emailMessageId: integer('email_message_id').references(() => emailMessages.id),
    // PENDING | PROCESSING | DONE | ERROR
    estado: text('estado').notNull().default('PENDING'),
    intentos: integer('intentos').notNull().default(0),
    maxIntentos: integer('max_intentos').notNull().default(3),
    payloadJson: text('payload_json'),
    error: text('error'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ estadoIdx: index('job_estado_idx').on(t.estado) }),
);

// ---------------------------------------------------------------------------
// Configuración (clave/valor) — p.ej. credenciales de email
// ---------------------------------------------------------------------------
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Correos que ENVÍA el sistema (registro de enviados)
// ---------------------------------------------------------------------------
export const sentEmails = sqliteTable(
  'sent_emails',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    messageId: text('message_id'),
    inReplyTo: text('in_reply_to'),
    destinatario: text('destinatario'),
    asunto: text('asunto'),
    cuerpo: text('cuerpo'),
    tipo: text('tipo'), // RESULTADO_REVISION | OBSERVACION | RECHAZO | AUTORIZACION
    solicitudId: integer('solicitud_id').references(() => solicitudes.id),
    emailMessageId: integer('email_message_id').references(() => emailMessages.id),
    ok: integer('ok', { mode: 'boolean' }).notNull().default(true),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => ({ messageIdIdx: index('sent_message_id_idx').on(t.messageId), solicitudIdx: index('sent_solicitud_idx').on(t.solicitudId) }),
);
