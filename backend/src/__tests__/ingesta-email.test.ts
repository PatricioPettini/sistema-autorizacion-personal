import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { eq, desc } from 'drizzle-orm';
import { migrate } from '../db/migrate.js';
import { db, schema } from '../db/client.js';
import { env } from '../config/env.js';
import { processEmail, pedirListaAlRemitente } from '../modules/processing/processor.js';
import { claveMensaje, paraRevisar } from '../modules/email/reader.js';
import { huellaContenido } from '../modules/processing/processor.js';
import { esBuzonAutomatico } from '../modules/email/mailer.js';
import { asignarNroOrden } from '../modules/solicitudes/service.js';
import { simpleParser } from 'mailparser';

beforeAll(() => { migrate(); });

/** Arma un .eml real en disco y su fila, como lo dejaría el lector IMAP. */
function guardarEml(opts: { asunto: string; conAdjunto: boolean; cuerpo?: string; adjunto?: string; adjuntoNombre?: string; csv?: string; csvNombre?: string; inReplyTo?: string }) {
  const mid = `<eml-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test>`;
  const b = '----limite';
  const cuerpo = opts.cuerpo ?? 'Buenas tardes, envio la documentacion.';
  const partes = [
    `Message-ID: ${mid}`,
    'From: Local Test <local@test.com>',
    `Subject: ${opts.asunto}`,
    'Date: Fri, 28 Aug 2026 19:54:00 -0300',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`] : []),
    '',
    `--${b}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    cuerpo,
  ];
  if (opts.conAdjunto) {
    partes.push(
      `--${b}`,
      `Content-Type: application/pdf; name="${opts.adjuntoNombre ?? 'F931.pdf'}"`,
      `Content-Disposition: attachment; filename="${opts.adjuntoNombre ?? 'F931.pdf'}"`,
      // Hay clientes (Gmail entre ellos) que le ponen Content-ID a TODOS los adjuntos,
      'Content-ID: <f_test1234>',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(opts.adjunto ?? '%PDF-1.4 documentacion').toString('base64'),
    );
  }
  if (opts.csv) {
    partes.push(
      `--${b}`,
      `Content-Type: text/csv; name="${opts.csvNombre ?? 'personas.csv'}"`,
      `Content-Disposition: attachment; filename="${opts.csvNombre ?? 'personas.csv'}"`,
      'Content-ID: <f_csv1234>',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(opts.csv).toString('base64'),
    );
  }
  partes.push(`--${b}--`, '');

  fs.mkdirSync(env.emailsPath, { recursive: true });
  const rawPath = path.join(env.emailsPath, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.eml`);
  fs.writeFileSync(rawPath, partes.join('\r\n'));
  return db.insert(schema.emailMessages).values({
    messageId: mid, remitente: 'Local Test <local@test.com>', asunto: opts.asunto,
    estado: 'RECEIVED', rawStoredPath: rawPath,
  }).returning().get();
}

const solicitudDe = (emailId: number) =>
  db.select().from(schema.solicitudes).where(eq(schema.solicitudes.emailMessageId, emailId)).get();

describe('ingesta: sin lista de personas legible', () => {
  // Decisión del equipo: no se crea la solicitud aunque venga con toda la documentación. Se le
  // pide la lista al remitente para que reenvíe el pedido completo y entre solo; dar de alta la
  // solicitud vacía y cargar las personas a mano no escala.
  it('no crea solicitud y queda en respaldo, aunque el correo traiga adjuntos', async () => {
    const email = guardarEml({ asunto: 'PERMISOS INSTALACION VIDRIERA', conAdjunto: true });
    await processEmail(email.id);

    expect(solicitudDe(email.id)).toBeFalsy();
    const fila = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, email.id)).get();
    expect(fila!.estado).toBe('NEEDS_REVIEW');
    expect(fila!.error).toMatch(/lista de personas/i);
  });

  it('tampoco si no trae nada adjunto', async () => {
    const email = guardarEml({ asunto: 'Consulta requisitos FAO', conAdjunto: false });
    await processEmail(email.id);

    expect(solicitudDe(email.id)).toBeFalsy();
    const fila = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, email.id)).get();
    expect(fila!.estado).toBe('NEEDS_REVIEW');
  });

  it('un reenvio cuyos "personas" son los encabezados del mail tambien se rechaza', async () => {
    // Caso real (OA-2026-0221, 47 Avenida). El parser del cuerpo leia 3 filas de los encabezados del
    // mail reenviado —"De:", "Para:", con el 47985775 sacado de los telefonos de la marca—, asi que
    // `filas.length` era 3 y el rechazo no se disparaba: quedaba una solicitud VACIA y el local
    // nunca se enteraba de que le faltaba la nomina.
    const cuerpo = [
      'Buenas, reenvio la nomina.',
      '',
      'De: 47 Olmos 47985775',
      'Para: 47 Olmos 47985775',
      'Para: 47 Olmos 47 centronorte 47985775',
    ].join(String.fromCharCode(10));
    const email = guardarEml({ asunto: 'Fw: RV: Nomina', conAdjunto: true, cuerpo });

    await processEmail(email.id);

    expect(solicitudDe(email.id)).toBeFalsy();
    const fila = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, email.id)).get();
    expect(fila!.estado).toBe('NEEDS_REVIEW');
    expect(fila!.error).toMatch(/lista de personas/i);
  });

  it('con una sola persona legible SI crea la solicitud', async () => {
    // La contracara: el filtro no puede volverse tan duro que frene un pedido de verdad.
    const cuerpo = [
      'Buenas, va la nomina.',
      'CUIL 20-33163078-1 PEREZ JUAN CARLOS',
      '',
      'De: 47 Olmos 47985775',
    ].join(String.fromCharCode(10));
    const email = guardarEml({ asunto: 'Solicitud Fao prueba2020 - empresa', conAdjunto: true, cuerpo });

    await processEmail(email.id);

    const sol = solicitudDe(email.id);
    expect(sol).toBeTruthy();
    const cuantas = db.select().from(schema.solicitudPersonas).where(eq(schema.solicitudPersonas.solicitudId, sol!.id)).all();
    expect(cuantas).toHaveLength(1);
  });

  it('con el aviso apagado igual frena el correo, pero no le escribe al remitente', async () => {
    // Muchas veces la nomina esta en el PDF y se carga a mano: ahi pedirle la lista al local es
    // ruido. El correo tiene que quedar frenado igual, que es lo que evita la solicitud vacia.
    // Se guarda el valor real y se restaura: dejarlo fijo cambiaria el comportamiento de los tests
    // que corren despues en este mismo archivo.
    const antes = env.mail.avisoSinPersonas;
    (env.mail as any).avisoSinPersonas = false;
    try {
      const email = guardarEml({ asunto: 'Consulta requisitos FAO', conAdjunto: true });
      await processEmail(email.id);

      expect(solicitudDe(email.id)).toBeFalsy();
      const fila = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, email.id)).get();
      expect(fila!.estado).toBe('NEEDS_REVIEW');
      expect(fila!.error).toMatch(/lista de personas/i);
      // El motivo tiene que invitar a resolverlo, no decir que ya se aviso.
      expect(fila!.error).not.toMatch(/Se avisó al remitente/i);
    } finally {
      (env.mail as any).avisoSinPersonas = antes;
    }
  });

  it('"Procesar igual" desde el respaldo sí la crea, con el local del asunto', async () => {
    const email = guardarEml({ asunto: 'Solicitud Fao prueba1010 - empresa', conAdjunto: true });
    await processEmail(email.id);
    expect(solicitudDe(email.id)).toBeFalsy();

    await processEmail(email.id, { force: true });
    const sol = solicitudDe(email.id);
    expect(sol).toBeTruthy();
    const local = db.select().from(schema.locales).where(eq(schema.locales.id, sol!.localId)).get();
    expect(local!.nombre.toLowerCase()).toBe('prueba1010');
  });
});

describe('claveMensaje', () => {
  it('usa el Message-ID cuando está', () => {
    expect(claveMensaje({ messageId: '<abc@dom>' })).toBe('<abc@dom>');
  });

  it('arma una huella estable para los correos sin Message-ID (antes se perdían)', () => {
    const sobre = { date: new Date('2026-08-28T22:13:00Z'), from: [{ address: 'a@b.com' }], subject: 'Solicitud FAO (X)' };
    const k1 = claveMensaje(sobre);
    const k2 = claveMensaje({ ...sobre });
    expect(k1).toBe(k2);
    expect(k1).toContain('sin-message-id');
    expect(claveMensaje({ ...sobre, subject: 'Otra cosa' })).not.toBe(k1);
  });
});

describe('el mismo pedido llega a las dos casillas', () => {
  const planilla = (cuil: string) => `CUIL,Nombre completo
${cuil},Juan Perez
`;

  it('la segunda copia se engancha al pedido original y no crea otra solicitud', async () => {
    const asunto = 'SOLICITUD DE FAO (DUPLICADO SA) empresa';
    const csv = planilla('20-31055613-1');

    // Llega a la casilla nueva.
    const a = guardarEml({ asunto, conAdjunto: true, csv });
    await processEmail(a.id);
    const sol = solicitudDe(a.id);
    expect(sol, 'el primero tiene que crear la solicitud').toBeTruthy();

    // El mismo correo, mandado por separado a la casilla vieja: otro Message-ID, mismo contenido.
    const b = guardarEml({ asunto, conAdjunto: true, csv });
    await processEmail(b.id);

    expect(solicitudDe(b.id), 'no se puede duplicar la solicitud').toBeFalsy();
    const fila = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, b.id)).get();
    expect(fila!.estado).toBe('PROCESSED');
    expect(fila!.replySolicitudId).toBe(sol!.id);
    expect(fila!.error).toMatch(/dos casillas/i);
  });

  it('dos pedidos distintos del mismo local con el mismo asunto NO se toman por duplicados', async () => {
    const asunto = 'SOLICITUD DE FAO (REPETIDOR SA) empresa';
    const a = guardarEml({ asunto, conAdjunto: true, csv: planilla('20-31456041-7') });
    await processEmail(a.id);
    const b = guardarEml({ asunto, conAdjunto: true, csv: planilla('27-38066308-8') });
    await processEmail(b.id);

    expect(solicitudDe(a.id)).toBeTruthy();
    expect(solicitudDe(b.id), 'planillas distintas = pedido distinto').toBeTruthy();
  });

  it('un PDF con Content-ID cuenta como documentación igual', async () => {
    const email = guardarEml({ asunto: 'FAO (X) empresa', conAdjunto: true, csv: planilla('20-31415833-3') });
    await processEmail(email.id);
    // Si el Content-ID descartara los adjuntos, la huella caería en el cuerpo y perderíamos
    // la documentación en la comparación.
    const fila = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, email.id)).get();
    // 1, no 2: el correo trae el PDF y la planilla, y la planilla no se cuenta como documentación
    // (es la entrada con la que se dan de alta las personas, no un papel para revisar).
    expect(fila!.attachmentsCount).toBe(1);
  });
});

describe('huellaContenido', () => {
  const parsed = (adj?: string, text = 'hola') => ({
    attachments: adj ? [{ filename: 'n.pdf', content: Buffer.from(adj), contentType: 'application/pdf' }] : [],
    text,
  }) as any;

  it('ignora el prefijo Re:/RV: del asunto', () => {
    const a = huellaContenido({ remitente: 'X <a@b.com>', asunto: 'Solicitud FAO (X)' }, parsed('doc'));
    const b = huellaContenido({ remitente: 'X <a@b.com>', asunto: 'RE: RV: Solicitud FAO (X)' }, parsed('doc'));
    expect(a).toBe(b);
  });

  it('distingue remitentes y adjuntos distintos', () => {
    const base = huellaContenido({ remitente: 'a@b.com', asunto: 'FAO' }, parsed('doc'));
    expect(huellaContenido({ remitente: 'otro@b.com', asunto: 'FAO' }, parsed('doc'))).not.toBe(base);
    expect(huellaContenido({ remitente: 'a@b.com', asunto: 'FAO' }, parsed('otro doc'))).not.toBe(base);
  });
});

describe('no contestarle a buzones automáticos', () => {
  it('reconoce las direcciones que no leen a nadie', () => {
    for (const d of ['no-reply@accounts.google.com', 'noreply@x.com', 'NoReply@X.com', 'mailer-daemon@y.org', 'postmaster@z.net', 'bounces+123@w.io']) {
      expect(esBuzonAutomatico(d), d).toBe(true);
    }
  });

  it('no se come direcciones reales de locales', () => {
    for (const d of ['centro@marcas.example', 'encargada@local.example', 'replay@empresa.com', 'noreplica@x.com']) {
      expect(esBuzonAutomatico(d), d).toBe(false);
    }
  });
});

/**
 * Después de una caída del correo, lo que quedó en el buzón puede haberse cargado a mano. Si el
 * lector lo procesa solo, crea la solicitud por segunda vez. Va al respaldo y una persona decide.
 */
describe('correos anteriores al corte: van al respaldo, no se procesan solos', () => {
  const corte = '2026-09-04';

  it('sin corte configurado, todo se procesa normalmente', () => {
    expect(paraRevisar(new Date('2026-01-01T10:00:00Z'), '')).toBe(false);
  });

  it('lo anterior al corte va al respaldo', () => {
    expect(paraRevisar(new Date('2026-09-03T12:00:00Z'), corte)).toBe(true);
    expect(paraRevisar(new Date('2026-08-29T10:00:00Z'), corte)).toBe(true);
  });

  it('lo del día del corte y lo posterior se procesa solo', () => {
    expect(paraRevisar(new Date('2026-09-04T12:00:00Z'), corte)).toBe(false);
    expect(paraRevisar(new Date('2026-09-10T10:00:00Z'), corte)).toBe(false);
  });

  /**
   * El corte se interpreta en la zona del sistema (America/Argentina/Buenos_Aires), no en UTC:
   * "anteriores al 04/09" significa hasta el 03/09 a las 23:59 de acá. Un correo de las 00:30 UTC
   * del 04/09 son las 21:30 del 03/09 local, así que va al respaldo.
   */
  it('el corte es por fecha LOCAL, no por UTC', () => {
    expect(paraRevisar(new Date('2026-09-04T00:30:00Z'), corte)).toBe(true);
    expect(paraRevisar(new Date('2026-09-04T03:30:00Z'), corte)).toBe(false);
  });

  it('un correo sin fecha en el sobre va al respaldo: no se puede saber de cuándo es', () => {
    expect(paraRevisar(null, corte)).toBe(true);
    // Salvo que no haya corte: ahí no hay nada que decidir.
    expect(paraRevisar(null, '')).toBe(false);
  });

  it('una fecha de corte inválida no bloquea la recepción', () => {
    expect(paraRevisar(new Date('2026-09-03T10:00:00Z'), 'no-es-una-fecha')).toBe(false);
  });
});

/**
 * Caso real de Zuecos: mandaron la nómina como "Personal de SERCO.png" y escribieron "la nómina fue
 * enviada". El sistema no puede leer una lista desde una imagen, y el aviso anterior no lo decía,
 * así que reenviaban lo mismo en el mismo formato.
 */
describe('aviso cuando no se puede leer la lista', () => {
  // Ya no se manda solo: lo dispara el botón "Pedir la nómina" de la solicitud. Lo que se prueba
  // acá es el TEXTO, que es lo que evita que el local reenvíe lo mismo en el mismo formato.
  it('dice explícitamente que una imagen o un PDF no sirven', async () => {
    const email = guardarEml({ asunto: 'SOLICITUD DE FAO (X) empresa', conAdjunto: true });
    await processEmail(email.id);

    // El envío se registra igual aunque no haya SMTP configurado (que es el caso en los tests):
    // lo que se prueba acá es el texto, no el transporte.
    await pedirListaAlRemitente(email.id);

    const enviado = db.select().from(schema.sentEmails).orderBy(desc(schema.sentEmails.id)).limit(1).get();
    expect(enviado?.tipo).toBe('SIN_PERSONAS');
    expect(enviado?.cuerpo).toMatch(/imagen/i);
    expect(enviado?.cuerpo).toMatch(/PDF/);
    expect(enviado?.cuerpo).toMatch(/Excel/);
  });

  it('procesando un correo sin nómina NO se le escribe al remitente', async () => {
    // La decisión del cliente: el aviso automático quedaba mal porque casi siempre la nómina está
    // en el PDF y se carga a mano.
    const antes = db.select().from(schema.sentEmails).all().length;
    const email = guardarEml({ asunto: 'SOLICITUD DE FAO (Y) empresa', conAdjunto: true });
    await processEmail(email.id);
    expect(db.select().from(schema.sentEmails).all().length).toBe(antes);
  });
});

/**
 * De punta a punta, con un .eml real: un local responde (o manda un correo nuevo con el número de
 * orden) y la documentación tiene que quedar EN LA SOLICITUD QUE YA EXISTE, no en una nueva.
 *
 * Los tests de `merge-respuesta` prueban las piezas por separado (la detección con un stub y
 * `sumarASolicitud` a mano). Acá se ejerce el camino completo —`processEmail` leyendo el archivo
 * del disco— y además se pide la documentación por la misma ruta que usa la pantalla de revisión,
 * que es donde el usuario ve (o no ve) los archivos.
 */
describe('la documentación que llega después se suma a la solicitud existente', () => {
  const planilla = (cuil: string, nombre: string) => `CUIL,Nombre completo\n${cuil},${nombre}\n`;

  /** Los archivos que la pantalla de revisión le muestra al que revisa. */
  async function documentacionDe(solicitudId: number) {
    const sol = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, solicitudId)).get()!;
    const originales = [sol.emailMessageId].filter((x): x is number => x != null);
    const respuestas = db.select({ id: schema.emailMessages.id }).from(schema.emailMessages)
      .where(eq(schema.emailMessages.replySolicitudId, solicitudId)).all().map((r) => r.id);
    const nombres: string[] = [];
    for (const emailId of [...new Set([...originales, ...respuestas])]) {
      const fila = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, emailId)).get()!;
      const parsed = await simpleParser(fs.readFileSync(fila.rawStoredPath!));
      for (const a of parsed.attachments ?? []) if (a.filename) nombres.push(a.filename);
    }
    return nombres;
  }

  const personasDe = (solicitudId: number) =>
    db.select().from(schema.solicitudPersonas).where(eq(schema.solicitudPersonas.solicitudId, solicitudId)).all();

  it('respondiendo el correo del sistema (In-Reply-To)', async () => {
    // 1. El pedido original crea la solicitud.
    const original = guardarEml({ asunto: 'SOLICITUD DE FAO (HILO SA) empresa', conAdjunto: true, csv: planilla('20-31464950-8', 'Perez Juan') });
    await processEmail(original.id);
    const sol = solicitudDe(original.id)!;
    expect(sol, 'el pedido original tiene que crear la solicitud').toBeTruthy();
    expect(personasDe(sol.id).length).toBe(1);

    // 2. El sistema le contesta pidiendo lo que falta.
    const midEnviado = `<sent-hilo-${Date.now()}@sistema>`;
    db.insert(schema.sentEmails).values({ messageId: midEnviado, solicitudId: sol.id, tipo: 'RESULTADO_REVISION', ok: true }).run();

    // 3. El local responde ese correo con el ART que faltaba y una persona más.
    const respuesta = guardarEml({
      asunto: 'RE: Resultado de su solicitud', conAdjunto: true, adjuntoNombre: 'ART.pdf',
      adjunto: '%PDF-1.4 nomina art', csv: planilla('27-38066308-8', 'Gomez Ana'), csvNombre: 'faltante.csv',
      inReplyTo: midEnviado,
    });
    await processEmail(respuesta.id);

    // No se creó otra solicitud y el correo quedó colgado de la que ya existía.
    expect(solicitudDe(respuesta.id), 'no puede crear una solicitud nueva').toBeFalsy();
    const fila = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, respuesta.id)).get()!;
    expect(fila.replySolicitudId).toBe(sol.id);

    // La persona nueva entró y los archivos se ven desde la revisión.
    expect(personasDe(sol.id).length, 'la persona de la respuesta tiene que sumarse').toBe(2);
    const docs = await documentacionDe(sol.id);
    expect(docs).toContain('F931.pdf');   // del pedido original
    expect(docs).toContain('ART.pdf');    // de la respuesta
  });

  it('en un correo NUEVO con el número de orden en el cuerpo (no en el asunto)', async () => {
    const original = guardarEml({ asunto: 'SOLICITUD DE FAO (CUERPO SA) empresa', conAdjunto: true, csv: planilla('20-31863875-3', 'Lopez Mario') });
    await processEmail(original.id);
    const sol = solicitudDe(original.id)!;
    const nro = asignarNroOrden(sol.id); // la solicitud ya tiene número (se le informó al local)

    // Correo aparte, sin In-Reply-To, sin el número en el asunto: solo escrito en el texto.
    const nuevo = guardarEml({
      asunto: 'Documentacion faltante', conAdjunto: true, adjuntoNombre: 'clausula.pdf',
      cuerpo: `Buenas, mando lo que falta de la orden ${nro}. Saludos.`,
      csv: planilla('20-40918206-3', 'Ramos Fernando'), csvNombre: 'nomina2.csv',
    });
    await processEmail(nuevo.id);

    expect(solicitudDe(nuevo.id), 'no puede abrir una solicitud nueva').toBeFalsy();
    const fila = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, nuevo.id)).get()!;
    expect(fila.replySolicitudId).toBe(sol.id);
    expect(personasDe(sol.id).length).toBe(2);
    expect(await documentacionDe(sol.id)).toContain('clausula.pdf');
  });

  it('un correo suelto, sin número ni hilo, sí abre un pedido nuevo', async () => {
    const suelto = guardarEml({
      asunto: 'SOLICITUD DE FAO (SUELTO SA) empresa', conAdjunto: true,
      cuerpo: 'Adjunto documentacion.', csv: planilla('27-45351525-2', 'Espinoza Lourdes'),
    });
    await processEmail(suelto.id);
    expect(solicitudDe(suelto.id), 'sin señal de pertenencia es un pedido nuevo').toBeTruthy();
  });
});
