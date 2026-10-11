// Solicitudes creadas sin ninguna persona: por qué existen, si el rechazo automático debía haberlas
// frenado. Sólo lectura.
//
// Uso:  node scripts/ver-sin-personas.mjs [--dias 7]

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { parsePersonasFromBody } from '../backend/dist/modules/processing/body-table.js';
import { pareceNombreDePersona, splitNombreCompleto } from '../backend/dist/modules/personas/service.js';

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const DIAS = Number(arg('--dias') ?? 7);

const storage = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const db = new Database(path.join(storage, 'data', 'sistema.db'), { readonly: true });

const desde = new Date(Date.now() - DIAS * 86400000).toISOString();

const filas = db.prepare(`
  SELECT s.id, s.nro_orden AS nro, s.created_at AS creada, s.estado, l.nombre AS local,
         e.id AS emailId, e.asunto, e.remitente, e.estado AS estadoEmail, e.raw_stored_path AS raw,
         (SELECT COUNT(*) FROM solicitud_personas sp WHERE sp.solicitud_id = s.id) AS personas
  FROM solicitudes s
  JOIN locales l ON l.id = s.local_id
  LEFT JOIN email_messages e ON e.id = s.email_message_id
  WHERE s.created_at >= ?
  ORDER BY s.id DESC
`).all(desde);

const sinGente = filas.filter((f) => f.personas === 0);

console.log(`Solicitudes creadas en los últimos ${DIAS} días: ${filas.length} · sin ninguna persona: ${sinGente.length}`);

const audit = db.prepare(`
  SELECT accion, detalle_json AS detalle, created_at AS cuando, user_id AS userId FROM audit_log
  WHERE (entidad = 'solicitud' AND CAST(entidad_id AS INTEGER) = ?) OR (entidad = 'email' AND CAST(entidad_id AS INTEGER) = ?)
  ORDER BY id
`);

for (const f of sinGente) {
  console.log(`\n=== ${f.nro ?? `#${f.id}`} · ${f.local} · creada ${f.creada} · estado ${f.estado}`);
  console.log(`    email #${f.emailId ?? '—'} · ${f.estadoEmail ?? '—'} · de ${f.remitente ?? '—'}`);
  console.log(`    asunto: ${f.asunto ?? '(sin asunto)'}`);
  if (f.emailId) {
    for (const a of audit.all(f.id, f.emailId)) {
      console.log(`    · ${a.cuando} ${a.accion} ${a.userId ? `(user ${a.userId})` : '(automático)'} ${a.detalle ?? ''}`);
    }
  }
  // Qué leyó el parser del cuerpo, y por qué cada fila no pasó por persona.
  if (f.raw && fs.existsSync(f.raw)) {
    try {
      const parsed = await simpleParser(fs.readFileSync(f.raw));
      const filas = parsePersonasFromBody(parsed.html || undefined, parsed.text || undefined);
      console.log(`    filas leídas del cuerpo: ${filas.length}`);
      for (const fila of filas) {
        const nc = (fila.nombre || fila.apellido)
          ? { nombre: (fila.nombre || '').trim(), apellido: (fila.apellido || '').trim() }
          : splitNombreCompleto(fila.nombreCompleto);
        const ok = pareceNombreDePersona(nc.nombre, nc.apellido);
        console.log(`      ${fila.cuil ?? fila.dni ?? '—'} | "${nc.apellido}" "${nc.nombre}" -> ${ok ? 'PASA' : 'DESCARTADA'}`);
      }
    } catch (e) { console.log(`    (no se pudo abrir el .eml: ${e.message})`); }
  }
}

// Y al revés: correos que el rechazo automático SÍ frenó, para ver que el camino funciona.
const frenados = db.prepare(`
  SELECT entidad_id AS emailId, created_at AS cuando, detalle_json AS detalle FROM audit_log
  WHERE accion = 'EMAIL_SIN_PERSONAS' AND created_at >= ? ORDER BY id DESC
`).all(desde);
console.log(`\n--- Correos frenados por "falta la lista de personal" en el mismo período: ${frenados.length} ---`);
for (const f of frenados.slice(0, 10)) console.log(`  email #${f.emailId} · ${f.cuando} · ${f.detalle ?? ''}`);
