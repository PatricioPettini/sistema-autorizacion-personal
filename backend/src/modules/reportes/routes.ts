import type { FastifyInstance } from 'fastify';
import { eq, and, gte, lte, isNull, or, desc, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { formatCuil } from '../personas/service.js';
import { badRequest } from '../../lib/errors.js';
import { todayLocal, horaLocal, localAUtcIso, daysUntil } from '../../lib/datetime.js';

export async function reportesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.requireAuth);

  // Quién está adentro ahora (ingresaron y no registraron salida).
  app.get('/dentro', async () => {
    const rows = db
      .select({
        id: schema.entradas.id,
        nombre: schema.personas.nombre,
        apellido: schema.personas.apellido,
        cuil: schema.personas.cuil,
        local: schema.locales.nombre,
        ingreso: schema.entradas.fechaHoraIngreso,
      })
      .from(schema.entradas)
      .innerJoin(schema.personas, eq(schema.entradas.personaId, schema.personas.id))
      .innerJoin(schema.locales, eq(schema.entradas.localId, schema.locales.id))
      .where(isNull(schema.entradas.fechaHoraSalida))
      .orderBy(schema.locales.nombre, schema.personas.apellido)
      .all();
    return rows.map((r) => ({ ...r, cuilFormat: r.cuil ? formatCuil(r.cuil) : '—' }));
  });

  /**
   * Quién estaba adentro en un momento puntual (fecha + hora locales).
   *
   * Está adentro en el instante T quien entró antes de T y salió después de T. Los ingresos sin
   * salida registrada cuentan como presentes —es lo único que dice el registro— pero se devuelven
   * marcados con `sinSalida`: no es lo mismo que una permanencia probada por dos marcas, y en la
   * práctica casi siempre es alguien a quien no le registraron la salida.
   */
  app.get('/presentes', async (req) => {
    const q = req.query as any;
    const fecha = String(q.fecha ?? todayLocal());
    const hora = String(q.hora ?? horaLocal());
    const momento = localAUtcIso(fecha, hora);
    if (!momento) throw badRequest('Fecha u hora inválida. Usá AAAA-MM-DD y HH:MM.');

    const conds = [
      lte(schema.entradas.fechaHoraIngreso, momento),
      or(isNull(schema.entradas.fechaHoraSalida), gte(schema.entradas.fechaHoraSalida, momento)),
    ] as any[];
    if (q.localId) conds.push(eq(schema.entradas.localId, Number(q.localId)));

    const rows = db
      .select({
        id: schema.entradas.id,
        personaId: schema.personas.id,
        nombre: schema.personas.nombre,
        apellido: schema.personas.apellido,
        cuil: schema.personas.cuil,
        dni: schema.personas.dni,
        local: schema.locales.nombre,
        ingreso: schema.entradas.fechaHoraIngreso,
        salida: schema.entradas.fechaHoraSalida,
      })
      .from(schema.entradas)
      .innerJoin(schema.personas, eq(schema.entradas.personaId, schema.personas.id))
      .innerJoin(schema.locales, eq(schema.entradas.localId, schema.locales.id))
      .where(and(...conds))
      .orderBy(schema.locales.nombre, schema.personas.apellido)
      .all();

    return {
      momento,
      fecha,
      hora,
      personas: rows.map((r) => ({
        ...r,
        documento: r.cuil ? formatCuil(r.cuil) : (r.dni || '—'),
        sinSalida: !r.salida,
      })),
    };
  });

  // Ingresos y salidas por rango de fechas (por fecha de ingreso).
  app.get('/ingresos', async (req) => {
    const q = req.query as any;
    const desde = String(q.desde ?? todayLocal());
    const hasta = String(q.hasta ?? todayLocal());
    // El rango se interpreta en hora local: pegar "T00:00:00Z" corría todo 3 h y un ingreso de las
    // 22:00 caía en el día siguiente.
    const desdeUtc = localAUtcIso(desde, '00:00');
    const hastaUtc = localAUtcIso(hasta, '23:59:59');
    if (!desdeUtc || !hastaUtc) throw badRequest('Rango de fechas inválido.');
    const conds = [
      gte(schema.entradas.fechaHoraIngreso, desdeUtc),
      lte(schema.entradas.fechaHoraIngreso, hastaUtc),
    ] as any[];
    if (q.localId) conds.push(eq(schema.entradas.localId, Number(q.localId)));

    const rows = db
      .select({
        id: schema.entradas.id,
        nombre: schema.personas.nombre,
        apellido: schema.personas.apellido,
        cuil: schema.personas.cuil,
        local: schema.locales.nombre,
        ingreso: schema.entradas.fechaHoraIngreso,
        salida: schema.entradas.fechaHoraSalida,
      })
      .from(schema.entradas)
      .innerJoin(schema.personas, eq(schema.entradas.personaId, schema.personas.id))
      .innerJoin(schema.locales, eq(schema.entradas.localId, schema.locales.id))
      .where(and(...conds))
      .orderBy(desc(schema.entradas.fechaHoraIngreso))
      .all();
    return rows.map((r) => ({ ...r, cuilFormat: r.cuil ? formatCuil(r.cuil) : '—' }));
  });

  // Personal autorizado por local (opcionalmente solo con vigencia hoy).
  app.get('/autorizados', async (req) => {
    const q = req.query as any;
    const today = todayLocal();
    const conds = [eq(schema.autorizaciones.estado, 'AUTORIZADA')] as any[];
    if (q.localId) conds.push(eq(schema.autorizaciones.localId, Number(q.localId)));

    let rows = db
      .select({
        id: schema.autorizaciones.id,
        nombre: schema.personas.nombre,
        apellido: schema.personas.apellido,
        cuil: schema.personas.cuil,
        local: schema.locales.nombre,
        fecha: schema.autorizaciones.fecha,
        fechaHasta: schema.autorizaciones.fechaHasta,
        horaDesde: schema.autorizaciones.horaDesde,
        horaHasta: schema.autorizaciones.horaHasta,
      })
      .from(schema.autorizaciones)
      .innerJoin(schema.personas, eq(schema.autorizaciones.personaId, schema.personas.id))
      .innerJoin(schema.locales, eq(schema.autorizaciones.localId, schema.locales.id))
      .where(and(...conds))
      .orderBy(schema.locales.nombre, schema.personas.apellido)
      .all();

    // Solo vigentes hoy: hoy dentro del rango [fecha, fechaHasta].
    if (String(q.soloVigentes ?? '') === '1') {
      rows = rows.filter((r) => r.fecha <= today && (r.fechaHasta ?? r.fecha) >= today);
    }
    return rows.map((r) => ({
      ...r,
      cuilFormat: r.cuil ? formatCuil(r.cuil) : '—',
      vigenteHoy: r.fecha <= today && (r.fechaHasta ?? r.fecha) >= today,
    }));
  });

  // Documentación aprobada vencida o próxima a vencer (dentro de N días; por defecto 15).
  app.get('/vencimientos', async (req) => {
    const dias = Number((req.query as any).dias) || 15;
    const rows = db
      .select({
        id: schema.documentos.id,
        fechaVencimiento: schema.documentos.fechaVencimiento,
        nombre: schema.personas.nombre,
        apellido: schema.personas.apellido,
        cuil: schema.personas.cuil,
        tipo: schema.documentTypes.nombre,
      })
      .from(schema.documentos)
      .innerJoin(schema.personas, eq(schema.documentos.personaId, schema.personas.id))
      .innerJoin(schema.documentTypes, eq(schema.documentos.tipoDocumentoId, schema.documentTypes.id))
      .where(sql`${schema.documentos.verificacion} = 'VERIFICADO' AND ${schema.documentos.fechaVencimiento} IS NOT NULL AND date(${schema.documentos.fechaVencimiento}) <= date('now', '+' || ${dias} || ' day')`)
      .all();

    return rows
      .map((r) => ({ ...r, cuilFormat: r.cuil ? formatCuil(r.cuil) : '—', diasParaVencer: daysUntil(r.fechaVencimiento) }))
      .sort((a, b) => (a.diasParaVencer ?? 0) - (b.diasParaVencer ?? 0));
  });
}
