import { describe, it, expect, beforeAll } from 'vitest';
import { eq, desc } from 'drizzle-orm';
import { migrate } from '../db/migrate.js';
import { db, schema } from '../db/client.js';
import { findOrCreatePersona } from '../modules/personas/service.js';
import { notifyResultadoRevision } from '../modules/notifications/service.js';

beforeAll(() => { migrate(); });

let n = 0;
/** Solicitud con número de orden, remitente y las personas en el estado que se pida. */
function armarSolicitud(estados: string[]) {
  n++;
  const local = db.insert(schema.locales).values({ nombre: `Local resultado ${n}`, estado: 'ACTIVO' }).returning().get();
  const email = db.insert(schema.emailMessages).values({
    messageId: `<resultado-${n}-${Date.now()}@test>`, estado: 'PROCESSED',
    remitente: 'Encargado <encargado@local.com>', asunto: 'Solicitud FAO empresa',
  }).returning().get();
  const sol = db.insert(schema.solicitudes).values({
    localId: local.id, emailMessageId: email.id, estado: 'PENDIENTE',
    nroOrden: `OA-2026-9${String(n).padStart(3, '0')}`, fechaVencimiento: '2026-12-31',
  }).returning().get();
  estados.forEach((estado, i) => {
    const { persona } = findOrCreatePersona({ cuil: `20-9${n}${String(i).padStart(6, '0')}-1`, nombre: `Nombre${i}`, apellido: `Apellido${i}` });
    db.insert(schema.solicitudPersonas).values({ solicitudId: sol.id, personaId: persona.id, estado }).run();
  });
  return sol;
}

const ultimoCuerpo = () =>
  db.select().from(schema.sentEmails).orderBy(desc(schema.sentEmails.id)).limit(1).get()?.cuerpo ?? '';

describe('email de resultado de la revisión', () => {
  it('con todo autorizado NO habla de documentación faltante, pero sí deja el número de orden', async () => {
    const sol = armarSolicitud(['AUTORIZADA', 'AUTORIZADA']);
    await notifyResultadoRevision(sol.id);
    const cuerpo = ultimoCuerpo();

    expect(cuerpo).not.toMatch(/documentación faltante/i);
    expect(cuerpo).not.toMatch(/IMPORTANTE/);
    // El mecanismo para enganchar correos a esta solicitud tiene que seguir explicado.
    expect(cuerpo).toContain(sol.nroOrden!);
    expect(cuerpo).toMatch(/EN EL ASUNTO/);
    expect(cuerpo).toMatch(/agregar personal/i);
  });

  it('con alguien pendiente sí pide la documentación faltante', async () => {
    const sol = armarSolicitud(['AUTORIZADA', 'PENDIENTE']);
    await notifyResultadoRevision(sol.id);
    const cuerpo = ultimoCuerpo();

    expect(cuerpo).toMatch(/IMPORTANTE/);
    expect(cuerpo).toMatch(/documentación faltante/i);
    expect(cuerpo).toContain(sol.nroOrden!);
  });

  it('con alguien rechazado también, porque la solicitud no quedó cerrada', async () => {
    const sol = armarSolicitud(['AUTORIZADA', 'RECHAZADA']);
    await notifyResultadoRevision(sol.id);
    expect(ultimoCuerpo()).toMatch(/documentación faltante/i);
  });
});

/**
 * La instrucción de "respondé citando el número de orden" tiene una contracara que faltaba: si el
 * local escribe un PEDIDO NUEVO respondiendo este correo, el sistema lo lee como documentación de
 * esta solicitud. Es lo que pasó con ZENIT, que usaba una sola conversación de Outlook para todos
 * sus pedidos. Decirlo en el aviso es la única parte que se arregla del lado del remitente.
 */
describe('el aviso explica qué hacer con un pedido NUEVO', () => {
  it('pide que un trabajo nuevo vaya en un correo aparte, con todo autorizado', async () => {
    const sol = armarSolicitud(['AUTORIZADA']);
    await notifyResultadoRevision(sol.id);
    const cuerpo = ultimoCuerpo();
    expect(cuerpo).toMatch(/TRABAJO NUEVO/);
    expect(cuerpo).toMatch(/no responda este correo/i);
    expect(cuerpo).toMatch(/escriba uno NUEVO/i);
  });

  it('y también cuando queda documentación pendiente', async () => {
    const sol = armarSolicitud(['AUTORIZADA', 'PENDIENTE']);
    await notifyResultadoRevision(sol.id);
    const cuerpo = ultimoCuerpo();
    expect(cuerpo).toMatch(/TRABAJO NUEVO/);
    // Sin confundirse con la instrucción de mandar lo que falta de ESTA solicitud.
    expect(cuerpo).toMatch(/documentación faltante de ESTA solicitud/);
  });
});
