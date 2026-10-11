// ¿El requisito por persona (Nómina ART, Pago del Monotributo) se aprueba para TODOS los de la
// solicitud, o seguido para algunos sí y para otros no?
//
// La respuesta decide cómo tiene que ser el botón de aprobar en bloque: si el parcial es raro,
// alcanza con "aprobar para todos"; si es común, el botón tiene que dejar destildar a los que no.
//
// Sólo lectura.  Uso:  node scripts/medir-aprobacion-parcial.mjs

import Database from 'better-sqlite3';
import path from 'node:path';

const storage = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const db = new Database(path.join(storage, 'data', 'sistema.db'), { readonly: true });

const tipos = db.prepare(
  "SELECT id, codigo, nombre FROM document_types WHERE alcance = 'PERSONA' AND obligatorio = 1 AND activo = 1"
).all();

const porSolicitud = db.prepare(`
  SELECT sp.solicitud_id AS s,
         COUNT(*) AS total,
         SUM(CASE WHEN d.verificacion = 'VERIFICADO' THEN 1 ELSE 0 END) AS ok
  FROM solicitud_personas sp
  LEFT JOIN documentos d ON d.persona_id = sp.persona_id AND d.tipo_documento_id = ?
  GROUP BY sp.solicitud_id
  HAVING total > 1
`);

for (const t of tipos) {
  const filas = porSolicitud.all(t.id);
  const todas = filas.filter((f) => f.ok === f.total).length;
  const ninguna = filas.filter((f) => f.ok === 0).length;
  const parciales = filas.filter((f) => f.ok > 0 && f.ok < f.total);

  console.log(`\n=== ${t.nombre} (${t.codigo})`);
  console.log(`  solicitudes de 2+ personas: ${filas.length}`);
  console.log(`  aprobado para TODAS:   ${todas}`);
  console.log(`  para NINGUNA:          ${ninguna}`);
  console.log(`  PARCIAL (algunas sí):  ${parciales.length}`);
  for (const p of parciales.slice(0, 12)) {
    const nro = db.prepare('SELECT nro_orden FROM solicitudes WHERE id = ?').get(p.s)?.nro_orden;
    console.log(`     ${nro ?? `#${p.s}`}: ${p.ok} de ${p.total}`);
  }
}
