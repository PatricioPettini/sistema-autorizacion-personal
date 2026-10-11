import type { FastifyInstance } from 'fastify';
import { desc, eq, and, or, gte, lte, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';

export async function auditRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAdmin);

  // Opciones para los filtros del frontend (acciones y usuarios existentes).
  app.get('/opciones', async () => {
    const acciones = db.select({ accion: schema.auditLog.accion }).from(schema.auditLog).groupBy(schema.auditLog.accion).orderBy(schema.auditLog.accion).all().map((r) => r.accion);
    const usuarios = db.select({ id: schema.users.id, nombre: schema.users.nombre }).from(schema.users).orderBy(schema.users.nombre).all();
    return { acciones, usuarios };
  });

  app.get('/', async (req) => {
    const q = req.query as any;
    const conds = [] as any[];
    if (q.entidad) conds.push(eq(schema.auditLog.entidad, String(q.entidad)));
    if (q.accion) conds.push(eq(schema.auditLog.accion, String(q.accion)));
    if (q.userId) conds.push(eq(schema.auditLog.userId, Number(q.userId)));
    if (q.desde) conds.push(gte(schema.auditLog.createdAt, `${String(q.desde)}T00:00:00.000Z`));
    if (q.hasta) conds.push(lte(schema.auditLog.createdAt, `${String(q.hasta)}T23:59:59.999Z`));

    // Búsqueda libre: por texto del detalle/acción y, resolviendo por NOMBRE, por persona o local
    // involucrados (entidad directa o referencia dentro del detalle).
    const term = String(q.q ?? '').trim().toLowerCase();
    if (term) {
      const like = `%${term}%`;
      const pids = db.select({ id: schema.personas.id }).from(schema.personas)
        .where(sql`lower(${schema.personas.apellido} || ' ' || ${schema.personas.nombre}) LIKE ${like} OR lower(${schema.personas.nombre} || ' ' || ${schema.personas.apellido}) LIKE ${like} OR ${schema.personas.cuil} LIKE ${like} OR ${schema.personas.dni} LIKE ${like}`)
        .all().map((r) => r.id);
      const lids = db.select({ id: schema.locales.id }).from(schema.locales)
        .where(sql`lower(${schema.locales.nombre}) LIKE ${like}`).all().map((r) => r.id);
      const ors: any[] = [
        sql`lower(coalesce(${schema.auditLog.detalleJson}, '')) LIKE ${like}`,
        sql`lower(${schema.auditLog.accion}) LIKE ${like}`,
      ];
      for (const pid of pids) {
        ors.push(sql`(${schema.auditLog.entidad} = 'persona' AND ${schema.auditLog.entidadId} = ${String(pid)})`);
        ors.push(sql`lower(coalesce(${schema.auditLog.detalleJson}, '')) LIKE ${`%"personaid":${pid}%`}`);
      }
      for (const lid of lids) {
        ors.push(sql`(${schema.auditLog.entidad} = 'local' AND ${schema.auditLog.entidadId} = ${String(lid)})`);
        ors.push(sql`lower(coalesce(${schema.auditLog.detalleJson}, '')) LIKE ${`%"localid":${lid}%`}`);
      }
      conds.push(or(...ors));
    }
    const where = conds.length ? and(...conds) : undefined;

    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(10, Number(q.pageSize) || 50));
    const total = db.select({ n: sql<number>`count(*)` }).from(schema.auditLog).where(where).get()?.n ?? 0;

    const rows = db
      .select({
        id: schema.auditLog.id,
        accion: schema.auditLog.accion,
        entidad: schema.auditLog.entidad,
        entidadId: schema.auditLog.entidadId,
        detalleJson: schema.auditLog.detalleJson,
        ip: schema.auditLog.ip,
        createdAt: schema.auditLog.createdAt,
        userNombre: schema.users.nombre,
      })
      .from(schema.auditLog)
      .leftJoin(schema.users, eq(schema.auditLog.userId, schema.users.id))
      .where(where)
      .orderBy(desc(schema.auditLog.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();

    // --- Diccionarios (tablas chicas) para resolver nombres sin N+1 pesado ---
    const personas = new Map(db.select({ id: schema.personas.id, nombre: schema.personas.nombre, apellido: schema.personas.apellido }).from(schema.personas).all().map((p) => [p.id, `${p.apellido}, ${p.nombre}`]));
    const locales = new Map(db.select({ id: schema.locales.id, nombre: schema.locales.nombre }).from(schema.locales).all().map((l) => [l.id, l.nombre]));
    const tipos = new Map(db.select({ id: schema.documentTypes.id, nombre: schema.documentTypes.nombre }).from(schema.documentTypes).all().map((t) => [t.id, t.nombre]));
    const usuarios = new Map(db.select({ id: schema.users.id, nombre: schema.users.nombre }).from(schema.users).all().map((u) => [u.id, u.nombre]));
    const documentos = new Map(db.select({ id: schema.documentos.id, personaId: schema.documentos.personaId }).from(schema.documentos).all().map((d) => [d.id, d.personaId]));
    const autorizaciones = new Map(db.select().from(schema.autorizaciones).all().map((a) => [a.id, a]));
    const entradas = new Map(db.select().from(schema.entradas).all().map((e) => [e.id, e]));
    const solicitudes = new Map(db.select({ id: schema.solicitudes.id, localId: schema.solicitudes.localId }).from(schema.solicitudes).all().map((s) => [s.id, s.localId]));
    const emails = new Map(db.select({ id: schema.emailMessages.id, asunto: schema.emailMessages.asunto }).from(schema.emailMessages).all().map((e) => [e.id, e.asunto]));

    const P = (id: any) => personas.get(Number(id)) ?? `persona #${id}`;
    const L = (id: any) => locales.get(Number(id)) ?? `local #${id}`;
    const T = (id: any) => tipos.get(Number(id)) ?? `documento #${id}`;
    const U = (id: any) => usuarios.get(Number(id)) ?? `usuario #${id}`;
    const localDeSolicitud = (id: any) => L(solicitudes.get(Number(id)));

    const describir = (r: (typeof rows)[number]): string => {
      let d: any = {};
      try { d = r.detalleJson ? JSON.parse(r.detalleJson) : {}; } catch { /* ignore */ }
      const eid = r.entidadId;
      switch (r.accion) {
        case 'LOGIN': return 'Inició sesión';
        case 'LOGOUT': return 'Cerró sesión';
        case 'SETUP_ADMIN_CREADO': return 'Creó el usuario administrador inicial';
        case 'PERSONA_CREADA': return `Creó la persona ${P(eid)}${d.origen === 'email' ? ' (desde un email)' : ''}`;
        case 'PERSONA_MODIFICADA': return `Modificó los datos de ${P(eid)}`;
        case 'SOLICITUD_CREADA': return `Creó una solicitud para ${localDeSolicitud(eid)}${d.personas ? ` (${d.personas} personas)` : ''}`;
        case 'SOLICITUD_CREADA_MANUAL': return `Creó una solicitud (manual) para ${localDeSolicitud(eid)}`;
        case 'SOLICITUD_PERSONA_AGREGADA': return `Agregó a ${P(d.personaId)} a la solicitud de ${localDeSolicitud(eid)}`;
        case 'SOLICITUD_PERSONA_QUITADA': return `Quitó a ${P(d.personaId)} de la solicitud de ${localDeSolicitud(eid)}`;
        case 'SOLICITUD_LOCAL_ASIGNADO': return `Asignó el local ${L(d.localId)} a una solicitud`;
        case 'SOLICITUD_ELIMINADA': return `Envió a la papelera la solicitud ${d.nroOrden ? `${d.nroOrden} ` : ''}de ${d.local ?? localDeSolicitud(eid)}${Array.isArray(d.personas) ? ` (${d.personas.length} persona/s)` : ''}`;
        case 'SOLICITUD_RESTAURADA': return `Restauró de la papelera la solicitud de ${localDeSolicitud(eid)}`;
        case 'SOLICITUD_BORRADA_DEFINITIVA': return `Borró definitivamente una solicitud${d.local ? ` de ${d.local}` : ''}`;
        case 'SOLICITUD_TIPO_ASIGNADO': return `Definió el tipo ${String(d.categoria ?? '').toLowerCase()} en una solicitud (${d.personas ?? '?'} personas)`;
        case 'SOLICITUD_TRABAJO_EDITADO': return `Editó el trabajo a realizar de la solicitud de ${localDeSolicitud(eid)}`;
        case 'SOLICITUD_VENCIMIENTO': return `Cargó la fecha de vigencia (${d.fechaVencimiento ?? '—'}) de una solicitud`;
        case 'SOLICITUD_REEMPLAZADA': return `Una solicitud fue reemplazada por documentación corregida`;
        case 'REVISION_TERMINADA': return `Terminó la revisión${d.nroOrden ? ` (orden ${d.nroOrden})` : ''}${d.emailEnviado ? ' y avisó al remitente' : ''}`;
        case 'EMAIL_REPROCESADO': return 'Reprocesó un email desde el respaldo';
        case 'EMAIL_RESPALDO_DESCARTADO': return 'Descartó un email del respaldo';
        case 'EMAIL_A_RESPALDO': return 'Un email quedó en respaldo para revisar';
        case 'ESTADO_MODIFICADO': return `Cambió a "${d.estado}" el estado de ${P(d.personaId)}`;
        case 'RECHAZO_REALIZADO': return `Rechazó a ${P(d.personaId)}${d.motivo ? ` — ${d.motivo}` : ''}`;
        case 'COMENTARIO_AGREGADO': return `Agregó un comentario a la solicitud de ${localDeSolicitud(eid)}`;
        case 'DOCUMENTO_VERIFICADO': {
          const persona = P(documentos.get(Number(eid)));
          const verbo = d.estado === 'VERIFICADO' ? 'Aprobó' : d.estado === 'RECHAZADO' ? 'Rechazó' : 'Reabrió';
          return `${verbo} ${T(d.tipoDocumentoId)} de ${persona}`;
        }
        case 'DOCUMENTO_CARGADO': return `Cargó un documento de ${P(documentos.get(Number(eid)))}`;
        case 'DOCUMENTO_ACTUALIZADO': return `Actualizó un documento de ${P(documentos.get(Number(eid)))}`;
        case 'DOCUMENTO_RECLASIFICADO': return `Reclasificó un documento de ${P(documentos.get(Number(eid)))} como ${T(d.nuevoTipoId)}`;
        case 'DOCUMENTO_REASIGNADO': return `Reasignó un documento a ${P(d.nuevaPersonaId)}`;
        case 'DOCUMENTO_DESCARGADO': return `Descargó un documento de ${P(documentos.get(Number(eid)))}`;
        case 'REQUISITO_SOLICITUD_AGREGADO': return `Le exigió ${T(d.tipoDocumentoId)} a toda la solicitud de ${localDeSolicitud(eid)}`;
        case 'REQUISITO_SOLICITUD_QUITADO': return `Dejó de exigirle ${T(d.tipoDocumentoId)} a toda la solicitud de ${localDeSolicitud(eid)}`;
        case 'AUTORIZACION_REALIZADA': {
          const a = autorizaciones.get(Number(eid));
          if (!a) return `Autorizó a ${P(d.personaId)}`;
          const rango = a.fechaHasta && a.fechaHasta !== a.fecha ? `${a.fecha} a ${a.fechaHasta}` : a.fecha;
          return `Autorizó a ${P(a.personaId)} en ${L(a.localId)} (${rango}, ${a.horaDesde}–${a.horaHasta})`;
        }
        case 'AUTORIZACION_REVOCADA': {
          const a = autorizaciones.get(Number(eid));
          return `Revocó la autorización de ${a ? P(a.personaId) : `#${eid}`}${d.motivo ? ` — ${d.motivo}` : ''}`;
        }
        case 'INGRESO_REGISTRADO': {
          const e = entradas.get(Number(eid));
          return e ? `Registró el ingreso de ${P(e.personaId)} a ${L(e.localId)}` : `Registró un ingreso`;
        }
        case 'SALIDA_REGISTRADA': {
          const e = entradas.get(Number(eid));
          return e ? `Registró la salida de ${P(e.personaId)} de ${L(e.localId)}` : `Registró una salida`;
        }
        case 'EMAIL_RECIBIDO': return `Recibió un email: "${emails.get(Number(eid)) ?? d.asunto ?? '(sin asunto)'}"`;
        case 'EMAIL_PROCESADO': return `Procesó un email: "${emails.get(Number(eid)) ?? '(sin asunto)'}"${d.personas != null ? ` (${d.personas} personas)` : ''}`;
        case 'EMAIL_SIN_EXCEL': return `Email sin Excel de personas: "${emails.get(Number(eid)) ?? '(sin asunto)'}"`;
        case 'EMAIL_ENVIADO': return `Envió un email automático${d.tipo ? ` (${String(d.tipo).toLowerCase()})` : ''}`;
        case 'EMAIL_SUMADO_A_SOLICITUD': return `Sumó documentación de un email a la solicitud de ${localDeSolicitud(eid)}${d.personasAgregadas ? ` (${d.personasAgregadas} persona/s nueva/s)` : ''}`;
        case 'EMAIL_SPAM_A_RESPALDO': return 'Un email de spam quedó en respaldo para revisar';
        case 'EMAIL_PLANILLA_EXCESIVA': return `Rechazó un email por planilla excesiva (${d.personas ?? '?'} personas)`;
        case 'EMAIL_SIN_PERSONAS': return 'Rechazó un email sin lista de personas legible';
        case 'USUARIO_CREADO': return `Creó el usuario ${U(eid)}`;
        case 'USUARIO_MODIFICADO': return `Modificó el usuario ${U(eid)}`;
        case 'LOCAL_CREADO': return `Creó el local ${L(eid)}`;
        case 'LOCAL_MODIFICADO': return `Modificó el local ${L(eid)}`;
        case 'TIPO_DOC_CREADO': return `Creó el tipo de documento ${T(eid)}`;
        case 'TIPO_DOC_MODIFICADO': return `Modificó el tipo de documento ${T(eid)}`;
        case 'CONFIGURACION_MODIFICADA': return 'Modificó la configuración de email';
        case 'EMAIL_REVISION_MANUAL': return 'Revisó el buzón de emails manualmente';
        default: return r.detalleJson ?? '';
      }
    };

    return { rows: rows.map((r) => ({ ...r, descripcion: describir(r) })), total, page, pageSize };
  });
}
