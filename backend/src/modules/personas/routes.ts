import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, or, like, desc, and, isNull } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { nowIso } from '../../lib/datetime.js';
import { normalizeCuil, formatCuil, formatDni, buscarPersonasParecidas } from './service.js';
import { getPersonaDocStatus } from '../documentos/service.js';
import { getVigencia, getVigenciasPorLocal } from '../autorizaciones/service.js';
import { analyzePersona } from '../ai/analyzer.js';

const createSchema = z.object({
  cuil: z.string().min(10, 'CUIL inválido.'),
  nombre: z.string().min(1),
  apellido: z.string().min(1),
  categoria: z.enum(['EMPRESA', 'MONOTRIBUTISTA']).nullable().optional(),
  empresa: z.string().optional(),
  notas: z.string().optional(),
});

export async function personasRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAuth);
  const soloAdmin = { onRequest: app.requireAdmin };

  // Búsqueda global por nombre, apellido o DNI.
  /**
   * Fichas que podrían ser la misma persona que la que se está por cargar. Sólo avisa: la decisión
   * de crearla igual es de quien está cargando. Es la única red contra el typo de un dígito, que da
   * un documento que existe y es de otro.
   */
  app.get('/parecidas', async (req) => {
    const q = req.query as { cuil?: string; dni?: string; nombre?: string; apellido?: string };
    return { parecidas: buscarPersonasParecidas(q) };
  });

  app.get('/', async (req) => {
    const q = String((req.query as any).q ?? '').trim();
    let rows;
    if (q) {
      // Búsqueda por palabras: cada palabra debe aparecer en nombre, apellido o CUIL.
      // Así "juan perez" encuentra a "Perez, Juan Carlos" (juan→nombre, perez→apellido).
      const tokens = q.split(/\s+/).filter(Boolean);
      const perToken = tokens.map((tok) => {
        const like_ = `%${tok}%`;
        const digits = tok.replace(/\D/g, '');
        const cs = [like(schema.personas.nombre, like_), like(schema.personas.apellido, like_)];
        // El CUIL contiene al DNI, pero hay personas cargadas solo con DNI: se miran los dos.
        if (digits) { cs.push(like(schema.personas.cuil, `%${digits}%`)); cs.push(like(schema.personas.dni, `%${digits}%`)); }
        return or(...cs);
      });
      rows = db
        .select()
        .from(schema.personas)
        .where(and(...perToken))
        .orderBy(schema.personas.apellido)
        .limit(50)
        .all();
    } else {
      rows = db.select().from(schema.personas).orderBy(desc(schema.personas.createdAt)).limit(50).all();
    }
    // La columna del listado muestra el CUIL si lo hay y, si no, el DNI: muchas personas entran
    // solo con DNI (la planilla no siempre trae CUIL) y antes esa fila se veía como "—", como si
    // no tuviera documento.
    return rows.map((p) => ({
      ...p,
      cuilFormat: p.cuil ? formatCuil(p.cuil) : '—',
      documento: p.cuil ? formatCuil(p.cuil) : (p.dni ? formatDni(p.dni) : ''),
      documentoTipo: p.cuil ? 'CUIL' : (p.dni ? 'DNI' : null),
    }));
  });

  // Ficha completa de una persona.
  app.get('/:id', async (req) => {
    const id = Number((req.params as any).id);
    const persona = db.select().from(schema.personas).where(eq(schema.personas.id, id)).get();
    if (!persona) throw notFound('Persona no encontrada.');

    const docStatus = getPersonaDocStatus(id);
    const analisis = analyzePersona(id);

    const autorizaciones = db
      .select({
        id: schema.autorizaciones.id,
        localId: schema.autorizaciones.localId,
        local: schema.locales.nombre,
        fecha: schema.autorizaciones.fecha,
        fechaHasta: schema.autorizaciones.fechaHasta,
        horaDesde: schema.autorizaciones.horaDesde,
        horaHasta: schema.autorizaciones.horaHasta,
        estado: schema.autorizaciones.estado,
        fechaDecision: schema.autorizaciones.fechaDecision,
      })
      .from(schema.autorizaciones)
      .innerJoin(schema.locales, eq(schema.autorizaciones.localId, schema.locales.id))
      .where(eq(schema.autorizaciones.personaId, id))
      .orderBy(desc(schema.autorizaciones.fechaDecision))
      .all();

    const ingresos = db
      .select({
        id: schema.entradas.id,
        local: schema.locales.nombre,
        ingreso: schema.entradas.fechaHoraIngreso,
        salida: schema.entradas.fechaHoraSalida,
      })
      .from(schema.entradas)
      .innerJoin(schema.locales, eq(schema.entradas.localId, schema.locales.id))
      .where(eq(schema.entradas.personaId, id))
      .orderBy(desc(schema.entradas.fechaHoraIngreso))
      .limit(50)
      .all();

    // Solicitudes donde participa (para linkear a la revisión, que es donde se autoriza).
    const solicitudes = db
      .select({
        solicitudId: schema.solicitudPersonas.solicitudId,
        estadoPersona: schema.solicitudPersonas.estado,
        estado: schema.solicitudes.estado,
        nroOrden: schema.solicitudes.nroOrden,
        fechaVencimiento: schema.solicitudes.fechaVencimiento,
        trabajo: schema.solicitudes.trabajo,
        deletedAt: schema.solicitudes.deletedAt,
        local: schema.locales.nombre,
      })
      .from(schema.solicitudPersonas)
      .innerJoin(schema.solicitudes, eq(schema.solicitudPersonas.solicitudId, schema.solicitudes.id))
      .innerJoin(schema.locales, eq(schema.solicitudes.localId, schema.locales.id))
      .where(eq(schema.solicitudPersonas.personaId, id))
      .orderBy(desc(schema.solicitudes.updatedAt))
      .all();

    // Estado de habilitación de ingreso (para la ficha unificada: consultar + registrar).
    const vig = getVigencia(id);
    const local = vig.autorizacion
      ? db.select().from(schema.locales).where(eq(schema.locales.id, vig.autorizacion.localId)).get() ?? null
      : null;
    const ingresoAbierto = db
      .select()
      .from(schema.entradas)
      .where(and(eq(schema.entradas.personaId, id), isNull(schema.entradas.fechaHoraSalida)))
      .get() ?? null;
    const localAbierto = ingresoAbierto
      ? db.select({ nombre: schema.locales.nombre }).from(schema.locales).where(eq(schema.locales.id, ingresoAbierto.localId)).get()?.nombre ?? null
      : null;

    // Puede estar autorizada por más de un local a la vez. Se devuelven todas para que quien
    // registra el ingreso elija, en vez de imputárselo siempre al mismo.
    const vigentes = getVigenciasPorLocal(id).map((a) => ({
      autorizacionId: a.id,
      localId: a.localId,
      local: db.select({ nombre: schema.locales.nombre }).from(schema.locales).where(eq(schema.locales.id, a.localId)).get()?.nombre ?? '—',
      trabajo: solicitudes.find((so) => so.solicitudId === a.solicitudId)?.trabajo ?? null,
      fecha: a.fecha,
      fechaHasta: a.fechaHasta,
      horaDesde: a.horaDesde,
      horaHasta: a.horaHasta,
    }));

    return {
      persona: { ...persona, cuilFormat: persona.cuil ? formatCuil(persona.cuil) : '—' },
      docStatus,
      analisis,
      solicitudes,
      autorizaciones,
      ingresos,
      vigencia: vig.estado,
      autorizacionVigente: vig.autorizacion,
      localVigente: local,
      // Trabajo/tarea de la solicitud que le da la autorización vigente (lo ve Seguridad).
      trabajoVigente: vig.autorizacion ? (solicitudes.find((s) => s.solicitudId === vig.autorizacion!.solicitudId)?.trabajo ?? null) : null,
      // Todas las vigentes, una por local: si son varias, Seguridad tiene que elegir a cuál entra.
      vigentes,
      ingresoAbierto: ingresoAbierto ? { ...ingresoAbierto, local: localAbierto } : null,
    };
  });

  app.post('/', soloAdmin, async (req) => {
    const data = createSchema.parse(req.body);
    const cuil = normalizeCuil(data.cuil);
    const persona = db
      .insert(schema.personas)
      .values({ cuil, dni: cuil, nombre: data.nombre.trim(), apellido: data.apellido.trim(), notas: data.notas || null })
      .returning()
      .get();
    audit({ userId: req.user!.id, accion: 'PERSONA_CREADA', entidad: 'persona', entidadId: persona.id, ip: req.ip });
    return { ...persona, cuilFormat: formatCuil(cuil) };
  });

  app.patch('/:id', soloAdmin, async (req) => {
    const id = Number((req.params as any).id);
    const data = createSchema.partial().parse(req.body);
    const existing = db.select().from(schema.personas).where(eq(schema.personas.id, id)).get();
    if (!existing) throw notFound('Persona no encontrada.');
    const nuevoCuil = data.cuil ? normalizeCuil(data.cuil) : existing.cuil;
    db.update(schema.personas)
      .set({
        cuil: nuevoCuil,
        dni: nuevoCuil ?? existing.dni,
        nombre: data.nombre ?? existing.nombre,
        apellido: data.apellido ?? existing.apellido,
        categoria: data.categoria !== undefined ? data.categoria : existing.categoria,
        empresa: data.empresa !== undefined ? data.empresa || null : existing.empresa,
        notas: data.notas !== undefined ? data.notas || null : existing.notas,
        updatedAt: nowIso(),
      })
      .where(eq(schema.personas.id, id))
      .run();
    audit({ userId: req.user!.id, accion: 'PERSONA_MODIFICADA', entidad: 'persona', entidadId: id, ip: req.ip });
    return { ok: true };
  });
}
