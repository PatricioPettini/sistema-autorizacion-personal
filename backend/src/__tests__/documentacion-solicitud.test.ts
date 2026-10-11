import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { migrate } from '../db/migrate.js';
import { db, schema } from '../db/client.js';
import { env } from '../config/env.js';
import { buildServer } from '../server.js';
import { createSession } from '../lib/session.js';
import { processEmail } from '../modules/processing/processor.js';
import { asignarNroOrden } from '../modules/solicitudes/service.js';

let app: Awaited<ReturnType<typeof buildServer>>;
let cookie = '';

beforeAll(async () => {
  migrate();
  app = await buildServer();
  const u = db.insert(schema.users).values({
    nombre: 'AdminDoc', email: `admindoc${Date.now()}@t.com`, passwordHash: 'x', rol: 'ADMIN', activo: true,
  }).returning().get();
  cookie = `sap_session=${createSession(u.id)}`;
});

/** Un .eml con un PDF de contenido a elección (para poder cambiarle el tamaño). */
function eml(opts: { asunto: string; pdfNombre: string; pdf: string; csv?: string; cuerpo?: string; de?: string }) {
  const mid = `<doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test>`;
  const b = '----lim';
  const partes = [
    `Message-ID: ${mid}`, `From: ${opts.de ?? 'Local Doc <doc@test.com>'}`, `Subject: ${opts.asunto}`,
    'Date: Thu, 04 Sep 2026 10:00:00 -0300', 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: text/plain; charset=utf-8', '', opts.cuerpo ?? 'Adjunto documentacion.',
    `--${b}`, `Content-Type: application/pdf; name="${opts.pdfNombre}"`,
    `Content-Disposition: attachment; filename="${opts.pdfNombre}"`, 'Content-Transfer-Encoding: base64', '',
    Buffer.from(opts.pdf).toString('base64'),
  ];
  if (opts.csv) partes.push(
    `--${b}`, 'Content-Type: text/csv; name="nomina.csv"',
    'Content-Disposition: attachment; filename="nomina.csv"', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(opts.csv).toString('base64'),
  );
  partes.push(`--${b}--`, '');
  fs.mkdirSync(env.emailsPath, { recursive: true });
  const raw = path.join(env.emailsPath, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.eml`);
  fs.writeFileSync(raw, partes.join('\r\n'));
  return db.insert(schema.emailMessages).values({
    messageId: mid, remitente: opts.de ?? 'Local Doc <doc@test.com>', asunto: opts.asunto, estado: 'RECEIVED', rawStoredPath: raw,
  }).returning().get();
}

const documentacion = async (solicitudId: number) => {
  const res = await app.inject({ method: 'GET', url: `/api/emails/solicitud/${solicitudId}/documentacion`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return (res.json() as any).adjuntos as { filename: string; size: number; deReenvio: boolean }[];
};

/**
 * Lo que ve el que revisa. El local rechazado reenvía el archivo corregido CON EL MISMO NOMBRE
 * ("F931.pdf" otra vez): deduplicando solo por nombre, el archivo nuevo quedaba oculto detrás del
 * viejo y el que revisaba volvía a rechazar el mismo papel.
 */
describe('documentación de una solicitud', () => {
  it('junta los adjuntos del pedido y de las respuestas, y muestra el corregido aunque repita el nombre', async () => {
    const original = eml({
      asunto: 'SOLICITUD DE FAO (DEDUP SA) empresa', pdfNombre: 'F931.pdf', pdf: '%PDF viejo',
      csv: 'CUIL,Nombre completo\n20-31496468-0,Silva Carlos\n',
    });
    await processEmail(original.id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, original.id)).get()!;
    expect(sol).toBeTruthy();

    const orden = asignarNroOrden(sol.id); // como cuando se termina la revisión y se le informa al local
    expect(orden, 'necesito el número de orden para el correo de respuesta').toBeTruthy();

    // El local reenvía el F931 corregido: mismo nombre, contenido distinto.
    const corregido = eml({
      asunto: 'Documentacion corregida', pdfNombre: 'F931.pdf', pdf: '%PDF corregido, mas largo que el viejo',
      cuerpo: `Mando el 931 corregido de la orden ${orden}.`,
    });
    await processEmail(corregido.id);
    expect(db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, corregido.id)).get()!.replySolicitudId).toBe(sol.id);

    const docs = await documentacion(sol.id);
    const f931 = docs.filter((d) => d.filename === 'F931.pdf');
    expect(f931.length, 'tienen que verse las dos versiones, no solo la vieja').toBe(2);
    expect(f931.some((d) => d.deReenvio), 'la corregida se marca como de reenvío').toBe(true);
  });

  it('el mismo archivo reenviado tal cual no se duplica en la lista', async () => {
    const original = eml({
      asunto: 'SOLICITUD DE FAO (IGUAL SA) empresa', pdfNombre: 'ART.pdf', pdf: '%PDF identico',
      csv: 'CUIL,Nombre completo\n27-45351525-2,Espinoza Lourdes\n',
    });
    await processEmail(original.id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, original.id)).get()!;
    const orden = asignarNroOrden(sol.id);

    const reenvio = eml({
      asunto: 'RE: consulta', pdfNombre: 'ART.pdf', pdf: '%PDF identico',
      cuerpo: `Consulta sobre la orden ${orden}, reenvio el hilo.`,
    });
    await processEmail(reenvio.id);

    const docs = await documentacion(sol.id);
    expect(docs.filter((d) => d.filename === 'ART.pdf').length).toBe(1);
  });
});

/**
 * El botón "Solicitud nueva" del respaldo. La detección automática acierta casi siempre, pero
 * cuando se equivoca hacía falta poder imponerle el criterio propio desde la pantalla: sin esto,
 * "Procesar igual" respetaba su lectura y el correo se sumaba a la solicitud equivocada, o se
 * negaba a procesarse ("No se pudo procesar: documentación nueva para la solicitud X").
 */
describe('forzar una solicitud nueva desde el respaldo', () => {
  it('abre una solicitud aparte aunque el correo pertenezca a una existente', async () => {
    const original = eml({
      asunto: 'SOLICITUD DE FAO (FORZAR SA) empresa', pdfNombre: 'doc.pdf', pdf: '%PDF uno',
      csv: 'CUIL,Nombre completo\n20-31219253-1,Nuñez Pedro\n',
    });
    await processEmail(original.id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, original.id)).get()!;
    const orden = asignarNroOrden(sol.id);

    // Correo que cita el número de orden: la detección lo manda a esa solicitud.
    const segundo = eml({
      asunto: 'Otro trabajo', pdfNombre: 'doc2.pdf', pdf: '%PDF dos',
      cuerpo: `Mando esto por la orden ${orden}.`,
      csv: 'CUIL,Nombre completo\n27-38066308-8,Gomez Ana\n',
    });

    const res = await app.inject({
      method: 'POST', url: `/api/emails/${segundo.id}/procesar`, headers: { cookie },
      payload: { nuevaSolicitud: true },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as any).estado).toBe('PROCESSED');

    const propia = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, segundo.id)).get();
    expect(propia, 'tiene que abrir su propia solicitud').toBeTruthy();
    expect(propia!.id).not.toBe(sol.id);
  });

  it('sin el flag, el mismo correo se suma a la solicitud que cita', async () => {
    const original = eml({
      asunto: 'SOLICITUD DE FAO (RESPETAR SA) empresa', pdfNombre: 'doc.pdf', pdf: '%PDF tres',
      csv: 'CUIL,Nombre completo\n20-31496468-0,Silva Carlos\n',
    });
    await processEmail(original.id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, original.id)).get()!;
    const orden = asignarNroOrden(sol.id);

    const segundo = eml({
      asunto: 'Documentacion', pdfNombre: 'doc4.pdf', pdf: '%PDF cuatro',
      cuerpo: `Falta esto de la orden ${orden}.`,
    });
    await app.inject({ method: 'POST', url: `/api/emails/${segundo.id}/procesar`, headers: { cookie }, payload: {} });

    expect(db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, segundo.id)).get()).toBeFalsy();
    expect(db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, segundo.id)).get()!.replySolicitudId).toBe(sol.id);
  });
});

/**
 * La planilla de personas no es documentación: sirvió para dar de alta a las personas y eso ya se
 * ve en la lista de la solicitud. En la revisión es ruido, y en el contador hacía que el correo
 * dijera un archivo más de los que había para mirar.
 */
describe('la planilla de personas no se muestra como documentación', () => {
  it('no aparece en la documentación de la solicitud, y el PDF sí', async () => {
    const email = eml({
      asunto: 'SOLICITUD DE FAO (SIN PLANILLA SA) empresa', pdfNombre: 'F931.pdf', pdf: '%PDF el 931',
      csv: 'CUIL,Nombre completo\n20-31596674-0,Ortiz Raul\n',
    });
    await processEmail(email.id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, email.id)).get()!;

    const docs = await documentacion(sol.id);
    expect(docs.map((d) => d.filename)).toContain('F931.pdf');
    expect(docs.some((d) => /\.csv$|\.xlsx$/i.test(d.filename)), 'la planilla no va en la documentación').toBe(false);

    // Y la persona que venía en esa planilla sí quedó cargada: para eso servía.
    const personas = db.select().from(schema.solicitudPersonas).where(eq(schema.solicitudPersonas.solicitudId, sol.id)).all();
    expect(personas.length).toBe(1);

    // El contador que se muestra cuenta la documentación, no la planilla.
    expect(db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, email.id)).get()!.attachmentsCount).toBe(1);
  });
});

/**
 * En el respaldo, el botón tiene que decir a dónde va a ir el correo. Cuando no pertenece a ninguna
 * solicitud, "Es otro pedido" hacía exactamente lo mismo que "Procesar": dos botones para una sola
 * acción, y nadie podía saber a qué solicitud se iba a sumar.
 */
describe('a qué solicitud iría cada correo del respaldo', () => {
  const respaldo = async () => {
    const res = await app.inject({ method: 'GET', url: '/api/emails/respaldo', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    return res.json() as any[];
  };

  it('un correo sin lista de personas no tiene destino: se crea una solicitud nueva', async () => {
    const email = eml({ asunto: 'Documentacion', pdfNombre: 'algo.pdf', pdf: '%PDF sin planilla' });
    await processEmail(email.id);
    const fila = (await respaldo()).find((r) => r.id === email.id);
    expect(fila, 'tiene que estar en el respaldo').toBeTruthy();
    expect(fila.destino, 'no pertenece a ninguna solicitud').toBeNull();
  });

  /**
   * Un correo que cita una orden existente NO cae en el respaldo: se fusiona y listo. El caso donde
   * los dos botones hacen cosas distintas es el del local cruzado, que queda parado justamente para
   * que alguien elija entre sumarlo a la orden citada o abrirle la suya.
   */
  it('en un cruce de local, el botón ofrece la orden citada', async () => {
    // La orden es de un local, y el que escribe tiene historial de otro.
    const dueno = eml({
      asunto: 'SOLICITUD DE FAO (DUENO SA) empresa', pdfNombre: 'f.pdf', pdf: '%PDF x',
      csv: 'CUIL,Nombre completo\n20-31139479-9,Nuñez Ana\n',
    });
    await processEmail(dueno.id);
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, dueno.id)).get()!;
    const orden = asignarNroOrden(sol.id);

    // Historial del otro remitente: siempre escribió por OTRO SA.
    const otroLocal = db.insert(schema.locales).values({ nombre: `OTRO SA ${Date.now()}`, estado: 'ACTIVO' }).returning().get();
    db.insert(schema.emailMessages).values({
      messageId: `<hist-cruce-${Date.now()}>`, estado: 'PROCESSED', remitente: 'Ajeno <ajeno@otro.com>',
      asunto: 'SOLICITUD DE FAO (OTRO SA)', localId: otroLocal.id,
    }).run();

    // Ahora el de OTRO SA cita la orden del primero.
    const cruzado = eml({ asunto: `Documentacion de la orden ${orden}`, pdfNombre: 'g.pdf', pdf: '%PDF y', de: 'Ajeno <ajeno@otro.com>' });
    await processEmail(cruzado.id);

    const fila = (await respaldo()).find((r) => r.id === cruzado.id);
    expect(fila, 'el cruce tiene que quedar en el respaldo').toBeTruthy();
    expect(fila.destino?.nroOrden, 'el botón ofrece sumarlo a la orden citada').toBe(orden);
  });
});
