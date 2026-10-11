import { sql, eq, and } from 'drizzle-orm';
import { db, schema } from './client.js';
import { migrate } from './migrate.js';
import { hashPassword } from '../lib/password.js';
import { saveDocumentVersion } from '../modules/storage/service.js';
import { analyzePersona } from '../modules/ai/analyzer.js';
import { todayLocal } from '../lib/datetime.js';
import { logger } from '../lib/logger.js';

// PDF mínimo válido (para exhibir el flujo de documentos en la demo).
function fakePdf(label: string): Buffer {
  return Buffer.from(`%PDF-1.4\n% Documento de demostración: ${label}\n%%EOF`, 'utf8');
}

function tipoId(codigo: string): number {
  return db.select().from(schema.documentTypes).where(eq(schema.documentTypes.codigo, codigo)).get()!.id;
}

async function seed() {
  migrate();

  const users = db.select({ n: sql<number>`count(*)` }).from(schema.users).get()?.n ?? 0;
  if (users > 0) {
    logger.warn('La base ya tiene usuarios. Se omite el seed para no duplicar datos.');
    return;
  }

  // --- Usuarios ---
  db.insert(schema.users).values({ nombre: 'Administrador', email: 'admin@shopping.local', passwordHash: await hashPassword('Admin1234'), rol: 'ADMIN' }).run();
  db.insert(schema.users).values({ nombre: 'Jefe de Seguridad', email: 'seguridad@shopping.local', passwordHash: await hashPassword('Seguridad1234'), rol: 'SEGURIDAD' }).run();

  // --- Locales ---
  const electro = db.insert(schema.locales).values({ nombre: 'Frávega', email: 'electro@ejemplo.local', estado: 'ACTIVO' }).returning().get();
  const deportes = db.insert(schema.locales).values({ nombre: 'Deportes', email: 'deportes@ejemplo.local', estado: 'ACTIVO' }).returning().get();
  const localx = db.insert(schema.locales).values({ nombre: 'Local X', email: 'localx@ejemplo.local', estado: 'ACTIVO' }).returning().get();

  // --- Personas (identificadas por CUIL) ---
  const juan = db.insert(schema.personas).values({ cuil: '20323616067', dni: '20323616067', nombre: 'Juan', apellido: 'Pérez', categoria: 'EMPRESA', empresa: 'GMRA S.A.U.' }).returning().get();
  const pedro = db.insert(schema.personas).values({ cuil: '20306408823', dni: '20306408823', nombre: 'Pedro', apellido: 'Gómez', categoria: 'MONOTRIBUTISTA' }).returning().get();
  const ana = db.insert(schema.personas).values({ cuil: '27283254734', dni: '27283254734', nombre: 'Ana', apellido: 'Rodríguez', categoria: 'EMPRESA' }).returning().get();

  const hoy = todayLocal();
  const enUnAnio = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);

  // Juan (EMPRESA): documentación completa y APROBADA, con vencimiento a un año.
  for (const codigo of ['FORM_931', 'PAGO_ARCA', 'NOMINA_ART', 'CLAUSULA_NO_REPETICION']) {
    saveDocumentVersion({ personaId: juan.id, tipoDocumentoId: tipoId(codigo), buffer: fakePdf(`${codigo} Juan`), originalFilename: `${codigo}_juan.pdf`, mimeType: 'application/pdf' });
    db.update(schema.documentos).set({ verificacion: 'VERIFICADO', fechaVencimiento: enUnAnio }).where(and(eq(schema.documentos.personaId, juan.id), eq(schema.documentos.tipoDocumentoId, tipoId(codigo)))).run();
  }

  // Pedro (MONOTRIBUTISTA): cargó el Seguro (sin aprobar); faltan Monotributo y Cláusula.
  saveDocumentVersion({ personaId: pedro.id, tipoDocumentoId: tipoId('SEGURO_VIDA_COLECTIVO'), buffer: fakePdf('Seguro Pedro'), originalFilename: 'seguro_pedro.pdf', mimeType: 'application/pdf' });

  // --- Solicitudes (un local, una o varias personas) ---
  const sp = (solicitudId: number, personaId: number, estado: string) =>
    db.insert(schema.solicitudPersonas).values({ solicitudId, personaId, estado }).run();

  // Frávega -> Juan AUTORIZADO (vigente hoy + ingreso abierto) y Ana PENDIENTE (misma solicitud/email).
  const solElectro = db.insert(schema.solicitudes).values({ personaId: juan.id, localId: electro.id, estado: 'EN_REVISION' }).returning().get();
  sp(solElectro.id, juan.id, 'AUTORIZADA');
  sp(solElectro.id, ana.id, 'PENDIENTE');
  const autJuan = db
    .insert(schema.autorizaciones)
    .values({ solicitudId: solElectro.id, personaId: juan.id, localId: electro.id, fecha: hoy, fechaHasta: hoy, horaDesde: '08:00', horaHasta: '18:00', estado: 'AUTORIZADA', autorizadaPorUserId: 1, comentario: 'Documentación completa.' })
    .returning()
    .get();
  db.insert(schema.entradas).values({ personaId: juan.id, localId: electro.id, autorizacionId: autJuan.id, ingresoPorUserId: 2 }).run();

  // Deportes -> Pedro OBSERVADO (faltan documentos)
  const solPedro = db.insert(schema.solicitudes).values({ personaId: pedro.id, localId: deportes.id, estado: 'OBSERVADA' }).returning().get();
  sp(solPedro.id, pedro.id, 'OBSERVADA');
  db.insert(schema.comentarios).values({ solicitudId: solPedro.id, userId: 2, contenido: 'Falta presentar Seguro de vida y Cláusula de no repetición.' }).run();

  // Registrar análisis IA para cada persona.
  for (const p of [juan, pedro, ana]) {
    const a = analyzePersona(p.id);
    db.insert(schema.aiAnalyses).values({ personaId: p.id, estadoDocumental: a.estadoDocumental, faltantesJson: JSON.stringify(a.faltantes), observaciones: a.observaciones.join(' '), recomendacion: a.recomendacion, detalleJson: JSON.stringify(a.docStatus) }).run();
  }

  logger.info('Seed completado. Usuarios: admin@shopping.local / Admin1234  y  seguridad@shopping.local / Seguridad1234');
}

seed().catch((err) => {
  logger.error({ err }, 'Fallo el seed');
  process.exit(1);
});
