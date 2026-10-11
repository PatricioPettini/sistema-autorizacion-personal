import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound, conflict } from '../../lib/errors.js';
import { isAllowedFile, contentDisposition } from '../../lib/files.js';
import { saveDocumentVersion, saveSolicitudDocument } from '../storage/service.js';
import { nowIso } from '../../lib/datetime.js';
import { env } from '../../config/env.js';
import { recomputeAutorizacionesDePersona, recomputeAutorizacionesDeSolicitud } from '../autorizaciones/service.js';

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export async function documentosRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAuth);
  // Ver documentación: cualquier usuario autenticado. Modificar/verificar: solo Admin.
  const soloAdmin = { onRequest: app.requireAdmin };

  // Versiones de un documento (historial).
  app.get('/:documentoId/versiones', async (req) => {
    const documentoId = Number((req.params as any).documentoId);
    return db
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.documentoId, documentoId))
      .orderBy(desc(schema.documentVersions.version))
      .all();
  });

  // Ver / descargar un archivo de forma protegida (nunca por URL pública directa).
  app.get('/version/:id/archivo', async (req, reply) => {
    const id = Number((req.params as any).id);
    const download = String((req.query as any).download ?? '') === '1';
    const version = db.select().from(schema.documentVersions).where(eq(schema.documentVersions.id, id)).get();
    if (!version) throw notFound('Documento no encontrado.');

    const filePath = version.storedPathNormalized || version.storedPathOriginal;
    if (!filePath || !fs.existsSync(filePath)) throw notFound('El archivo no está disponible en el almacenamiento.');

    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    reply.header('Content-Type', MIME[ext] ?? 'application/octet-stream');
    reply.header(
      'Content-Disposition',
      contentDisposition(download ? 'attachment' : 'inline', version.normalizedFilename ?? version.originalFilename),
    );
    if (download) {
      audit({ userId: req.user!.id, accion: 'DOCUMENTO_DESCARGADO', entidad: 'document_version', entidadId: id, ip: req.ip });
    }
    return reply.send(fs.createReadStream(filePath));
  });

  // Carga manual de un documento para una persona + tipo.
  app.post('/upload', soloAdmin, async (req) => {
    const parts = req.parts();
    let personaId = 0;
    let tipoDocumentoId = 0;
    let fileBuffer: Buffer | null = null;
    let filename = '';
    let mime = '';

    for await (const part of parts) {
      if (part.type === 'file') {
        filename = part.filename;
        mime = part.mimetype;
        fileBuffer = await part.toBuffer();
      } else {
        if (part.fieldname === 'personaId') personaId = Number(part.value);
        if (part.fieldname === 'tipoDocumentoId') tipoDocumentoId = Number(part.value);
      }
    }

    if (!fileBuffer) throw badRequest('No se recibió ningún archivo.');
    if (!personaId || !tipoDocumentoId) throw badRequest('Faltan datos: persona o tipo de documento.');
    if (fileBuffer.length > env.rules.maxFileMb * 1024 * 1024) throw badRequest('El archivo supera el tamaño máximo permitido.');
    if (!isAllowedFile(filename, mime)) throw badRequest('Formato no permitido. Se aceptan PDF, JPG o PNG.');

    const result = saveDocumentVersion({
      personaId,
      tipoDocumentoId,
      buffer: fileBuffer,
      originalFilename: filename,
      mimeType: mime,
      createdByUserId: req.user!.id,
    });
    return result;
  });

  // --- Verificación manual: Seguridad confirma / rechaza cada documentación ---
  const verificarSchema = z.object({
    personaId: z.number().int(),
    tipoDocumentoId: z.number().int(),
    estado: z.enum(['PENDIENTE', 'VERIFICADO', 'RECHAZADO']),
    nota: z.string().optional(),
  });

  app.post('/verificar', soloAdmin, async (req) => {
    const data = verificarSchema.parse(req.body);
    // Busca el documento (persona+tipo); si no existe lo crea para poder marcar el estado.
    let doc = db
      .select()
      .from(schema.documentos)
      .where(and(eq(schema.documentos.personaId, data.personaId), eq(schema.documentos.tipoDocumentoId, data.tipoDocumentoId)))
      .get();
    if (!doc) {
      doc = db.insert(schema.documentos).values({ personaId: data.personaId, tipoDocumentoId: data.tipoDocumentoId }).returning().get();
    }
    db.update(schema.documentos)
      .set({
        verificacion: data.estado,
        verificadoPorUserId: req.user!.id,
        fechaVerificacion: nowIso(),
        notaVerificacion: data.nota || null,
        updatedAt: nowIso(),
      })
      .where(eq(schema.documentos.id, doc.id))
      .run();
    audit({ userId: req.user!.id, accion: 'DOCUMENTO_VERIFICADO', entidad: 'documento', entidadId: doc.id, detalle: { estado: data.estado, tipoDocumentoId: data.tipoDocumentoId }, ip: req.ip });
    // Si con esto la persona completó (o dejó de completar) su documentación, se ajusta su
    // autorización automáticamente en las solicitudes donde participa.
    recomputeAutorizacionesDePersona(data.personaId, req.user!.id);
    return { ok: true };
  });

  /**
   * El mismo requisito para varias personas de una vez.
   *
   * La Nómina ART es UN solo PDF que lista a todo el grupo, pero el requisito es por persona: en un
   * pedido de 28 había que aprobarlo 28 veces, mirando siempre el mismo papel. Medido sobre 163
   * solicitudes de 2 o más personas, el requisito se aprueba para TODAS en 110 y sólo en 5 para
   * algunas sí y otras no: el caso normal es en bloque.
   *
   * Recibe la lista explícita de personas —no "todas las de la solicitud"— para que quien revisa
   * pueda dejar afuera a las que el papel no respalda.
   */
  const verificarVariosSchema = z.object({
    personaIds: z.array(z.number().int()).min(1),
    tipoDocumentoId: z.number().int(),
    estado: z.enum(['PENDIENTE', 'VERIFICADO', 'RECHAZADO']),
    nota: z.string().optional(),
  });

  app.post('/verificar-varios', soloAdmin, async (req) => {
    const data = verificarVariosSchema.parse(req.body);

    for (const personaId of data.personaIds) {
      let doc = db
        .select()
        .from(schema.documentos)
        .where(and(eq(schema.documentos.personaId, personaId), eq(schema.documentos.tipoDocumentoId, data.tipoDocumentoId)))
        .get();
      if (!doc) {
        doc = db.insert(schema.documentos).values({ personaId, tipoDocumentoId: data.tipoDocumentoId }).returning().get();
      }
      db.update(schema.documentos)
        .set({
          verificacion: data.estado,
          verificadoPorUserId: req.user!.id,
          fechaVerificacion: nowIso(),
          notaVerificacion: data.nota || null,
          updatedAt: nowIso(),
        })
        .where(eq(schema.documentos.id, doc.id))
        .run();
      // Cada persona se audita por separado: en la auditoría tiene que poder leerse quién quedó
      // aprobado, no sólo que hubo una acción en bloque.
      audit({ userId: req.user!.id, accion: 'DOCUMENTO_VERIFICADO', entidad: 'documento', entidadId: doc.id, detalle: { estado: data.estado, tipoDocumentoId: data.tipoDocumentoId, enBloque: true }, ip: req.ip });
      recomputeAutorizacionesDePersona(personaId, req.user!.id);
    }
    return { ok: true, cuantas: data.personaIds.length };
  });

  // --- Documentos de alcance SOLICITUD (uno para todo el grupo) ---

  // Carga de un documento de solicitud (Form 931, Pago ARCA, Cláusula, Seguro de Vida).
  app.post('/solicitud-upload', soloAdmin, async (req) => {
    const parts = req.parts();
    let solicitudId = 0;
    let tipoDocumentoId = 0;
    let fileBuffer: Buffer | null = null;
    let filename = '';
    let mime = '';
    for await (const part of parts) {
      if (part.type === 'file') { filename = part.filename; mime = part.mimetype; fileBuffer = await part.toBuffer(); }
      else {
        if (part.fieldname === 'solicitudId') solicitudId = Number(part.value);
        if (part.fieldname === 'tipoDocumentoId') tipoDocumentoId = Number(part.value);
      }
    }
    if (!fileBuffer) throw badRequest('No se recibió ningún archivo.');
    if (!solicitudId || !tipoDocumentoId) throw badRequest('Faltan datos: solicitud o tipo de documento.');
    if (fileBuffer.length > env.rules.maxFileMb * 1024 * 1024) throw badRequest('El archivo supera el tamaño máximo permitido.');
    if (!isAllowedFile(filename, mime)) throw badRequest('Formato no permitido. Se aceptan PDF, JPG o PNG.');

    const tipo = db.select().from(schema.documentTypes).where(eq(schema.documentTypes.id, tipoDocumentoId)).get();
    if (!tipo || tipo.alcance !== 'SOLICITUD') throw badRequest('Ese documento no es de alcance solicitud.');

    const result = saveSolicitudDocument({ solicitudId, tipoDocumentoId, buffer: fileBuffer, originalFilename: filename, mimeType: mime, createdByUserId: req.user!.id });
    // Recargar un doc lo deja PENDIENTE: puede desautorizar a las personas ya autorizadas.
    recomputeAutorizacionesDeSolicitud(solicitudId, req.user!.id);
    return result;
  });

  // Verificación de un documento de alcance SOLICITUD.
  const verificarSolSchema = z.object({
    solicitudId: z.number().int(),
    tipoDocumentoId: z.number().int(),
    estado: z.enum(['PENDIENTE', 'VERIFICADO', 'RECHAZADO']),
    nota: z.string().optional(),
  });
  app.post('/solicitud-verificar', soloAdmin, async (req) => {
    const data = verificarSolSchema.parse(req.body);
    let doc = db
      .select()
      .from(schema.solicitudDocumentos)
      .where(and(eq(schema.solicitudDocumentos.solicitudId, data.solicitudId), eq(schema.solicitudDocumentos.tipoDocumentoId, data.tipoDocumentoId)))
      .get();
    if (!doc) {
      doc = db.insert(schema.solicitudDocumentos).values({ solicitudId: data.solicitudId, tipoDocumentoId: data.tipoDocumentoId }).returning().get();
    }
    db.update(schema.solicitudDocumentos)
      .set({ verificacion: data.estado, verificadoPorUserId: req.user!.id, fechaVerificacion: nowIso(), notaVerificacion: data.nota || null, updatedAt: nowIso() })
      .where(eq(schema.solicitudDocumentos.id, doc.id))
      .run();
    audit({ userId: req.user!.id, accion: 'SOLICITUD_DOC_VERIFICADO', entidad: 'solicitud_documento', entidadId: doc.id, detalle: { estado: data.estado, tipoDocumentoId: data.tipoDocumentoId, solicitudId: data.solicitudId }, ip: req.ip });
    // Un documento de solicitud afecta a TODAS sus personas.
    recomputeAutorizacionesDeSolicitud(data.solicitudId, req.user!.id);
    return { ok: true };
  });

  // Ver / descargar el archivo de un documento de solicitud.
  app.get('/solicitud-doc/:id/archivo', async (req, reply) => {
    const id = Number((req.params as any).id);
    const download = String((req.query as any).download ?? '') === '1';
    const doc = db.select().from(schema.solicitudDocumentos).where(eq(schema.solicitudDocumentos.id, id)).get();
    if (!doc) throw notFound('Documento no encontrado.');
    const filePath = doc.storedPathNormalized || doc.storedPathOriginal;
    if (!filePath || !fs.existsSync(filePath)) throw notFound('El archivo no está disponible en el almacenamiento.');
    const ext2 = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    reply.header('Content-Type', MIME[ext2] ?? 'application/octet-stream');
    reply.header('Content-Disposition', contentDisposition(download ? 'attachment' : 'inline', doc.normalizedFilename ?? doc.originalFilename));
    return reply.send(fs.createReadStream(filePath));
  });

  // --- Requisitos EXTRA por persona (ej. trabajo en altura) ---
  // Se puede elegir un tipo del catálogo EXTRA (tipoDocumentoId) o crear uno nuevo por nombre.
  const requisitoSchema = z
    .object({
      personaId: z.number().int(),
      tipoDocumentoId: z.number().int().optional(),
      nombre: z.string().trim().min(2).optional(),
      solicitudId: z.number().int().optional(),
    })
    .refine((d) => d.tipoDocumentoId != null || !!d.nombre, { message: 'Elegí o escribí el requisito.' });

  /** Genera un código único para un tipo EXTRA nuevo a partir del nombre. */
  const codigoDesdeNombre = (nombre: string): string => {
    const base =
      'EXTRA_' +
      nombre
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
    let codigo = base || 'EXTRA_REQ';
    let n = 2;
    while (db.select().from(schema.documentTypes).where(eq(schema.documentTypes.codigo, codigo)).get()) {
      codigo = `${base}_${n++}`;
    }
    return codigo;
  };

  app.post('/requisitos', soloAdmin, async (req) => {
    const data = requisitoSchema.parse(req.body);
    const persona = db.select().from(schema.personas).where(eq(schema.personas.id, data.personaId)).get();
    if (!persona) throw notFound('Persona no encontrada.');

    // Resolver el tipo: existente por id, o crear uno EXTRA nuevo por nombre.
    let tipoId = data.tipoDocumentoId ?? 0;
    if (!tipoId) {
      const nombre = data.nombre!.slice(0, 120);
      const codigo = codigoDesdeNombre(nombre);
      const tipo = db
        .insert(schema.documentTypes)
        .values({ codigo, nombre, obligatorio: true, tieneVencimiento: false, categoria: 'EXTRA', controlaEmision: false, orden: 60, activo: true })
        .returning()
        .get();
      tipoId = tipo.id;
      audit({ userId: req.user!.id, accion: 'TIPO_DOC_CREADO', entidad: 'document_type', entidadId: tipoId, detalle: { codigo, extra: true }, ip: req.ip });
    } else {
      const tipo = db.select().from(schema.documentTypes).where(eq(schema.documentTypes.id, tipoId)).get();
      if (!tipo) throw notFound('Tipo de documento no encontrado.');
    }

    db.insert(schema.requisitosPersona)
      .values({ personaId: data.personaId, tipoDocumentoId: tipoId, solicitudId: data.solicitudId ?? null, createdByUserId: req.user!.id })
      .onConflictDoNothing()
      .run();
    audit({ userId: req.user!.id, accion: 'REQUISITO_AGREGADO', entidad: 'persona', entidadId: data.personaId, detalle: { tipoDocumentoId: tipoId, solicitudId: data.solicitudId }, ip: req.ip });
    recomputeAutorizacionesDePersona(data.personaId, req.user!.id);
    return { ok: true, tipoDocumentoId: tipoId };
  });

  app.delete('/requisitos/:personaId/:tipoDocumentoId', soloAdmin, async (req) => {
    const personaId = Number((req.params as any).personaId);
    const tipoDocumentoId = Number((req.params as any).tipoDocumentoId);
    db.delete(schema.requisitosPersona)
      .where(and(eq(schema.requisitosPersona.personaId, personaId), eq(schema.requisitosPersona.tipoDocumentoId, tipoDocumentoId)))
      .run();
    audit({ userId: req.user!.id, accion: 'REQUISITO_QUITADO', entidad: 'persona', entidadId: personaId, detalle: { tipoDocumentoId }, ip: req.ip });
    recomputeAutorizacionesDePersona(personaId, req.user!.id);
    return { ok: true };
  });

  // --- Requisitos EXTRA de alcance SOLICITUD (uno para todo el grupo, como el Formulario 931) ---
  const requisitoSolSchema = z
    .object({
      solicitudId: z.number().int(),
      tipoDocumentoId: z.number().int().optional(),
      nombre: z.string().trim().min(2).optional(),
    })
    .refine((d) => d.tipoDocumentoId != null || !!d.nombre, { message: 'Elegí o escribí el requisito.' });

  app.post('/requisitos-solicitud', soloAdmin, async (req) => {
    const data = requisitoSolSchema.parse(req.body);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, data.solicitudId)).get();
    if (!sol) throw notFound('Solicitud no encontrada.');

    // Tipo existente por id, o uno EXTRA nuevo por nombre.
    let tipoId = data.tipoDocumentoId ?? 0;
    if (!tipoId) {
      const nombre = data.nombre!.slice(0, 120);
      const codigo = codigoDesdeNombre(nombre);
      const tipo = db
        .insert(schema.documentTypes)
        .values({ codigo, nombre, obligatorio: true, tieneVencimiento: false, categoria: 'EXTRA', controlaEmision: false, orden: 60, activo: true })
        .returning()
        .get();
      tipoId = tipo.id;
      audit({ userId: req.user!.id, accion: 'TIPO_DOC_CREADO', entidad: 'document_type', entidadId: tipoId, detalle: { codigo, extra: true }, ip: req.ip });
    } else if (!db.select().from(schema.documentTypes).where(eq(schema.documentTypes.id, tipoId)).get()) {
      throw notFound('Tipo de documento no encontrado.');
    }

    db.insert(schema.requisitosSolicitud)
      .values({ solicitudId: data.solicitudId, tipoDocumentoId: tipoId, createdByUserId: req.user!.id })
      .onConflictDoNothing()
      .run();
    audit({ userId: req.user!.id, accion: 'REQUISITO_SOLICITUD_AGREGADO', entidad: 'solicitud', entidadId: data.solicitudId, detalle: { tipoDocumentoId: tipoId }, ip: req.ip });
    recomputeAutorizacionesDeSolicitud(data.solicitudId, req.user!.id);
    return { ok: true, tipoDocumentoId: tipoId };
  });

  app.delete('/requisitos-solicitud/:solicitudId/:tipoDocumentoId', soloAdmin, async (req) => {
    const solicitudId = Number((req.params as any).solicitudId);
    const tipoDocumentoId = Number((req.params as any).tipoDocumentoId);
    db.delete(schema.requisitosSolicitud)
      .where(and(eq(schema.requisitosSolicitud.solicitudId, solicitudId), eq(schema.requisitosSolicitud.tipoDocumentoId, tipoDocumentoId)))
      .run();
    audit({ userId: req.user!.id, accion: 'REQUISITO_SOLICITUD_QUITADO', entidad: 'solicitud', entidadId: solicitudId, detalle: { tipoDocumentoId }, ip: req.ip });
    recomputeAutorizacionesDeSolicitud(solicitudId, req.user!.id);
    return { ok: true };
  });

  // --- Reclasificar: corregir el tipo que la IA detectó mal ---
  app.post('/:documentoId/reclasificar', soloAdmin, async (req) => {
    const documentoId = Number((req.params as any).documentoId);
    const nuevoTipoId = Number((req.body as any)?.tipoDocumentoId);
    if (!nuevoTipoId) throw badRequest('Falta el tipo de documento destino.');
    const doc = db.select().from(schema.documentos).where(eq(schema.documentos.id, documentoId)).get();
    if (!doc) throw notFound('Documento no encontrado.');
    if (doc.tipoDocumentoId === nuevoTipoId) return { ok: true };
    const conflicto = db
      .select()
      .from(schema.documentos)
      .where(and(eq(schema.documentos.personaId, doc.personaId), eq(schema.documentos.tipoDocumentoId, nuevoTipoId)))
      .get();
    if (conflicto) throw conflict('La persona ya tiene un documento de ese tipo. Verificá o reemplazá ese documento manualmente.');
    db.update(schema.documentos)
      .set({ tipoDocumentoId: nuevoTipoId, verificacion: 'PENDIENTE', updatedAt: nowIso() })
      .where(eq(schema.documentos.id, documentoId))
      .run();
    audit({ userId: req.user!.id, accion: 'DOCUMENTO_RECLASIFICADO', entidad: 'documento', entidadId: documentoId, detalle: { nuevoTipoId }, ip: req.ip });
    return { ok: true };
  });

  // --- Reasignar: corregir la persona a la que la IA asoció el documento ---
  app.post('/:documentoId/reasignar', soloAdmin, async (req) => {
    const documentoId = Number((req.params as any).documentoId);
    const nuevaPersonaId = Number((req.body as any)?.personaId);
    if (!nuevaPersonaId) throw badRequest('Falta la persona destino.');
    const doc = db.select().from(schema.documentos).where(eq(schema.documentos.id, documentoId)).get();
    if (!doc) throw notFound('Documento no encontrado.');
    const persona = db.select().from(schema.personas).where(eq(schema.personas.id, nuevaPersonaId)).get();
    if (!persona) throw notFound('Persona destino no encontrada.');
    if (doc.personaId === nuevaPersonaId) return { ok: true };
    const conflicto = db
      .select()
      .from(schema.documentos)
      .where(and(eq(schema.documentos.personaId, nuevaPersonaId), eq(schema.documentos.tipoDocumentoId, doc.tipoDocumentoId)))
      .get();
    if (conflicto) throw conflict('La persona destino ya tiene un documento de ese tipo.');
    db.update(schema.documentos).set({ personaId: nuevaPersonaId, updatedAt: nowIso() }).where(eq(schema.documentos.id, documentoId)).run();
    audit({ userId: req.user!.id, accion: 'DOCUMENTO_REASIGNADO', entidad: 'documento', entidadId: documentoId, detalle: { nuevaPersonaId }, ip: req.ip });
    return { ok: true };
  });
}
