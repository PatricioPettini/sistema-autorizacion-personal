import { describe, it, expect, beforeAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { migrate } from '../db/migrate.js';
import { db, schema } from '../db/client.js';
import { findOrCreatePersona } from '../modules/personas/service.js';
import { saveDocumentVersion } from '../modules/storage/service.js';
import { getPersonaDocStatus, getSolicitudDocStatus, personaAutorizableEnSolicitud } from '../modules/documentos/service.js';
import { getVigencia, recomputeAutorizacionPersona } from '../modules/autorizaciones/service.js';
import { recomputeSolicitudEstado, asignarNroOrden, getNroOrden } from '../modules/solicitudes/service.js';
import { todayLocal } from '../lib/datetime.js';

function tipoId(codigo: string): number {
  return db.select().from(schema.documentTypes).where(eq(schema.documentTypes.codigo, codigo)).get()!.id;
}

function verificar(personaId: number, codigo: string, fechaVencimiento?: string) {
  // saveDocumentVersion crea el documento; si no existe (aún no se cargó archivo), lo creamos.
  const existing = db.select().from(schema.documentos).where(and(eq(schema.documentos.personaId, personaId), eq(schema.documentos.tipoDocumentoId, tipoId(codigo)))).get();
  if (!existing) db.insert(schema.documentos).values({ personaId, tipoDocumentoId: tipoId(codigo) }).run();
  db.update(schema.documentos)
    .set({ verificacion: 'VERIFICADO', fechaVencimiento: fechaVencimiento ?? null })
    .where(and(eq(schema.documentos.personaId, personaId), eq(schema.documentos.tipoDocumentoId, tipoId(codigo))))
    .run();
}

/** Aprueba un documento de alcance SOLICITUD (uno para todo el grupo). */
function verificarSol(solicitudId: number, codigo: string) {
  const t = tipoId(codigo);
  const existing = db.select().from(schema.solicitudDocumentos).where(and(eq(schema.solicitudDocumentos.solicitudId, solicitudId), eq(schema.solicitudDocumentos.tipoDocumentoId, t))).get();
  if (!existing) db.insert(schema.solicitudDocumentos).values({ solicitudId, tipoDocumentoId: t, verificacion: 'VERIFICADO' }).run();
  else db.update(schema.solicitudDocumentos).set({ verificacion: 'VERIFICADO' }).where(eq(schema.solicitudDocumentos.id, existing.id)).run();
}

function setCategoria(personaId: number, categoria: string) {
  db.update(schema.personas).set({ categoria }).where(eq(schema.personas.id, personaId)).run();
}

// Nuevo modelo de alcance: 931/ARCA/Cláusula son por SOLICITUD; ART es por PERSONA.
const DOCS_EMPRESA_PERSONA = ['NOMINA_ART'];
const DOCS_EMPRESA_SOL = ['FORM_931', 'PAGO_ARCA', 'CLAUSULA_NO_REPETICION'];

beforeAll(() => {
  migrate();
});

describe('personas', () => {
  it('no duplica por CUIL', () => {
    const a = findOrCreatePersona({ cuil: '20-32361606-7', nombre: 'Juan', apellido: 'Perez' });
    const b = findOrCreatePersona({ cuil: '20323616067', nombre: 'Juan', apellido: 'Perez' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.persona.id).toBe(b.persona.id);
  });
});

describe('documentos y verificación manual', () => {
  it('crea versiones y deduplica archivos idénticos', () => {
    const { persona } = findOrCreatePersona({ cuil: '20112235456', nombre: 'Ana', apellido: 'Lopez' });
    const t = tipoId('FORM_931');
    const r1 = saveDocumentVersion({ personaId: persona.id, tipoDocumentoId: t, buffer: Buffer.from('AAA'), originalFilename: 'f931.pdf' });
    expect(r1.version).toBe(1);
    const r2 = saveDocumentVersion({ personaId: persona.id, tipoDocumentoId: t, buffer: Buffer.from('AAA'), originalFilename: 'f931.pdf' });
    expect(r2.duplicate).toBe(true);
    const r3 = saveDocumentVersion({ personaId: persona.id, tipoDocumentoId: t, buffer: Buffer.from('BBB'), originalFilename: 'f931_nuevo.pdf' });
    expect(r3.version).toBe(2);
  });

  /**
   * Una persona sin tipo de contratista definido no tiene requisitos que comparar, así que
   * `faltantes` queda vacío. Eso NO es "todo aprobado": la ficha mostraba "Incompleto" junto con
   * "Toda la documentación obligatoria está aprobada" porque el texto se decidía solo por
   * `faltantes.length`. Estas tres cosas juntas son lo que la pantalla tiene que saber distinguir.
   */
  it('sin tipo definido no hay requisitos, y eso no equivale a tenerlos aprobados', () => {
    const { persona } = findOrCreatePersona({ cuil: '20-41174117-6', nombre: 'Nicolas', apellido: 'Acosta' });
    const st = getPersonaDocStatus(persona.id);
    expect(st.requiereCategoria).toBe(true);
    expect(st.totalObligatorios).toBe(0);
    expect(st.faltantes).toEqual([]);
    expect(st.estadoDocumental).toBe('INCOMPLETO');
    expect(st.todosVerificados).toBe(false);
  });

  it('por-persona (Empresa) exige solo Nómina ART; 931/ARCA/Cláusula son por solicitud', () => {
    const { persona } = findOrCreatePersona({ cuil: '20999560305', nombre: 'Luis', apellido: 'Diaz' });
    // Sin categoría: pide definir el tipo.
    expect(getPersonaDocStatus(persona.id).requiereCategoria).toBe(true);
    setCategoria(persona.id, 'EMPRESA');
    const status = getPersonaDocStatus(persona.id);
    expect(status.totalObligatorios).toBe(1); // solo Nómina ART es por-persona
    expect(status.estadoDocumental).toBe('INCOMPLETO');
    expect(status.faltantes).toEqual(['Nómina ART']);
    // Los de alcance solicitud NO aparecen en el checklist por-persona.
    expect(status.items.some((i) => i.codigo === 'FORM_931')).toBe(false);
  });

  it('un documento cuenta como presente SOLO cuando se aprueba manualmente', () => {
    const { persona } = findOrCreatePersona({ cuil: '20440933755', nombre: 'Rosa', apellido: 'Mota' });
    setCategoria(persona.id, 'EMPRESA');
    saveDocumentVersion({ personaId: persona.id, tipoDocumentoId: tipoId('NOMINA_ART'), buffer: Buffer.from('x'), originalFilename: 'art.pdf' });
    let doc = getPersonaDocStatus(persona.id).items.find((i) => i.codigo === 'NOMINA_ART')!;
    expect(doc.presente).toBe(false);
    verificar(persona.id, 'NOMINA_ART');
    doc = getPersonaDocStatus(persona.id).items.find((i) => i.codigo === 'NOMINA_ART')!;
    expect(doc.presente).toBe(true);
  });

  it('todosVerificados (por-persona) cuando se aprueban los obligatorios por-persona', () => {
    const { persona } = findOrCreatePersona({ cuil: '20777273820', nombre: 'Nora', apellido: 'Fuentes' });
    setCategoria(persona.id, 'EMPRESA');
    expect(getPersonaDocStatus(persona.id).todosVerificados).toBe(false);
    verificar(persona.id, 'NOMINA_ART');
    expect(getPersonaDocStatus(persona.id).todosVerificados).toBe(true);
  });

  it('la autorización exige TAMBIÉN los documentos de la solicitud (931/ARCA/Cláusula)', () => {
    const { persona } = findOrCreatePersona({ cuil: '20332255741', nombre: 'Iván', apellido: 'Sosa' });
    setCategoria(persona.id, 'EMPRESA');
    const local = db.insert(schema.locales).values({ nombre: `Local Sol ${Date.now()}`, estado: 'ACTIVO' }).returning().get();
    const sol = db.insert(schema.solicitudes).values({ localId: local.id, estado: 'PENDIENTE' }).returning().get();
    db.insert(schema.solicitudPersonas).values({ solicitudId: sol.id, personaId: persona.id }).run();

    verificar(persona.id, 'NOMINA_ART'); // parte por-persona lista
    expect(personaAutorizableEnSolicitud(sol.id, persona.id).ok).toBe(false); // faltan los de solicitud
    for (const c of DOCS_EMPRESA_SOL) verificarSol(sol.id, c);
    expect(getSolicitudDocStatus(sol.id).faltantes.length).toBe(0);
    expect(personaAutorizableEnSolicitud(sol.id, persona.id).ok).toBe(true);
  });

  it('auto-autoriza solo con documentación completa (persona + solicitud) Y fecha de vencimiento', () => {
    const user = db.insert(schema.users).values({ nombre: 'Rev', email: `rev${Date.now()}@x.com`, passwordHash: 'x', rol: 'ADMIN' }).returning().get();
    const { persona } = findOrCreatePersona({ cuil: '20554908123', nombre: 'Sara', apellido: 'Vega' });
    setCategoria(persona.id, 'EMPRESA');
    const local = db.insert(schema.locales).values({ nombre: `Local Auto ${Date.now()}`, estado: 'ACTIVO' }).returning().get();
    const sol = db.insert(schema.solicitudes).values({ localId: local.id, personaId: persona.id, estado: 'PENDIENTE' }).returning().get();
    db.insert(schema.solicitudPersonas).values({ solicitudId: sol.id, personaId: persona.id }).run();
    const spEstado = () => db.select().from(schema.solicitudPersonas).where(and(eq(schema.solicitudPersonas.solicitudId, sol.id), eq(schema.solicitudPersonas.personaId, persona.id))).get()!.estado;

    // Todo aprobado (por-persona + por-solicitud) pero SIN fecha -> todavía NO autorizada.
    for (const c of DOCS_EMPRESA_PERSONA) verificar(persona.id, c);
    for (const c of DOCS_EMPRESA_SOL) verificarSol(sol.id, c);
    recomputeAutorizacionPersona(sol.id, persona.id, user.id);
    expect(personaAutorizableEnSolicitud(sol.id, persona.id).ok).toBe(true);
    expect(spEstado()).not.toBe('AUTORIZADA');

    // Cargar fecha de vencimiento -> se auto-autoriza hasta esa fecha.
    const futuro = new Date(new Date(`${todayLocal()}T12:00:00Z`).getTime() + 5 * 86400000).toISOString().slice(0, 10);
    db.update(schema.solicitudes).set({ fechaVencimiento: futuro }).where(eq(schema.solicitudes.id, sol.id)).run();
    recomputeAutorizacionPersona(sol.id, persona.id, user.id);
    expect(spEstado()).toBe('AUTORIZADA');
    expect(getVigencia(persona.id, local.id).estado).toBe('AUTORIZADO');
    const aut = db.select().from(schema.autorizaciones).where(and(eq(schema.autorizaciones.personaId, persona.id), eq(schema.autorizaciones.estado, 'AUTORIZADA'))).get()!;
    expect(aut.fechaHasta).toBe(futuro);
  });
});

describe('solicitud sin Excel de personas', () => {
  it('se puede crear una solicitud sin personas y cargarlas después', () => {
    const local = db.insert(schema.locales).values({ nombre: `Local Vacio ${Date.now()}`, estado: 'ACTIVO' }).returning().get();
    // Email sin Excel: la solicitud nace sin personaId y sin personas.
    const sol = db.insert(schema.solicitudes).values({ localId: local.id, estado: 'PENDIENTE' }).returning().get();
    expect(sol.personaId).toBeNull();
    expect(recomputeSolicitudEstado(sol.id)).toBe('PENDIENTE');

    // Carga manual posterior de dos personas.
    for (const p of [
      // CUIL válidos y de personas distintas: dos inventados que difieran solo en el dígito
      // verificador comparten los 8 dígitos del medio y son la misma persona para el sistema.
      { cuil: '20145967555', nombre: 'Ana', apellido: 'Lopez' },
      { cuil: '23145757142', nombre: 'Luis', apellido: 'Diaz' },
    ]) {
      const { persona } = findOrCreatePersona(p);
      db.insert(schema.solicitudPersonas).values({ solicitudId: sol.id, personaId: persona.id }).run();
    }
    const n = db.select().from(schema.solicitudPersonas).where(eq(schema.solicitudPersonas.solicitudId, sol.id)).all().length;
    expect(n).toBe(2);
    expect(recomputeSolicitudEstado(sol.id)).toBe('PENDIENTE');
  });
});

describe('número de orden', () => {
  const localDe = (n: string) => db.insert(schema.locales).values({ nombre: `${n} ${Date.now()}${Math.trunc(performance.now() * 1000) % 1000}`, estado: 'ACTIVO' }).returning().get();

  it('se genera con formato OA-AAAA-NNNN y es correlativo', () => {
    const a = asignarNroOrden(db.insert(schema.solicitudes).values({ localId: localDe('L').id, estado: 'PENDIENTE' }).returning().get().id)!;
    const b = asignarNroOrden(db.insert(schema.solicitudes).values({ localId: localDe('L').id, estado: 'PENDIENTE' }).returning().get().id)!;
    const anio = new Date().getFullYear();
    expect(a).toMatch(new RegExp(`^OA-${anio}-\\d{4}$`));
    expect(Number(b.split('-')[2])).toBe(Number(a.split('-')[2]) + 1);
  });

  it('es idempotente: reenviar el resultado no cambia el número', () => {
    const sol = db.insert(schema.solicitudes).values({ localId: localDe('L').id, estado: 'PENDIENTE' }).returning().get();
    const primero = asignarNroOrden(sol.id);
    expect(asignarNroOrden(sol.id)).toBe(primero);
    expect(getNroOrden(sol.id)).toBe(primero);
  });

  it('todas las solicitudes del mismo email comparten el número', () => {
    const local = localDe('L');
    const email = db.insert(schema.emailMessages).values({ messageId: `<orden-${Date.now()}>`, estado: 'PROCESSED' }).returning().get();
    const s1 = db.insert(schema.solicitudes).values({ localId: local.id, emailMessageId: email.id, estado: 'PENDIENTE' }).returning().get();
    const s2 = db.insert(schema.solicitudes).values({ localId: local.id, emailMessageId: email.id, estado: 'PENDIENTE' }).returning().get();
    const nro = asignarNroOrden(s1.id);
    expect(getNroOrden(s2.id)).toBe(nro);
    // Pedirlo desde la hermana tampoco genera uno nuevo.
    expect(asignarNroOrden(s2.id)).toBe(nro);
  });

  it('no lo tiene hasta que se termina la revisión', () => {
    const sol = db.insert(schema.solicitudes).values({ localId: localDe('L').id, estado: 'PENDIENTE' }).returning().get();
    expect(sol.nroOrden).toBeNull();
    expect(getNroOrden(sol.id)).toBeNull();
  });
});

describe('autorización y vigencia', () => {
  it('marca AUTORIZADO cuando hay autorización vigente hoy', () => {
    const { persona } = findOrCreatePersona({ cuil: '20186702129', nombre: 'Sofia', apellido: 'Ruiz' });
    const local = db.insert(schema.locales).values({ nombre: 'Local Test ' + Date.now(), estado: 'ACTIVO' }).returning().get();
    const user = db.insert(schema.users).values({ nombre: 'T', email: `t${Date.now()}@x.com`, passwordHash: 'x', rol: 'ADMIN' }).returning().get();
    expect(getVigencia(persona.id, local.id).estado).toBe('NO_AUTORIZADO');
    db.insert(schema.autorizaciones).values({ personaId: persona.id, localId: local.id, fecha: todayLocal(), horaDesde: '08:00', horaHasta: '18:00', estado: 'AUTORIZADA', autorizadaPorUserId: user.id }).run();
    expect(getVigencia(persona.id, local.id).estado).toBe('AUTORIZADO');
  });

  it('respeta el rango de fechas: vigente si hoy cae dentro de [fecha, fechaHasta]', () => {
    const { persona } = findOrCreatePersona({ cuil: '20188812118', nombre: 'Nadia', apellido: 'Vera' });
    const local = db.insert(schema.locales).values({ nombre: 'Local Rango ' + Date.now(), estado: 'ACTIVO' }).returning().get();
    const user = db.insert(schema.users).values({ nombre: 'T', email: `r${Date.now()}@x.com`, passwordHash: 'x', rol: 'ADMIN' }).returning().get();
    const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const manana = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    db.insert(schema.autorizaciones).values({ personaId: persona.id, localId: local.id, fecha: ayer, fechaHasta: manana, horaDesde: '08:00', horaHasta: '18:00', estado: 'AUTORIZADA', autorizadaPorUserId: user.id }).run();
    expect(getVigencia(persona.id, local.id).estado).toBe('AUTORIZADO');
  });

  it('mandar una solicitud a la papelera NO cambia la autorización de la persona', () => {
    const { persona } = findOrCreatePersona({ cuil: '20188940877', nombre: 'Papel', apellido: 'Era' });
    const local = db.insert(schema.locales).values({ nombre: 'Local Papelera ' + Date.now(), estado: 'ACTIVO' }).returning().get();
    const user = db.insert(schema.users).values({ nombre: 'T', email: `pp${Date.now()}@x.com`, passwordHash: 'x', rol: 'ADMIN' }).returning().get();
    const sol = db.insert(schema.solicitudes).values({ localId: local.id, estado: 'AUTORIZADA' }).returning().get();
    db.insert(schema.autorizaciones).values({ solicitudId: sol.id, personaId: persona.id, localId: local.id, fecha: todayLocal(), fechaHasta: todayLocal(), horaDesde: '00:00', horaHasta: '23:59', estado: 'AUTORIZADA', autorizadaPorUserId: user.id }).run();
    expect(getVigencia(persona.id, local.id).estado).toBe('AUTORIZADO');
    // La papelera solo saca la solicitud del listado: la autorización se mantiene.
    db.update(schema.solicitudes).set({ deletedAt: new Date().toISOString() }).where(eq(schema.solicitudes.id, sol.id)).run();
    expect(getVigencia(persona.id, local.id).estado).toBe('AUTORIZADO');
  });

  it('marca VENCIDO cuando el rango completo ya pasó', () => {
    const { persona } = findOrCreatePersona({ cuil: '20187146547', nombre: 'Omar', apellido: 'Paz' });
    const local = db.insert(schema.locales).values({ nombre: 'Local Pasado ' + Date.now(), estado: 'ACTIVO' }).returning().get();
    const user = db.insert(schema.users).values({ nombre: 'T', email: `p${Date.now()}@x.com`, passwordHash: 'x', rol: 'ADMIN' }).returning().get();
    const hace10 = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const hace5 = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    db.insert(schema.autorizaciones).values({ personaId: persona.id, localId: local.id, fecha: hace10, fechaHasta: hace5, horaDesde: '08:00', horaHasta: '18:00', estado: 'AUTORIZADA', autorizadaPorUserId: user.id }).run();
    expect(getVigencia(persona.id, local.id).estado).toBe('VENCIDO');
  });
});
