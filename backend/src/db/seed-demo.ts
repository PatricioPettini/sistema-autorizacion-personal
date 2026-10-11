/**
 * Datos de DEMOSTRACIÓN, para mostrar el sistema sin exponer datos reales.
 *
 * Los nombres, los CUIL y los locales son inventados: ninguno sale de producción, y los locales no
 * coinciden con ninguno de los reales. Los CUIL tienen el verificador válido para que el sistema
 * los acepte como acepta uno de verdad.
 *
 * Deja armado lo que hace falta para las capturas: una solicitud con documentación aprobada y otra
 * incompleta, autorizaciones vigentes, y tres ingresos —dos abiertos y uno cerrado— para que el
 * reporte "quién estaba a tal hora" tenga algo que mostrar.
 *
 * SIEMPRE contra un STORAGE_PATH aparte, nunca contra la base de producción:
 *   STORAGE_PATH=./storage-demo SESSION_SECRET=cualquier-cosa npm run seed:demo --workspace backend
 *   STORAGE_PATH=./storage-demo SESSION_SECRET=cualquier-cosa PORT=4010 npm run dev --workspace backend
 *
 * Entrar con demo@ejemplo.com / demo1234.
 */
import { migrate } from './migrate.js';
import { db, schema } from './client.js';
import { hashPassword } from '../lib/password.js';
import { eq, and } from 'drizzle-orm';

migrate();

const hoy = new Date();
const dia = (n: number) => { const d = new Date(hoy); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const hora = (h: number, m: number) => { const d = new Date(hoy); d.setHours(h, m, 0, 0); return d.toISOString(); };

// --- usuario para entrar a sacar las capturas
const email = 'demo@ejemplo.com';
const admin = db.select().from(schema.users).where(eq(schema.users.email, email)).get()
  ?? db.insert(schema.users).values({
    nombre: 'Equipo de Seguridad', email, passwordHash: await hashPassword('demo1234'), rol: 'ADMIN', activo: true,
  }).returning().get();

// --- locales inventados (ninguno coincide con los reales)
const local = (nombre: string) => db.select().from(schema.locales).where(eq(schema.locales.nombre, nombre)).get()
  ?? db.insert(schema.locales).values({ nombre, estado: 'ACTIVO' }).returning().get();
const indumentaria = local('MARTINEZ INDUMENTARIA');
const cafe = local('CAFÉ DEL CENTRO');
const tecno = local('TECNO SUR');

const persona = (apellido: string, nombre: string, cuil: string) => {
  const dni = cuil.slice(2, 10);
  return db.select().from(schema.personas).where(eq(schema.personas.cuil, cuil)).get()
    ?? db.insert(schema.personas).values({ cuil, dni, apellido, nombre, categoria: 'EMPRESA' }).returning().get();
};

// CUIL con verificador válido para que el sistema los acepte, con nombres inventados.
const gente = [
  persona('MARTINEZ', 'Rodrigo Ariel', '20281235304'),
  persona('SOSA', 'Julieta Belen', '27337926453'),
  persona('QUIROGA', 'Damian Ezequiel', '20355834187'),
  persona('BENITEZ', 'Lucas Nahuel', '20405284957'),
];

const tipos = db.select().from(schema.documentTypes).all();
const porPersona = tipos.filter((t) => t.alcance === 'PERSONA' && t.obligatorio && t.categoria === 'EMPRESA');
const porSolicitud = tipos.filter((t) => t.alcance === 'SOLICITUD' && t.obligatorio && ['EMPRESA', 'AMBOS'].includes(t.categoria));

type Local = typeof schema.locales.$inferSelect;
type Persona = typeof schema.personas.$inferSelect;

function armarSolicitud(
  { localRow, personas, trabajo, vencimiento, completa, nroOrden }:
  { localRow: Local; personas: Persona[]; trabajo: string; vencimiento: string; completa: boolean; nroOrden: string },
) {
  let sol = db.select().from(schema.solicitudes).where(and(eq(schema.solicitudes.localId, localRow.id), eq(schema.solicitudes.trabajo, trabajo))).get();
  if (!sol) {
    sol = db.insert(schema.solicitudes).values({
      localId: localRow.id, estado: 'PENDIENTE', trabajo, fechaVencimiento: vencimiento, nroOrden,
    }).returning().get();
  }
  for (const [i, p] of personas.entries()) {
    const completaEsta = completa || i < personas.length - 1; // la última queda incompleta a propósito
    if (!db.select().from(schema.solicitudPersonas).where(and(eq(schema.solicitudPersonas.solicitudId, sol.id), eq(schema.solicitudPersonas.personaId, p.id))).get()) {
      db.insert(schema.solicitudPersonas).values({ solicitudId: sol.id, personaId: p.id, estado: completaEsta ? 'AUTORIZADA' : 'EN_REVISION' }).run();
    }
    for (const t of porPersona) {
      if (!completaEsta) continue;
      if (!db.select().from(schema.documentos).where(and(eq(schema.documentos.personaId, p.id), eq(schema.documentos.tipoDocumentoId, t.id))).get()) {
        db.insert(schema.documentos).values({ personaId: p.id, tipoDocumentoId: t.id, verificacion: 'VERIFICADO' }).run();
      }
    }
    if (completaEsta && !db.select().from(schema.autorizaciones).where(and(eq(schema.autorizaciones.solicitudId, sol.id), eq(schema.autorizaciones.personaId, p.id))).get()) {
      db.insert(schema.autorizaciones).values({
        solicitudId: sol.id, personaId: p.id, localId: localRow.id,
        fecha: dia(-2), fechaHasta: vencimiento, horaDesde: '00:00', horaHasta: '23:59',
        estado: 'AUTORIZADA', comentario: 'Autorización automática (documentación completa).', autorizadaPorUserId: admin.id,
      }).run();
    }
  }
  for (const t of porSolicitud) {
    if (!db.select().from(schema.solicitudDocumentos).where(and(eq(schema.solicitudDocumentos.solicitudId, sol.id), eq(schema.solicitudDocumentos.tipoDocumentoId, t.id))).get()) {
      db.insert(schema.solicitudDocumentos).values({ solicitudId: sol.id, tipoDocumentoId: t.id, verificacion: 'VERIFICADO' }).run();
    }
  }
  return sol;
}

const s1 = armarSolicitud({ localRow: indumentaria, personas: gente.slice(0, 3), trabajo: 'Montaje de vidriera', vencimiento: dia(12), completa: false, nroOrden: 'OA-2026-0148' });
armarSolicitud({ localRow: cafe, personas: [gente[3]], trabajo: 'Service de cafetera', vencimiento: dia(5), completa: true, nroOrden: 'OA-2026-0149' });

// --- ingresos: alguien adentro ahora y movimientos del día, para el reporte por hora
const entrada = (p: Persona, l: Local, desde: string, hasta: string | null) => {
  if (db.select().from(schema.entradas).where(and(eq(schema.entradas.personaId, p.id), eq(schema.entradas.localId, l.id))).get()) return;
  db.insert(schema.entradas).values({
    personaId: p.id, localId: l.id, fechaHoraIngreso: desde, fechaHoraSalida: hasta ?? null, ingresoPorUserId: admin.id,
  }).run();
};
entrada(gente[0], indumentaria, hora(7, 40), null);
entrada(gente[1], indumentaria, hora(8, 5), hora(13, 20));
entrada(gente[3], cafe, hora(9, 15), null);

console.log('listo. usuario demo@ejemplo.com / demo1234');
console.log('local:', indumentaria.nombre, '| solicitud', s1.nroOrden);
console.log('personas:', gente.map((p) => `${p.apellido} ${p.nombre} (${p.cuil})`).join(' · '));
console.log('tecno:', tecno.nombre);
