import { db, rawDb, runSchema, schema } from './client.js';
import { sql } from 'drizzle-orm';
import { logger } from '../lib/logger.js';

// Requisitos por tipo de contratista.
//  EMPRESA: Form 931, Pago de ARCA, Nómina ART, Cláusula de No Repetición.
//  MONOTRIBUTISTA: Seguro de Vida Colectivo, Pago del Monotributo, Cláusula de No Repetición.
// El vencimiento de cada documento lo carga manualmente Seguridad al aprobarlo.
// alcance: 'SOLICITUD' = uno para todo el grupo; 'PERSONA' = uno por cada persona.
const DEFAULT_DOCUMENT_TYPES = [
  { codigo: 'FORM_931', nombre: 'Formulario 931', obligatorio: true, categoria: 'EMPRESA', alcance: 'SOLICITUD', controlaEmision: false, orden: 1 },
  { codigo: 'PAGO_ARCA', nombre: 'Pago de ARCA', obligatorio: true, categoria: 'EMPRESA', alcance: 'SOLICITUD', controlaEmision: false, orden: 2 },
  { codigo: 'NOMINA_ART', nombre: 'Nómina ART', obligatorio: true, categoria: 'EMPRESA', alcance: 'PERSONA', controlaEmision: false, orden: 3 },
  { codigo: 'SEGURO_VIDA_COLECTIVO', nombre: 'Seguro de Vida Colectivo (mín. $20.337.714)', obligatorio: true, categoria: 'MONOTRIBUTISTA', alcance: 'SOLICITUD', controlaEmision: false, orden: 4 },
  { codigo: 'PAGO_MONOTRIBUTO', nombre: 'Pago del Monotributo', obligatorio: true, categoria: 'MONOTRIBUTISTA', alcance: 'PERSONA', controlaEmision: false, orden: 5 },
  { codigo: 'CLAUSULA_NO_REPETICION', nombre: 'Cláusula de No Repetición (a favor de Cencosud SA)', obligatorio: true, categoria: 'AMBOS', alcance: 'SOLICITUD', controlaEmision: false, orden: 6 },
];

// Requisitos EXTRA (categoria='EXTRA'): NO se aplican por categoría. Son un catálogo
// para elegir durante la revisión y asignárselos a una persona puntual (ej. trabajo en altura).
const EXTRA_DOCUMENT_TYPES = [
  { codigo: 'TRABAJO_ALTURA', nombre: 'Certificado de trabajo en altura', orden: 50 },
  { codigo: 'SEGURO_ACCIDENTES', nombre: 'Seguro de accidentes personales', orden: 51 },
  { codigo: 'APTO_MEDICO', nombre: 'Apto médico', orden: 52 },
  { codigo: 'SEG_HIGIENE', nombre: 'Curso de seguridad e higiene', orden: 53 },
];

// Tipos viejos que ya no aplican (se desactivan, no se borran para conservar historial).
const OBSOLETE_CODES = ['DNI', 'ART', 'SEGURO_VIDA', 'MONOTRIBUTO'];

/** Agrega una columna si todavía no existe (para bases ya creadas). Idempotente. */
function ensureColumn(table: string, column: string, definition: string): void {
  const cols = rawDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    rawDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureIndex(sql: string): void {
  rawDb.exec(sql);
}

function migrateColumns(): void {
  // La vigencia es de la solicitud; esta columna es la excepcion por persona (null = la general).
  ensureColumn('solicitud_personas', 'fecha_vencimiento', 'TEXT');
  ensureColumn('documentos', 'verificacion', "TEXT NOT NULL DEFAULT 'PENDIENTE'");
  ensureColumn('documentos', 'verificado_por_user_id', 'INTEGER');
  ensureColumn('documentos', 'fecha_verificacion', 'TEXT');
  ensureColumn('documentos', 'nota_verificacion', 'TEXT');
  ensureColumn('document_types', 'categoria', "TEXT NOT NULL DEFAULT 'AMBOS'");
  ensureColumn('document_types', 'alcance', "TEXT NOT NULL DEFAULT 'PERSONA'");
  ensureColumn('document_types', 'controla_emision', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('personas', 'categoria', 'TEXT');
  ensureColumn('personas', 'empresa', 'TEXT');
  ensureColumn('personas', 'cuil', 'TEXT');
  ensureColumn('autorizaciones', 'fecha_hasta', 'TEXT');
  ensureColumn('documentos', 'fecha_vencimiento', 'TEXT');
  ensureColumn('solicitudes', 'fecha_vencimiento', 'TEXT'); // vencimiento único de la solicitud
  ensureColumn('solicitudes', 'nro_orden', 'TEXT'); // número de orden de la revisión
  ensureColumn('solicitudes', 'deleted_at', 'TEXT'); // papelera (borrado lógico)
  ensureColumn('solicitudes', 'trabajo', 'TEXT'); // trabajo/tarea a realizar (lo carga el admin)
  ensureColumn('solicitudes', 'doc_nueva_at', 'TEXT'); // llego documentacion despues de informarle el resultado al local
  ensureIndex('CREATE INDEX IF NOT EXISTS sol_nro_orden_idx ON solicitudes(nro_orden)');
  ensureColumn('email_messages', 'reply_solicitud_id', 'INTEGER'); // respuesta -> solicitud original (respaldo)
  ensureColumn('email_messages', 'huella', 'TEXT'); // firma del contenido: detecta el mismo pedido en las dos casillas
  ensureIndex('CREATE INDEX IF NOT EXISTS email_huella_idx ON email_messages(huella)');
}

/**
 * `solicitudes.persona_id` era NOT NULL (modelo viejo: 1 solicitud = 1 persona).
 * Ahora una solicitud puede nacer sin personas (email sin Excel) y cargarse a mano.
 * SQLite no permite quitar un NOT NULL con ALTER, así que se reconstruye la tabla.
 * Idempotente: si la columna ya es opcional, no hace nada.
 */
function migrateSolicitudPersonaIdOpcional(): void {
  const cols = rawDb.prepare('PRAGMA table_info(solicitudes)').all() as { name: string; notnull: number }[];
  const col = cols.find((c) => c.name === 'persona_id');
  if (!col || col.notnull === 0) return;

  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE solicitudes__new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id INTEGER REFERENCES personas(id),
      local_id INTEGER NOT NULL REFERENCES locales(id),
      email_message_id INTEGER REFERENCES email_messages(id),
      estado TEXT NOT NULL DEFAULT 'PENDIENTE',
      fecha_vencimiento TEXT,
      trabajo TEXT,
      nro_orden TEXT,
      motivo_rechazo TEXT,
      deleted_at TEXT,
      created_by_user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    INSERT INTO solicitudes__new (id, persona_id, local_id, email_message_id, estado, fecha_vencimiento, trabajo, nro_orden, motivo_rechazo, deleted_at, created_by_user_id, created_at, updated_at)
      SELECT id, persona_id, local_id, email_message_id, estado, fecha_vencimiento, trabajo, nro_orden, motivo_rechazo, deleted_at, created_by_user_id, created_at, updated_at FROM solicitudes;
    DROP TABLE solicitudes;
    ALTER TABLE solicitudes__new RENAME TO solicitudes;
    CREATE INDEX IF NOT EXISTS sol_estado_idx ON solicitudes(estado);
    CREATE INDEX IF NOT EXISTS sol_persona_idx ON solicitudes(persona_id);
    CREATE INDEX IF NOT EXISTS sol_nro_orden_idx ON solicitudes(nro_orden);
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
  logger.info('Migración: solicitudes.persona_id pasó a ser opcional.');
}

/**
 * Backfill: cada solicitud existente (modelo viejo persona única) pasa a tener
 * su fila en solicitud_personas, así el nuevo modelo (varias personas por
 * solicitud) funciona con los datos ya cargados. Idempotente.
 */
function backfillSolicitudPersonas(): void {
  rawDb.exec(
    `INSERT INTO solicitud_personas (solicitud_id, persona_id, estado)
     SELECT s.id, s.persona_id, s.estado
     FROM solicitudes s
     WHERE s.persona_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM solicitud_personas sp
         WHERE sp.solicitud_id = s.id AND sp.persona_id = s.persona_id
       )`,
  );
}

export function ensureDefaultDocumentTypes(): void {
  for (const dt of DEFAULT_DOCUMENT_TYPES) {
    rawDb
      .prepare(
        `INSERT INTO document_types (codigo, nombre, obligatorio, tiene_vencimiento, categoria, alcance, controla_emision, orden, activo)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1)
         ON CONFLICT(codigo) DO UPDATE SET
           nombre = excluded.nombre,
           obligatorio = excluded.obligatorio,
           categoria = excluded.categoria,
           alcance = excluded.alcance,
           controla_emision = excluded.controla_emision,
           orden = excluded.orden,
           activo = 1`,
      )
      .run(dt.codigo, dt.nombre, dt.obligatorio ? 1 : 0, dt.categoria, dt.alcance, dt.controlaEmision ? 1 : 0, dt.orden);
  }
  // Catálogo EXTRA: obligatorio cuando se asigna, pero categoria='EXTRA' => no auto-aplica.
  // No pisamos 'nombre' ni 'activo' si el admin ya lo editó (solo garantizamos que exista).
  for (const dt of EXTRA_DOCUMENT_TYPES) {
    rawDb
      .prepare(
        `INSERT INTO document_types (codigo, nombre, obligatorio, tiene_vencimiento, categoria, controla_emision, orden, activo)
         VALUES (?, ?, 1, 0, 'EXTRA', 0, ?, 1)
         ON CONFLICT(codigo) DO NOTHING`,
      )
      .run(dt.codigo, dt.nombre, dt.orden);
  }
  for (const codigo of OBSOLETE_CODES) {
    rawDb.prepare(`UPDATE document_types SET activo = 0 WHERE codigo = ?`).run(codigo);
  }
  // "Documentación recibida": existe pero INACTIVO (no se muestra en el checklist),
  // se usa internamente para adjuntar el PDF fuente (planilla/bundle) sin perderlo.
  rawDb
    .prepare(
      `INSERT INTO document_types (codigo, nombre, obligatorio, tiene_vencimiento, categoria, controla_emision, orden, activo)
       VALUES ('DOCUMENTACION', 'Documentación recibida', 0, 0, 'AMBOS', 0, 99, 0)
       ON CONFLICT(codigo) DO UPDATE SET activo = 0, obligatorio = 0`,
    )
    .run();
}

export const LOCAL_SIN_ASIGNAR = '(Sin asignar)';

/** Local temporal para solicitudes cuyo local no se pudo identificar automáticamente. */
export function ensurePlaceholderLocal(): void {
  rawDb
    .prepare(
      `INSERT INTO locales (nombre, estado, observaciones)
       VALUES (?, 'INACTIVO', 'Local temporal para solicitudes cuyo local no se pudo identificar. Reasigná el local correcto.')
       ON CONFLICT(nombre) DO NOTHING`,
    )
    .run(LOCAL_SIN_ASIGNAR);
}

/** Id del local "(Sin asignar)". Se crea recién cuando hace falta (un email sin local detectable),
 *  no al arrancar: así no aparece en la lista si nunca se usa. */
export function getPlaceholderLocalId(): number {
  const row = rawDb.prepare('SELECT id FROM locales WHERE nombre = ?').get(LOCAL_SIN_ASIGNAR) as { id: number } | undefined;
  if (row) return row.id;
  ensurePlaceholderLocal();
  return (rawDb.prepare('SELECT id FROM locales WHERE nombre = ?').get(LOCAL_SIN_ASIGNAR) as { id: number }).id;
}

/**
 * Un email en PROCESSING al arrancar quedó a medio procesar (el proceso murió, ej. un mail
 * muy grande que agotó la memoria). No hay forma de saber si terminó, así que lo pasamos a
 * respaldo para revisarlo/reprocesarlo a mano y que no quede "colgado" para siempre.
 */
function recoverStuckProcessing(): void {
  const motivo = 'Quedó a medio procesar (posible reinicio del servidor por falta de memoria en un mail grande). Revisalo y procesalo de nuevo con "Procesar igual".';
  const r = rawDb
    .prepare(`UPDATE email_messages SET estado='NEEDS_REVIEW', error=COALESCE(error, ?), updated_at=? WHERE estado='PROCESSING'`)
    .run(motivo, new Date().toISOString());
  if (r.changes) logger.warn(`Recuperados ${r.changes} email(s) que quedaron trabados en PROCESSING → respaldo.`);
}

export function migrate(): void {
  runSchema();
  migrateColumns();
  migrateSolicitudPersonaIdOpcional();
  backfillSolicitudPersonas();
  ensureDefaultDocumentTypes();
  // El local "(Sin asignar)" ya NO se crea al arrancar: se crea on-demand en getPlaceholderLocalId().
  recoverStuckProcessing();
  // Verificación mínima
  const count = db.select({ n: sql<number>`count(*)` }).from(schema.documentTypes).get();
  logger.info(`Migración OK. Tipos de documento: ${count?.n ?? 0}`);
}

// Ejecutable directo: tsx src/db/migrate.ts
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  migrate();
}
