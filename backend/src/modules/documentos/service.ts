import { eq, and } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';

export interface DocTypeStatus {
  tipoId: number;
  codigo: string;
  nombre: string;
  obligatorio: boolean;
  categoria: string;
  controlaEmision: boolean;
  esRequisitoExtra: boolean; // agregado a mano a esta persona (no viene de su categoría)
  presente: boolean;
  tieneArchivo: boolean;
  documentoId: number | null;
  versionId: number | null;
  version: number | null;
  fechaEmision: string | null;
  fechaVencimiento: string | null;
  diasParaVencer: number | null; // días hasta llegar al límite (30 días desde emisión)
  vigencia: 'VIGENTE' | 'POR_VENCER' | 'VENCIDO' | 'SIN_FECHA' | null;
  verificacion: 'PENDIENTE' | 'VERIFICADO' | 'RECHAZADO';
  notaVerificacion: string | null;
  clasificacionConfianza: number | null;
}

export interface PersonaDocStatus {
  categoria: string | null; // EMPRESA | MONOTRIBUTISTA | null
  requiereCategoria: boolean; // true si falta definir si es empresa o monotributista
  items: DocTypeStatus[];
  faltantes: string[];
  vencidos: string[]; // documentación con emisión > 30 días
  porVencer: string[];
  estadoDocumental: 'COMPLETO' | 'INCOMPLETO';
  completos: number;
  totalObligatorios: number;
  verificadosObligatorios: number; // obligatorios marcados VERIFICADO por Seguridad (y no vencidos)
  todosVerificados: boolean; // true si TODOS los obligatorios están verificados y vigentes
}

export function getPersonaDocStatus(personaId: number): PersonaDocStatus {
  const persona = db.select().from(schema.personas).where(eq(schema.personas.id, personaId)).get();
  const categoria = persona?.categoria ?? null;

  const todos = db
    .select()
    .from(schema.documentTypes)
    .where(eq(schema.documentTypes.activo, true))
    .orderBy(schema.documentTypes.orden)
    .all();

  // Requisitos EXTRA asignados a mano a esta persona (ej. trabajo en altura).
  const extraIds = new Set(
    db
      .select({ tipoId: schema.requisitosPersona.tipoDocumentoId })
      .from(schema.requisitosPersona)
      .where(eq(schema.requisitosPersona.personaId, personaId))
      .all()
      .map((r) => r.tipoId),
  );
  const aplicaPorCategoria = (t: (typeof todos)[number]) => t.categoria === 'AMBOS' || t.categoria === categoria;

  // Aplican: los de la categoría (más 'AMBOS') y los requisitos extra de esta persona.
  // Se excluyen los de alcance SOLICITUD: esos se cargan/aprueban una vez para todo el grupo
  // (ver getSolicitudDocStatus), no por persona.
  const tipos = todos.filter((t) => (t.alcance !== 'SOLICITUD') && (aplicaPorCategoria(t) || extraIds.has(t.id)));
  // Un requisito extra puede referenciar un tipo desactivado o fuera de 'todos': lo traemos.
  for (const id of extraIds) {
    if (!tipos.some((t) => t.id === id)) {
      const t = db.select().from(schema.documentTypes).where(eq(schema.documentTypes.id, id)).get();
      if (t) tipos.push(t);
    }
  }

  const items: DocTypeStatus[] = [];
  const faltantes: string[] = [];
  const vencidos: string[] = [];
  const porVencer: string[] = [];

  for (const tipo of tipos) {
    const doc = db
      .select()
      .from(schema.documentos)
      .where(and(eq(schema.documentos.personaId, personaId), eq(schema.documentos.tipoDocumentoId, tipo.id)))
      .get();

    let version = null as (typeof schema.documentVersions.$inferSelect) | null;
    if (doc?.currentVersionId) {
      version = db.select().from(schema.documentVersions).where(eq(schema.documentVersions.id, doc.currentVersionId)).get() ?? null;
    }

    const tieneArchivo = !!version;
    const verificacion = (doc?.verificacion ?? 'PENDIENTE') as DocTypeStatus['verificacion'];
    const verificado = verificacion === 'VERIFICADO';

    // El vencimiento ya NO es por documento: es único a nivel solicitud. Un requisito cuenta
    // como cumplido si Seguridad lo aprobó (VERIFICADO).
    const fechaVencimiento = null;
    const dias: number | null = null;
    const vigencia: DocTypeStatus['vigencia'] = verificado ? 'VIGENTE' : null;
    const presente = verificado;

    // Un requisito extra es obligatorio para esta persona aunque el tipo no lo sea por defecto.
    const esRequisitoExtra = extraIds.has(tipo.id) && !aplicaPorCategoria(tipo);
    const obligatorio = tipo.obligatorio || esRequisitoExtra;

    if (obligatorio && !presente) faltantes.push(tipo.nombre);

    items.push({
      tipoId: tipo.id,
      codigo: tipo.codigo,
      nombre: tipo.nombre,
      obligatorio,
      categoria: tipo.categoria,
      controlaEmision: tipo.controlaEmision,
      esRequisitoExtra,
      presente,
      tieneArchivo,
      documentoId: doc?.id ?? null,
      versionId: version?.id ?? null,
      version: version?.version ?? null,
      fechaEmision: version?.fechaEmision ?? null,
      fechaVencimiento,
      diasParaVencer: dias,
      vigencia,
      verificacion,
      notaVerificacion: doc?.notaVerificacion ?? null,
      clasificacionConfianza: version?.clasificacionConfianza ?? null,
    });
  }

  // Se cuenta sobre los items (incluye los requisitos extra de esta persona).
  const totalObligatorios = items.filter((i) => i.obligatorio).length;
  const completos = items.filter((i) => i.obligatorio && i.presente && i.vigencia !== 'VENCIDO').length;
  // Verificados: obligatorios que Seguridad confirmó explícitamente (VERIFICADO) y siguen vigentes.
  const verificadosObligatorios = items.filter(
    (i) => i.obligatorio && i.verificacion === 'VERIFICADO' && i.vigencia !== 'VENCIDO',
  ).length;
  // Solo hace falta definir categoría si existen requisitos específicos por tipo de contratista.
  const hayCategoriaEspecifica = todos.some((t) => t.obligatorio && t.categoria !== 'AMBOS' && t.categoria !== 'EXTRA');
  const requiereCategoria = !categoria && hayCategoriaEspecifica;
  const todosVerificados = !requiereCategoria && totalObligatorios > 0 && verificadosObligatorios === totalObligatorios;

  return {
    categoria,
    requiereCategoria,
    items,
    faltantes,
    vencidos,
    porVencer,
    estadoDocumental: !requiereCategoria && faltantes.length === 0 ? 'COMPLETO' : 'INCOMPLETO',
    completos,
    totalObligatorios,
    verificadosObligatorios,
    todosVerificados,
  };
}

// ---------------------------------------------------------------------------
// Documentos con alcance de SOLICITUD (uno para todo el grupo)
// ---------------------------------------------------------------------------

export interface SolicitudDocItem {
  tipoId: number;
  codigo: string;
  nombre: string;
  categoria: string;
  obligatorio: boolean;
  esExtra: boolean; // agregado a mano a esta solicitud (no es un requisito fijo del tipo de contratista)
  presente: boolean; // verificado
  tieneArchivo: boolean;
  soldocId: number | null;
  originalFilename: string | null;
  fechaEmision: string | null;
  verificacion: 'PENDIENTE' | 'VERIFICADO' | 'RECHAZADO';
  notaVerificacion: string | null;
  clasificacionConfianza: number | null;
}

export interface SolicitudDocStatus {
  items: SolicitudDocItem[];
  faltantes: string[];
  categoriasPresentes: string[]; // categorías de las personas de la solicitud
  requiereCategoria: boolean; // hay personas sin categoría definida
}

/** Categorías (EMPRESA/MONOTRIBUTISTA) presentes entre las personas de una solicitud. */
function categoriasDeSolicitud(solicitudId: number): { categorias: string[]; hayNull: boolean } {
  const rows = db
    .select({ categoria: schema.personas.categoria })
    .from(schema.solicitudPersonas)
    .innerJoin(schema.personas, eq(schema.personas.id, schema.solicitudPersonas.personaId))
    .where(eq(schema.solicitudPersonas.solicitudId, solicitudId))
    .all();
  const categorias = [...new Set(rows.map((r) => r.categoria).filter((c): c is string => !!c))];
  const hayNull = rows.some((r) => !r.categoria);
  return { categorias, hayNull };
}

/** Tipos de documento de alcance SOLICITUD que aplican a una categoría (o 'AMBOS'). */
function tiposSolicitudParaCategorias(categorias: string[]): (typeof schema.documentTypes.$inferSelect)[] {
  const todos = db
    .select()
    .from(schema.documentTypes)
    .where(and(eq(schema.documentTypes.activo, true), eq(schema.documentTypes.alcance, 'SOLICITUD')))
    .orderBy(schema.documentTypes.orden)
    .all();
  return todos.filter((t) => t.categoria === 'AMBOS' || categorias.includes(t.categoria));
}

/** Requisitos EXTRA agregados a mano a ESTA solicitud (aplican a todo el grupo, cualquier categoría). */
function tiposExtraDeSolicitud(solicitudId: number): (typeof schema.documentTypes.$inferSelect)[] {
  return db
    .select({ t: schema.documentTypes })
    .from(schema.requisitosSolicitud)
    .innerJoin(schema.documentTypes, eq(schema.documentTypes.id, schema.requisitosSolicitud.tipoDocumentoId))
    .where(eq(schema.requisitosSolicitud.solicitudId, solicitudId))
    .orderBy(schema.documentTypes.nombre)
    .all()
    .map((r) => r.t);
}

/** Tipos de documento que la solicitud debe (fijos por categoría + extras agregados a mano), sin repetir. */
function tiposDeSolicitud(solicitudId: number, categorias: string[]): { tipo: (typeof schema.documentTypes.$inferSelect); esExtra: boolean }[] {
  const fijos = tiposSolicitudParaCategorias(categorias);
  const extras = tiposExtraDeSolicitud(solicitudId);
  const vistos = new Set(fijos.map((t) => t.id));
  return [
    ...fijos.map((tipo) => ({ tipo, esExtra: false })),
    ...extras.filter((t) => !vistos.has(t.id)).map((tipo) => ({ tipo, esExtra: true })),
  ];
}

/** Estado de los documentos de alcance SOLICITUD de una solicitud (uno por tipo). */
export function getSolicitudDocStatus(solicitudId: number): SolicitudDocStatus {
  const { categorias, hayNull } = categoriasDeSolicitud(solicitudId);
  const tipos = tiposDeSolicitud(solicitudId, categorias);
  const items: SolicitudDocItem[] = [];
  const faltantes: string[] = [];

  for (const { tipo, esExtra } of tipos) {
    const doc = db
      .select()
      .from(schema.solicitudDocumentos)
      .where(and(eq(schema.solicitudDocumentos.solicitudId, solicitudId), eq(schema.solicitudDocumentos.tipoDocumentoId, tipo.id)))
      .get();
    const verificacion = (doc?.verificacion ?? 'PENDIENTE') as SolicitudDocItem['verificacion'];
    const presente = verificacion === 'VERIFICADO';
    if (tipo.obligatorio && !presente) faltantes.push(tipo.nombre);
    items.push({
      tipoId: tipo.id,
      codigo: tipo.codigo,
      nombre: tipo.nombre,
      categoria: tipo.categoria,
      obligatorio: tipo.obligatorio,
      esExtra,
      presente,
      tieneArchivo: !!doc?.storedPathNormalized || !!doc?.storedPathOriginal,
      soldocId: doc?.id ?? null,
      originalFilename: doc?.originalFilename ?? null,
      fechaEmision: doc?.fechaEmision ?? null,
      verificacion,
      notaVerificacion: doc?.notaVerificacion ?? null,
      clasificacionConfianza: doc?.clasificacionConfianza ?? null,
    });
  }

  return { items, faltantes, categoriasPresentes: categorias, requiereCategoria: hayNull && tipos.length > 0 };
}

/** Recuento de documentos de solicitud obligatorios que aplican a UNA categoría de persona.
 *  Incluye los requisitos EXTRA agregados a la solicitud (valen para todas las personas). */
export function solicitudDocsParaCategoria(solicitudId: number, categoria: string | null): { total: number; verificados: number; faltantes: string[] } {
  const fijos = tiposSolicitudParaCategorias(categoria ? [categoria] : []);
  const extras = tiposExtraDeSolicitud(solicitudId);
  const vistos = new Set(fijos.map((t) => t.id));
  const tipos = [...fijos, ...extras.filter((t) => !vistos.has(t.id))].filter((t) => t.obligatorio);
  let verificados = 0;
  const faltantes: string[] = [];
  for (const tipo of tipos) {
    const doc = db
      .select({ verificacion: schema.solicitudDocumentos.verificacion })
      .from(schema.solicitudDocumentos)
      .where(and(eq(schema.solicitudDocumentos.solicitudId, solicitudId), eq(schema.solicitudDocumentos.tipoDocumentoId, tipo.id)))
      .get();
    if (doc?.verificacion === 'VERIFICADO') verificados++;
    else faltantes.push(tipo.nombre);
  }
  return { total: tipos.length, verificados, faltantes };
}

/**
 * ¿Está la persona lista para autorizar dentro de una solicitud? Combina su documentación
 * por-persona (ART / Pago de Monotributo) con la de alcance SOLICITUD que le corresponde por
 * su categoría (Form 931, Pago ARCA, Cláusula / Seguro de Vida).
 */
export function personaAutorizableEnSolicitud(solicitudId: number, personaId: number): { ok: boolean; faltantes: string[] } {
  const persona = db.select().from(schema.personas).where(eq(schema.personas.id, personaId)).get();
  const p = getPersonaDocStatus(personaId);
  if (p.requiereCategoria) return { ok: false, faltantes: ['definir si es empresa o monotributista'] };
  const s = solicitudDocsParaCategoria(solicitudId, persona?.categoria ?? null);
  const total = p.totalObligatorios + s.total;
  const verificados = p.verificadosObligatorios + s.verificados;
  return { ok: total > 0 && verificados === total, faltantes: [...p.faltantes, ...s.faltantes] };
}

/**
 * ¿Quedó algún documento SIN decidir (ni aprobado ni marcado como falta) en la solicitud?
 * Considera la documentación de alcance SOLICITUD y la de cada persona (salvo las ya
 * rechazadas/reemplazadas). Se usa para no dejar terminar/enviar una revisión a medias.
 */
export function docsSinDecidir(solicitudId: number): boolean {
  const sol = getSolicitudDocStatus(solicitudId);
  if (sol.items.some((i) => i.verificacion === 'PENDIENTE')) return true;
  const sps = db
    .select({ personaId: schema.solicitudPersonas.personaId, estado: schema.solicitudPersonas.estado })
    .from(schema.solicitudPersonas)
    .where(eq(schema.solicitudPersonas.solicitudId, solicitudId))
    .all();
  for (const sp of sps) {
    if (sp.estado === 'RECHAZADA' || sp.estado === 'REEMPLAZADA') continue;
    if (getPersonaDocStatus(sp.personaId).items.some((i) => i.verificacion === 'PENDIENTE')) return true;
  }
  return false;
}
