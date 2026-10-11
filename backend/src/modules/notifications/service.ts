import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { sendMail } from '../email/mailer.js';
import { formatCuil } from '../personas/service.js';
import { getPersonaDocStatus, getSolicitudDocStatus } from '../documentos/service.js';
import { audit } from '../../lib/audit.js';
import { todayLocal } from '../../lib/datetime.js';

/** Extrae la dirección de un "Nombre <addr@dom>" o devuelve el texto si ya es una dirección. */
function extraerEmail(remitente: string | null | undefined): string {
  if (!remitente) return '';
  const m = remitente.match(/<([^>]+)>/);
  return (m ? m[1] : remitente).trim();
}

function fmtFechaCorta(f: string | null | undefined): string {
  if (!f) return '—';
  const [y, m, d] = f.split('-');
  return d && m && y ? `${d}/${m}/${y}` : f;
}

/** Destinatario de una solicitud/persona: el email del local (si existe). */
function destinatario(solicitudId: number, personaId: number): { to: string; persona: any; local: any; sol: any; inReplyTo: string | null } | null {
  const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get();
  if (!sol) return null;
  const persona = db.select().from(schema.personas).where(eq(schema.personas.id, personaId)).get();
  const local = db.select().from(schema.locales).where(eq(schema.locales.id, sol.localId)).get();
  const origen = sol.emailMessageId ? db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, sol.emailMessageId)).get() : null;
  return { to: local?.email ?? '', persona, local, sol, inReplyTo: origen?.messageId ?? null };
}

export async function notifyObservacion(solicitudId: number, personaId: number, comentario: string): Promise<void> {
  const d = destinatario(solicitudId, personaId);
  if (!d || !d.persona) return;
  const texto = `La documentación de la siguiente persona fue OBSERVADA:

Persona: ${d.persona.apellido}, ${d.persona.nombre}
CUIL: ${formatCuil(d.persona.cuil ?? '')}
Local: ${d.local?.nombre ?? '-'}

Observación:
${comentario || '(sin detalle)'}

Por favor revisar y reenviar la documentación corregida.`;
  const { enviado } = await sendMail({ to: d.to, subject: `Documentación observada — ${d.persona.nombre} ${d.persona.apellido}`, text: texto, inReplyTo: d.inReplyTo, meta: { tipo: 'OBSERVACION', solicitudId, emailMessageId: d.sol.emailMessageId } });
  if (enviado) audit({ accion: 'EMAIL_ENVIADO', entidad: 'solicitud', entidadId: solicitudId, detalle: { tipo: 'OBSERVACION', personaId } });
}

export async function notifyRechazo(solicitudId: number, personaId: number, motivo: string): Promise<void> {
  const d = destinatario(solicitudId, personaId);
  if (!d || !d.persona) return;
  const texto = `El ingreso de la siguiente persona fue RECHAZADO:

Persona: ${d.persona.apellido}, ${d.persona.nombre}
CUIL: ${formatCuil(d.persona.cuil ?? '')}
Local: ${d.local?.nombre ?? '-'}

Motivo del rechazo:
${motivo}`;
  const { enviado } = await sendMail({ to: d.to, subject: `Ingreso rechazado — ${d.persona.nombre} ${d.persona.apellido}`, text: texto, inReplyTo: d.inReplyTo, meta: { tipo: 'RECHAZO', solicitudId, emailMessageId: d.sol.emailMessageId } });
  if (enviado) audit({ accion: 'EMAIL_ENVIADO', entidad: 'solicitud', entidadId: solicitudId, detalle: { tipo: 'RECHAZO', personaId } });
}

export async function notifyAutorizacion(autorizacionId: number): Promise<void> {
  const aut = db.select().from(schema.autorizaciones).where(eq(schema.autorizaciones.id, autorizacionId)).get();
  if (!aut) return;
  const persona = db.select().from(schema.personas).where(eq(schema.personas.id, aut.personaId)).get();
  const local = db.select().from(schema.locales).where(eq(schema.locales.id, aut.localId)).get();
  if (!persona) return;
  const rango = aut.fechaHasta && aut.fechaHasta !== aut.fecha ? `${aut.fecha} a ${aut.fechaHasta}` : aut.fecha;
  const texto = `El ingreso de la siguiente persona fue AUTORIZADO:

Persona: ${persona.apellido}, ${persona.nombre}
CUIL: ${formatCuil(persona.cuil ?? '')}
Local: ${local?.nombre ?? '-'}
Fecha: ${rango}
Horario: ${aut.horaDesde} a ${aut.horaHasta}
Estado: AUTORIZADO
${aut.comentario ? `\nComentario: ${aut.comentario}` : ''}`;
  const { enviado } = await sendMail({ to: local?.email ?? '', subject: `Ingreso autorizado — ${persona.nombre} ${persona.apellido}`, text: texto, meta: { tipo: 'AUTORIZACION', solicitudId: aut.solicitudId } });
  if (enviado) audit({ accion: 'EMAIL_ENVIADO', entidad: 'autorizacion', entidadId: autorizacionId, detalle: { tipo: 'AUTORIZACION' } });
}

/**
 * Email de cierre de revisión al REMITENTE del correo original: resume, por persona, si quedó
 * autorizada (con la fecha hasta la que puede ingresar) o no (con la documentación faltante).
 * Lleva el número de orden del grupo (lo genera la ruta antes de llamar acá).
 */
export async function notifyResultadoRevision(solicitudId: number): Promise<{ enviado: boolean; to: string; nroOrden: string | null }> {
  const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get();
  if (!sol) return { enviado: false, to: '', nroOrden: null };

  // Grupo del email (todas las solicitudes del mismo correo).
  const hermanas = sol.emailMessageId != null
    ? db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, sol.emailMessageId)).all()
    : [sol];
  const solIds = hermanas.map((s) => s.id);

  const email = sol.emailMessageId ? db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, sol.emailMessageId)).get() : null;
  const to = extraerEmail(email?.remitente);
  const nroOrden = hermanas.find((s) => s.nroOrden)?.nroOrden ?? null;
  if (!to) return { enviado: false, to: '', nroOrden };

  const localesGrupo = db.select().from(schema.locales).where(inArray(schema.locales.id, [...new Set(hermanas.map((s) => s.localId))])).all();
  const local = localesGrupo.find((l) => l.nombre !== '(Sin asignar)') ?? localesGrupo[0];
  const venc = hermanas.map((s) => s.fechaVencimiento).find(Boolean) ?? null;

  const sps = db
    .select({
      personaId: schema.personas.id, cuil: schema.personas.cuil, nombre: schema.personas.nombre,
      apellido: schema.personas.apellido, estado: schema.solicitudPersonas.estado, motivoRechazo: schema.solicitudPersonas.motivoRechazo,
    })
    .from(schema.solicitudPersonas)
    .innerJoin(schema.personas, eq(schema.solicitudPersonas.personaId, schema.personas.id))
    .where(inArray(schema.solicitudPersonas.solicitudId, solIds))
    .orderBy(schema.personas.apellido)
    .all();

  // Documentación GENERAL (una para todo el local) que falta: se lista UNA vez, no por persona.
  const generalFaltante = getSolicitudDocStatus(solicitudId).faltantes;

  let hayPendientes = false;
  const lineas = sps.map((p) => {
    const nom = `${p.apellido}, ${p.nombre} (CUIL ${formatCuil(p.cuil ?? '')})`;
    if (p.estado === 'AUTORIZADA') return `✓ ${nom}\n   AUTORIZADO — ${venc ? `puede ingresar hasta el ${fmtFechaCorta(venc)}` : 'puede ingresar (sin fecha de vencimiento definida)'}.`;
    // El motivo lo escribe una persona y suele venir con punto final: no duplicarlo.
    const motivo = p.motivoRechazo?.trim().replace(/\.+$/, '');
    if (p.estado === 'RECHAZADA') return `✗ ${nom}\n   RECHAZADO${motivo ? ` — ${motivo}` : ''}.`;
    hayPendientes = true;
    // Solo la documentación INDIVIDUAL de la persona (la general va aparte, para no repetirla).
    const personales = getPersonaDocStatus(p.personaId).faltantes;
    const falta = personales.length
      ? personales.join(', ')
      : (generalFaltante.length ? 'documentación general del local (ver arriba)' : 'documentación por revisar');
    return `• ${nom}\n   PENDIENTE — falta: ${falta}.`;
  });

  const bloqueGeneral = generalFaltante.length
    ? `\nDocumentación general del local pendiente (una sola para toda la solicitud): ${generalFaltante.join(', ')}.\n`
    : '';
  const notaPendientes = hayPendientes
    ? '\n\nPor las personas que figuran como PENDIENTE, enviar la documentación faltante para completar la autorización.'
    : '';

  // El cierre explica cómo enganchar un correo a ESTA solicitud (número de orden en el asunto),
  // y eso sirve igual con todo aprobado: sumar a alguien, renovar un documento que se vence,
  // pedir más días. Lo que no corresponde cuando no falta nada es hablar de "documentación
  // faltante", así que el texto cambia según cómo quedó la revisión.
  const todoAutorizado = sps.length > 0 && sps.every((p) => p.estado === 'AUTORIZADA');
  // La contracara importa tanto como la instrucción: si un PEDIDO NUEVO se escribe respondiendo
  // este correo, el sistema lo lee como documentación de esta solicitud y las personas del
  // pedido nuevo terminan colgadas de acá. Pasó de verdad: un local usaba una sola conversación
  // de Outlook para todos sus pedidos, y el de "instalación de wifi" se sumó al de dos meses antes.
  const pedidoNuevoAparte = `\n\nSi lo que necesita es un TRABAJO NUEVO (otro personal, otra fecha), no responda este correo: escriba uno NUEVO, con su propio asunto, sin el número de orden ${nroOrden}. Un pedido nuevo respondido acá se toma como documentación de esta solicitud.`;
  const comoSeguir = !nroOrden
    ? ''
    : todoAutorizado
      ? `\n\nSi más adelante necesita agregar personal a ESTA autorización, renovar documentación o hacer una consulta sobre ella, RESPONDA a este correo o escriba uno nuevo poniendo el número de orden ${nroOrden} EN EL ASUNTO. Así queda vinculado a esta solicitud.${pedidoNuevoAparte}`
      : `\n\nIMPORTANTE: para enviar documentación faltante de ESTA solicitud o hacer cualquier consulta sobre ella, RESPONDA a este correo o escriba uno nuevo poniendo el número de orden ${nroOrden} EN EL ASUNTO. Así la documentación se agrega automáticamente a esta solicitud.${pedidoNuevoAparte}`;

  const texto = `Resultado de la revisión de la documentación enviada.

${nroOrden ? `Número de orden: ${nroOrden}\n` : ''}Local: ${local?.nombre ?? '-'}
Fecha: ${fmtFechaCorta(todayLocal())}
${bloqueGeneral}
${lineas.join('\n\n')}${notaPendientes}${comoSeguir}`;

  const asuntoLocal = local?.nombre ?? 'Ingreso de personal';
  const subject = nroOrden ? `Orden ${nroOrden} — Resultado de la revisión — ${asuntoLocal}` : `Resultado de la revisión — ${asuntoLocal}`;
  const { enviado } = await sendMail({ to, subject, text: texto, inReplyTo: email?.messageId ?? null, meta: { tipo: 'RESULTADO_REVISION', solicitudId, emailMessageId: sol.emailMessageId } });
  if (enviado) audit({ accion: 'EMAIL_ENVIADO', entidad: 'solicitud', entidadId: solicitudId, detalle: { tipo: 'RESULTADO_REVISION', to, nroOrden } });
  return { enviado, to, nroOrden };
}
