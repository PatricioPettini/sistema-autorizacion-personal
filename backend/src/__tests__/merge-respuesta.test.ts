import { describe, it, expect, beforeAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { migrate } from '../db/migrate.js';
import { db, schema } from '../db/client.js';
import { findOrCreatePersona } from '../modules/personas/service.js';
import { detectarSolicitudDestino, sumarASolicitud, buscarNroOrden, conflictoDeLocal, localDelRemitente } from '../modules/processing/processor.js';

beforeAll(() => { migrate(); });

function crearSolicitud(nroOrden: string | null, messageId: string) {
  const local = db.insert(schema.locales).values({ nombre: `Local ${messageId}`, estado: 'ACTIVO' }).returning().get();
  const email = db.insert(schema.emailMessages).values({ messageId, estado: 'PROCESSED', asunto: 'Solicitud FAO (X) empresa' }).returning().get();
  const sol = db.insert(schema.solicitudes).values({ localId: local.id, emailMessageId: email.id, estado: 'PENDIENTE', nroOrden }).returning().get();
  return { sol, email, local };
}

// mailparser-like stub
function parsedStub(opts: { csv?: string; pdf?: boolean; inReplyTo?: string } = {}) {
  return {
    attachments: [
      ...(opts.csv ? [{ filename: 'personas.csv', content: Buffer.from(opts.csv), contentType: 'text/csv' }] : []),
      ...(opts.pdf ? [{ filename: 'doc.pdf', content: Buffer.from('%PDF-1.4 documentacion'), contentType: 'application/pdf' }] : []),
    ],
    text: '', html: false as any, inReplyTo: opts.inReplyTo, references: undefined,
  } as any;
}

describe('detectarSolicitudDestino', () => {
  it('matchea por número de orden en el asunto', () => {
    const { sol } = crearSolicitud('OA-2026-7777', `<orig-${Date.now()}>`);
    const email = { asunto: `RE: consulta orden OA-2026-7777`, messageId: '<x>' } as any;
    expect(detectarSolicitudDestino(email, parsedStub())).toBe(sol.id);
  });

  it('matchea por respuesta a un correo que enviamos (In-Reply-To)', () => {
    const { sol } = crearSolicitud('OA-2026-8888', `<orig2-${Date.now()}>`);
    const enviadoMid = `<sent-${Date.now()}@sistema>`;
    db.insert(schema.sentEmails).values({ messageId: enviadoMid, solicitudId: sol.id, tipo: 'RESULTADO_REVISION', ok: true }).run();
    const email = { asunto: 'sin orden', messageId: '<y>' } as any;
    expect(detectarSolicitudDestino(email, parsedStub({ inReplyTo: enviadoMid }))).toBe(sol.id);
  });

  it('devuelve null si no coincide con nada', () => {
    const email = { asunto: 'Solicitud nueva', messageId: '<z>' } as any;
    expect(detectarSolicitudDestino(email, parsedStub())).toBeNull();
  });
});

describe('sumarASolicitud', () => {
  it('agrega personas nuevas del Excel sin duplicar y vincula el correo', async () => {
    const { sol, local } = crearSolicitud(null, `<merge-${Date.now()}>`);
    // Persona ya existente en la solicitud.
    const yaExiste = findOrCreatePersona({ cuil: '20-33792645-8', nombre: 'Juan', apellido: 'Perez' }).persona;
    db.insert(schema.solicitudPersonas).values({ solicitudId: sol.id, personaId: yaExiste.id }).run();

    // Correo de respuesta con un CSV: repite a Juan y agrega a Ana.
    const email = db.insert(schema.emailMessages).values({ messageId: `<resp-${Date.now()}>`, estado: 'RECEIVED', asunto: 'RE: FAO empresa' }).returning().get();
    const csv = 'CUIL,Nombre y Apellido\n20-33792645-8,Perez Juan\n27-38066308-8,Gomez Ana\n';
    await sumarASolicitud(email as any, email.id, sol.id, parsedStub({ csv }));

    const personas = db.select().from(schema.solicitudPersonas).where(eq(schema.solicitudPersonas.solicitudId, sol.id)).all();
    expect(personas.length).toBe(2); // Juan (no duplicado) + Ana

    const emailAct = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, email.id)).get()!;
    expect(emailAct.replySolicitudId).toBe(sol.id);
    expect(emailAct.estado).toBe('PROCESSED'); // solicitud no terminada

    const coment = db.select().from(schema.comentarios).where(eq(schema.comentarios.solicitudId, sol.id)).all();
    expect(coment.length).toBeGreaterThan(0);
    expect(local).toBeTruthy();
  });

  it('la persona nueva hereda el tipo de la solicitud si no lo declara el mail', async () => {
    const { sol } = crearSolicitud(null, `<hered-${Date.now()}>`);
    // Persona existente EMPRESA.
    const base = findOrCreatePersona({ cuil: '20-31055613-1', nombre: 'Base', apellido: 'Empresa' }).persona;
    db.update(schema.personas).set({ categoria: 'EMPRESA' }).where(eq(schema.personas.id, base.id)).run();
    db.insert(schema.solicitudPersonas).values({ solicitudId: sol.id, personaId: base.id }).run();

    const email = db.insert(schema.emailMessages).values({ messageId: `<respH-${Date.now()}>`, estado: 'RECEIVED', asunto: 'RE: sin tipo' }).returning().get();
    await sumarASolicitud(email as any, email.id, sol.id, parsedStub({ csv: 'CUIL,Nombre y Apellido\n27-45351525-2,Espinoza Lourdes\n' }));

    const nueva = db.select().from(schema.personas).where(eq(schema.personas.cuil, '27453515252')).get()!;
    expect(nueva.categoria).toBe('EMPRESA');
  });

  /**
   * "Terminada" es haberle informado el resultado al local, no tener número de orden: el número se
   * asigna al CREAR la solicitud, así que preguntarlo por ahí daba verdadero siempre y cualquier
   * correo que se sumara caía en el respaldo con un "ya terminada" falso.
   */
  it('si ya se le informó el resultado al local, deja el correo en respaldo como aviso', async () => {
    const { sol } = crearSolicitud('OA-2026-9999', `<merge2-${Date.now()}>`);
    db.insert(schema.sentEmails).values({ messageId: `<inf-${Date.now()}@sistema>`, solicitudId: sol.id, tipo: 'RESULTADO_REVISION', ok: true }).run();
    const email = db.insert(schema.emailMessages).values({ messageId: `<resp2-${Date.now()}>`, estado: 'RECEIVED', asunto: 'RE: orden OA-2026-9999' }).returning().get();
    await sumarASolicitud(email as any, email.id, sol.id, parsedStub({ csv: 'CUIL,Nombre y Apellido\n20-40918206-3,Ramos Fernando\n' }));
    const emailAct = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, email.id)).get()!;
    // El correo se procesó: su documentación ya está en la solicitud. No va al respaldo.
    expect(emailAct.estado).toBe('PROCESSED');
    expect(emailAct.replySolicitudId).toBe(sol.id);
    // El aviso queda EN LA SOLICITUD, que es donde hay algo que hacer.
    const solAct = db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, sol.id)).get()!;
    expect(solAct.docNuevaAt, 'la solicitud tiene que quedar marcada para re-revisar').toBeTruthy();
  });
});

/**
 * Caso real: dos respuestas de un local ya estaban vinculadas a su solicitud (reply_solicitud_id),
 * pero al tocar "Procesar igual" se crearon DOS solicitudes nuevas y vacías. El botón forzaba las
 * dos cosas a la vez: "creá aunque no haya lista de personas" e "ignorá a qué solicitud pertenece".
 * Ahora son dos flags distintos y el botón solo usa la primera.
 */
describe('a qué solicitud pertenece un correo', () => {
  it('encuentra el número de orden en el CUERPO, no solo en el asunto', () => {
    const { sol } = crearSolicitud('OA-2026-5551', `<cuerpo-${Date.now()}>`);
    const email = { asunto: 'Documentación que faltaba', messageId: '<x1>' } as any;
    const parsed = { ...parsedStub(), text: 'Buenas, mando lo que falta de la orden OA-2026-5551. Saludos' } as any;
    expect(detectarSolicitudDestino(email, parsed)).toBe(sol.id);
  });

  it('el número de orden en el asunto sigue mandando', () => {
    const { sol } = crearSolicitud('OA-2026-5552', `<asunto-${Date.now()}>`);
    const email = { asunto: 'RE: Orden OA-2026-5552 — Resultado', messageId: '<x2>' } as any;
    expect(detectarSolicitudDestino(email, parsedStub())).toBe(sol.id);
  });

  it('sin número ni hilo conocido, es un pedido nuevo', () => {
    const email = { asunto: 'Solicitud de FAO (Local Nuevo) empresa', messageId: '<x3>' } as any;
    const parsed = { ...parsedStub(), text: 'Adjunto la documentación.' } as any;
    expect(detectarSolicitudDestino(email, parsed)).toBeNull();
  });

  it('solo se ignora el destino si se pide explícitamente', () => {
    const { sol } = crearSolicitud('OA-2026-5553', `<ignorar-${Date.now()}>`);
    const email = { asunto: 'RE: Orden OA-2026-5553', messageId: '<x4>' } as any;
    expect(detectarSolicitudDestino(email, parsedStub())).toBe(sol.id);
    expect(detectarSolicitudDestino(email, parsedStub(), true)).toBeNull();
  });
});

/**
 * Caso real ZENIT (04/09). En agosto el local mandó "Ejemplo. SOLICITUD DE FAO (ZENIT) — Comercial
 * x2" y eso generó OA-2026-0026, que quedó autorizada. El 04/09 mandó un pedido DISTINTO
 * ("INSTALACION WIFI", 6 personas) pero lo escribió dentro de la misma conversación de Outlook,
 * cambiándole el asunto. Outlook conserva la cadena de References, así que por el hilo parecía
 * documentación del pedido de agosto: las 6 personas se colgaron de una solicitud de otro trabajo.
 */
describe('un pedido nuevo escrito dentro de un hilo viejo', () => {
  /** Como en la realidad: la solicitud vieja nació de un correo con SU asunto. */
  function solicitudDeUnCorreo(asunto: string, nroOrden: string | null) {
    const mid = `<orig-hilo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@outlook>`;
    const local = db.insert(schema.locales).values({ nombre: `ZENIT ${mid.slice(1, 24)}`, estado: 'ACTIVO' }).returning().get();
    const email = db.insert(schema.emailMessages).values({ messageId: mid, estado: 'PROCESSED', asunto }).returning().get();
    const sol = db.insert(schema.solicitudes).values({ localId: local.id, emailMessageId: email.id, estado: 'PENDIENTE', nroOrden }).returning().get();
    return { sol, mid };
  }

  it('no se cuelga de la solicitud vieja: es otro pedido', () => {
    const { sol, mid } = solicitudDeUnCorreo('Ejemplo. SOLICITUD DE FAO (ZENIT) - MAVI INVERSIONES S.A - Comercial x2', 'OA-2026-0026');
    const nuevo = { asunto: 'SOLICITUD DE FAO (ZENIT) - MAVI INVERSIONES S.A - INSTALACION WIFI', messageId: '<wifi@outlook>' } as any;
    expect(detectarSolicitudDestino(nuevo, parsedStub({ inReplyTo: mid }))).toBeNull();
    expect(sol.nroOrden).toBe('OA-2026-0026');
  });

  it('un RE: del MISMO asunto sí se suma (es la misma gestión)', () => {
    const asunto = 'SOLICITUD DE FAO (ZENIT) - MAVI INVERSIONES S.A - INSTALACION WIFI';
    const { sol, mid } = solicitudDeUnCorreo(asunto, null);
    const respuesta = { asunto: `RE: ${asunto}`, messageId: '<re-wifi@outlook>' } as any;
    expect(detectarSolicitudDestino(respuesta, parsedStub({ inReplyTo: mid }))).toBe(sol.id);
  });

  it('correspondencia del hilo que no es un pedido de FAO se sigue sumando', () => {
    const { sol, mid } = solicitudDeUnCorreo('SOLICITUD DE FAO (ZENIT) - Comercial', null);
    // Le cambian el asunto pero no es un pedido: es una consulta sobre el mismo trámite.
    const consulta = { asunto: 'Consulta por la documentación pendiente', messageId: '<consulta@outlook>' } as any;
    expect(detectarSolicitudDestino(consulta, parsedStub({ inReplyTo: mid }))).toBe(sol.id);
  });

  it('el número de orden explícito manda por encima de todo esto', () => {
    const { sol, mid } = solicitudDeUnCorreo('Ejemplo. SOLICITUD DE FAO (OTRO) - Comercial', 'OA-2026-4242');
    // Asunto de pedido nuevo, pero cita el número de orden: el remitente fue explícito.
    const conNro = { asunto: 'SOLICITUD DE FAO (OTRO) - Instalacion — orden OA-2026-4242', messageId: '<explicito@outlook>' } as any;
    expect(detectarSolicitudDestino(conNro, parsedStub({ inReplyTo: mid }))).toBe(sol.id);
  });

  it('si responde un correo que mandó el sistema, se suma aunque cambie el asunto', () => {
    const { sol } = solicitudDeUnCorreo('SOLICITUD DE FAO (ZENIT) - Comercial', null);
    const midEnviado = `<sent-guard-${Date.now()}@sistema>`;
    db.insert(schema.sentEmails).values({ messageId: midEnviado, solicitudId: sol.id, tipo: 'SIN_PERSONAS', ok: true }).run();
    // Contesta nuestro aviso reescribiendo el asunto como un pedido: nos está contestando a nosotros.
    const respuesta = { asunto: 'SOLICITUD DE FAO (ZENIT) - reenvio la nomina', messageId: '<resp-guard@outlook>' } as any;
    expect(detectarSolicitudDestino(respuesta, parsedStub({ inReplyTo: midEnviado }))).toBe(sol.id);
  });
});

/**
 * El 📎 del respaldo sale de `attachments_count`, y al sumar un correo a una solicitud no se
 * guardaba: los correos que traían justo la documentación que se estaba esperando aparecían con
 * 0 adjuntos. Caso real: el de PEQUES del 04/09 ("envio lo faltante") mostraba 0 y traía 3.
 *
 * Cuenta la documentación, no todo: la planilla de personas queda afuera.
 */
describe('los adjuntos de un correo que se suma a una solicitud', () => {
  it('quedan contados en el correo, para que el respaldo los muestre', async () => {
    const { sol } = crearSolicitud(null, `<adj-${Date.now()}>`);
    const email = db.insert(schema.emailMessages).values({ messageId: `<adj-resp-${Date.now()}>`, estado: 'RECEIVED', asunto: 'RE: envio lo faltante' }).returning().get();
    await sumarASolicitud(email as any, email.id, sol.id, parsedStub({ csv: 'CUIL,Nombre y Apellido\n20-31715745-2,Gomez Luis\n', pdf: true }));
    const fila = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, email.id)).get()!;
    // El PDF cuenta; la planilla que venía en el mismo correo, no.
    expect(fila.attachmentsCount).toBe(1);
  });
});

/**
 * Cuando el asunto no delata nada (locales que usan el mismo asunto para todo, como
 * "SOLICITUD DE FAO (PEQUES) EMPRESA"), lo que distingue un pedido nuevo de la documentación que
 * faltaba es la GENTE: una solicitud ya cerrada + una planilla sin una sola persona en común = otro
 * trabajo.
 */
describe('la planilla trae otro grupo de gente', () => {
  /** Solicitud con número de orden (terminada) y las personas que se le indiquen. */
  function solicitudCon(cuils: string[], asunto = 'SOLICITUD DE FAO (PEQUES) EMPRESA', nroOrden: string | null = `OA-2026-${String(Math.floor(Math.random() * 9000) + 1000)}`) {
    const mid = `<grupo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@outlook>`;
    const local = db.insert(schema.locales).values({ nombre: `PEQUES ${mid.slice(1, 24)}`, estado: 'ACTIVO' }).returning().get();
    const email = db.insert(schema.emailMessages).values({ messageId: mid, estado: 'PROCESSED', asunto }).returning().get();
    const sol = db.insert(schema.solicitudes).values({ localId: local.id, emailMessageId: email.id, estado: 'AUTORIZADA', nroOrden }).returning().get();
    // La solicitud esta "terminada" cuando se le informo el resultado al local.
    if (nroOrden) db.insert(schema.sentEmails).values({ messageId: `<inf-${mid}>`, solicitudId: sol.id, tipo: 'RESULTADO_REVISION', ok: true }).run();
    for (const c of cuils) {
      const { persona } = findOrCreatePersona({ cuil: c, nombre: 'Titular', apellido: 'DeLaSolicitud' });
      db.insert(schema.solicitudPersonas).values({ solicitudId: sol.id, personaId: persona.id }).run();
    }
    return { sol, mid };
  }
  // Nombres sin dígitos: `pareceNombreDePersona` descarta cualquier fila con un número, para no
  // tomar un teléfono de la firma por una persona. Con "Persona0" el filtro las tiraba a todas
  // y el test pasaba por la razón equivocada.
  const NOMBRES = ['Gomez Ana', 'Perez Juan', 'Silva Carlos', 'Ramos Fernando', 'Diaz Luis'];
  const planilla = (...cuils: string[]) =>
    `CUIL,Nombre y Apellido\n${cuils.map((c, i) => `${c},${NOMBRES[i % NOMBRES.length]}`).join('\n')}\n`;

  it('gente distinta y solicitud ya terminada: es un pedido nuevo', () => {
    const { sol, mid } = solicitudCon(['20-31055613-1']);
    const nuevo = { asunto: 'RE: SOLICITUD DE FAO (PEQUES) EMPRESA', messageId: '<g1@outlook>' } as any;
    expect(detectarSolicitudDestino(nuevo, parsedStub({ csv: planilla('27-38066308-8', '20-40918206-3'), inReplyTo: mid }))).toBeNull();
    expect(sol.nroOrden).toBeTruthy();
  });

  it('si UNA sola persona coincide, es la misma gestión y se suma', () => {
    const { sol, mid } = solicitudCon(['20-31456041-7']);
    const nuevo = { asunto: 'RE: SOLICITUD DE FAO (PEQUES) EMPRESA', messageId: '<g2@outlook>' } as any;
    // Reenvían la nómina corregida: repiten a la persona que ya estaba y agregan un ayudante.
    expect(detectarSolicitudDestino(nuevo, parsedStub({ csv: planilla('20-31456041-7', '27-45351525-2'), inReplyTo: mid }))).toBe(sol.id);
  });

  it('coincide por DNI aunque la solicitud la tenga cargada por CUIL', () => {
    const { sol, mid } = solicitudCon(['20-41174117-6']);
    const nuevo = { asunto: 'RE: SOLICITUD DE FAO (PEQUES) EMPRESA', messageId: '<g3@outlook>' } as any;
    const csv = `DNI,Nombre y Apellido\n41174117,Acosta Nicolas\n`;
    expect(detectarSolicitudDestino(nuevo, parsedStub({ csv, inReplyTo: mid }))).toBe(sol.id);
  });

  it('si la solicitud sigue abierta (sin número de orden), sumar gente es parte del trámite', () => {
    const { sol, mid } = solicitudCon(['20-31415833-3'], 'SOLICITUD DE FAO (PEQUES) EMPRESA', null);
    const nuevo = { asunto: 'RE: SOLICITUD DE FAO (PEQUES) EMPRESA', messageId: '<g4@outlook>' } as any;
    expect(detectarSolicitudDestino(nuevo, parsedStub({ csv: planilla('27-38066308-8'), inReplyTo: mid }))).toBe(sol.id);
  });

  it('sin planilla legible no se opina: sigue siendo del hilo', () => {
    const { sol, mid } = solicitudCon(['20-33792645-8']);
    const nuevo = { asunto: 'RE: SOLICITUD DE FAO (PEQUES) EMPRESA', messageId: '<g5@outlook>' } as any;
    expect(detectarSolicitudDestino(nuevo, parsedStub({ inReplyTo: mid }))).toBe(sol.id);
  });

  it('responder un correo del sistema se suma igual, aunque la gente sea toda nueva', () => {
    // Es el caso de siempre: le pedimos la nómina y la manda. Esa gente NO está en la solicitud.
    const { sol } = solicitudCon(['20-31464950-8']);
    const midEnviado = `<sent-grupo-${Date.now()}@sistema>`;
    db.insert(schema.sentEmails).values({ messageId: midEnviado, solicitudId: sol.id, tipo: 'RESULTADO_REVISION', ok: true }).run();
    const respuesta = { asunto: 'RE: Resultado de la revisión', messageId: '<g6@outlook>' } as any;
    expect(detectarSolicitudDestino(respuesta, parsedStub({ csv: planilla('27-38066308-8'), inReplyTo: midEnviado }))).toBe(sol.id);
  });

  it('con el número de orden citado se suma igual, aunque la gente sea toda nueva', () => {
    const { sol } = solicitudCon(['20-31863875-3'], 'SOLICITUD DE FAO (PEQUES) EMPRESA', 'OA-2026-7311');
    const nuevo = { asunto: 'Agrego personal a la orden OA-2026-7311', messageId: '<g7@outlook>' } as any;
    expect(detectarSolicitudDestino(nuevo, parsedStub({ csv: planilla('27-45351525-2') }))).toBe(sol.id);
  });
});

/**
 * El caso que llenaba el respaldo de ruido: un correo con documentación se suma a una solicitud
 * que se creó hace diez minutos y que nadie revisó todavía. Eso es el curso normal del trámite,
 * no hay nada que avisar. Antes caía en el respaldo con "ya terminada: re-revisá" —falso— y la
 * pantalla lo mostraba como un error rojo ("No se pudo procesar") aunque la documentación se
 * hubiera sumado bien.
 */
describe('sumar a una solicitud que todavía está en trámite', () => {
  it('no va al respaldo: se procesa y listo', async () => {
    const { sol } = crearSolicitud('OA-2026-9111', `<abierta-${Date.now()}>`);
    // Sin correo de resultado enviado: la solicitud tiene número, pero nadie la terminó.
    const email = db.insert(schema.emailMessages).values({ messageId: `<resp-abierta-${Date.now()}>`, estado: 'RECEIVED', asunto: 'RE: orden OA-2026-9111' }).returning().get();
    await sumarASolicitud(email as any, email.id, sol.id, parsedStub({ csv: 'CUIL,Nombre y Apellido\n20-40918206-3,Ramos Fernando\n' }));
    const fila = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, email.id)).get()!;
    expect(fila.estado, 'no tiene por qué ir al respaldo').toBe('PROCESSED');
    expect(fila.error).toBeNull();
    expect(fila.replySolicitudId).toBe(sol.id);
  });
});

/**
 * La misma cosa no puede estar en dos lados. Un correo que se sumó a una solicitud ya informada
 * antes aparecía en el respaldo Y en la solicitud, y en el respaldo el botón "Procesar" no tenía
 * nada que hacer: rehacía el mismo merge y lo dejaba igual. Ahora el aviso es de la solicitud.
 */
describe('dónde queda el aviso de re-revisar', () => {
  function solicitudInformada() {
    const { sol } = crearSolicitud('OA-2026-9222', `<inf2-${Date.now()}>`);
    db.insert(schema.sentEmails).values({ messageId: `<res-${Date.now()}@sistema>`, solicitudId: sol.id, tipo: 'RESULTADO_REVISION', ok: true }).run();
    return sol;
  }

  it('la solicitud queda marcada y el correo NO queda en el respaldo', async () => {
    const sol = solicitudInformada();
    const email = db.insert(schema.emailMessages).values({ messageId: `<doc-${Date.now()}>`, estado: 'RECEIVED', asunto: 'RE: orden OA-2026-9222' }).returning().get();
    await sumarASolicitud(email as any, email.id, sol.id, parsedStub({ pdf: true }));

    expect(db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, email.id)).get()!.estado).toBe('PROCESSED');
    expect(db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, sol.id)).get()!.docNuevaAt).toBeTruthy();
  });

  it('procesar dos veces el mismo correo no lo manda al respaldo', async () => {
    const sol = solicitudInformada();
    const email = db.insert(schema.emailMessages).values({ messageId: `<doc2-${Date.now()}>`, estado: 'RECEIVED', asunto: 'RE: orden OA-2026-9222' }).returning().get();
    await sumarASolicitud(email as any, email.id, sol.id, parsedStub({ pdf: true }));
    await sumarASolicitud(email as any, email.id, sol.id, parsedStub({ pdf: true }));
    expect(db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, email.id)).get()!.estado).toBe('PROCESSED');
  });

  it('si la solicitud NO fue informada, no se marca nada', async () => {
    const { sol } = crearSolicitud('OA-2026-9333', `<abierta2-${Date.now()}>`);
    const email = db.insert(schema.emailMessages).values({ messageId: `<doc3-${Date.now()}>`, estado: 'RECEIVED', asunto: 'RE: orden OA-2026-9333' }).returning().get();
    await sumarASolicitud(email as any, email.id, sol.id, parsedStub({ pdf: true }));
    expect(db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, sol.id)).get()!.docNuevaAt).toBeFalsy();
  });
});

/**
 * Caso reportado (15/09): el local contesta "Gracias" al mail del resultado y la solicitud quedaba
 * marcada con "documentación nueva", en revisión. Para sacarle el cartel no había forma más que
 * mandarla a la papelera, y ahí desaparecía la FAO entera del listado.
 */
describe('una respuesta de cortesía no manda la solicitud a revisar', () => {
  function solicitudInformada(nro: string) {
    const { sol } = crearSolicitud(nro, `<cort-${Date.now()}-${Math.random().toString(36).slice(2, 6)}>`);
    db.insert(schema.sentEmails).values({ messageId: `<res-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@sistema>`, solicitudId: sol.id, tipo: 'RESULTADO_REVISION', ok: true }).run();
    return sol;
  }
  const correo = (asunto: string) =>
    db.insert(schema.emailMessages).values({ messageId: `<c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}>`, estado: 'RECEIVED', asunto }).returning().get();
  const solAct = (id: number) => db.select().from(schema.solicitudes).where(eq(schema.solicitudes.id, id)).get()!;

  it('un "Gracias" sin adjuntos ni personas no la marca', async () => {
    const sol = solicitudInformada('OA-2026-9440');
    const email = correo('RE: Orden OA-2026-9440 — Resultado de la revisión');
    await sumarASolicitud(email as any, email.id, sol.id, parsedStub());

    expect(solAct(sol.id).docNuevaAt, 'un gracias no es documentación nueva').toBeFalsy();
    const fila = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, email.id)).get()!;
    expect(fila.estado).toBe('PROCESSED');
    expect(fila.replySolicitudId, 'igual queda guardado en la solicitud').toBe(sol.id);
    expect(fila.error).toBeNull();
  });

  it('el comentario dice que fue una respuesta, no que llegó documentación', async () => {
    const sol = solicitudInformada('OA-2026-9441');
    const email = correo('RE: gracias');
    await sumarASolicitud(email as any, email.id, sol.id, parsedStub());
    const c = db.select().from(schema.comentarios).where(eq(schema.comentarios.solicitudId, sol.id)).all().at(-1)!;
    expect(c.contenido).toMatch(/sin documentación nueva/i);
    expect(c.contenido).not.toMatch(/Re-revisá/);
  });

  it('si trae un adjunto sí la marca', async () => {
    const sol = solicitudInformada('OA-2026-9442');
    const email = correo('RE: mando lo que falta');
    await sumarASolicitud(email as any, email.id, sol.id, parsedStub({ pdf: true }));
    expect(solAct(sol.id).docNuevaAt).toBeTruthy();
  });

  it('si trae una persona nueva también', async () => {
    const sol = solicitudInformada('OA-2026-9443');
    const email = correo('RE: agrego a uno');
    await sumarASolicitud(email as any, email.id, sol.id, parsedStub({ csv: 'CUIL,Nombre y Apellido\n27-45351525-2,Espinoza Lourdes\n' }));
    expect(solAct(sol.id).docNuevaAt).toBeTruthy();
  });
});

/**
 * Cómo escribe el número de orden el que lo retipea en vez de copiarlo. Antes se exigía el formato
 * exacto, así que cualquiera de estas variantes abría una solicitud nueva en lugar de sumarse a la
 * que el remitente estaba citando.
 */
describe('buscarNroOrden', () => {
  const canon = 'OA-2026-0181';
  for (const v of [
    'OA-2026-0181',
    'oa-2026-0181',
    'OA 2026 0181',
    'OA2026 0181',
    'OA20260181',
    'OA-2026 0181',
    'OA.2026.0181',
    'OA-2026-181',
    'OA_2026_0181',
    'Buenas, mando lo de la orden OA-2026-181. Saludos',
    'RE: Orden OA-2026-0181 — Resultado de la revisión — TIENDA',
  ]) {
    it(`reconoce "${v}"`, () => expect(buscarNroOrden(v)).toBe(canon));
  }

  it('no inventa un número donde no hay', () => {
    for (const v of [
      '',
      'Gracias!',
      'CUIL 20-33163078-1',                 // un documento no es un número de orden
      'tel 011 2026 0181',                  // sin el prefijo OA no vale
      'la orden 181',
    ]) {
      expect(buscarNroOrden(v), v).toBeNull();
    }
  });

  it('el número escrito flojo llega igual a la solicitud correcta', () => {
    // Un número que no use ningún otro test: la base es compartida entre ellos.
    const { sol } = crearSolicitud('OA-2026-6604', `<flojo-${Date.now()}>`);
    const email = { asunto: 'Mando la documentacion', messageId: '<f1>' } as any;
    const parsed = { ...parsedStub(), text: 'Buenas, es por la orden OA 2026 6604. Gracias' } as any;
    expect(detectarSolicitudDestino(email, parsed)).toBe(sol.id);
  });
});

/**
 * El número de orden es la señal más fuerte, pero nadie verificaba que quien lo cita sea el dueño
 * de esa orden. Un número mal tipeado metía la documentación —y la gente— en la solicitud de otro
 * local, y esa gente quedaba habilitada a entrar bajo un local que no la contrató.
 */
describe('el correo cita la orden de otro local', () => {
  /** Un local con su historial de correos, que es de donde se deduce de quién escribe una dirección. */
  function localConRemitente(nombre: string, addr: string) {
    const local = db.insert(schema.locales).values({ nombre, estado: 'ACTIVO' }).returning().get();
    db.insert(schema.emailMessages).values({
      messageId: `<hist-${Date.now()}-${Math.random().toString(36).slice(2, 7)}>`, estado: 'PROCESSED',
      remitente: `Encargado <${addr}>`, asunto: `SOLICITUD DE FAO (${nombre})`, localId: local.id,
    }).run();
    return local;
  }

  it('no lo suma a la solicitud ajena: queda para que decida una persona', async () => {
    const t2 = Math.random().toString(36).slice(2, 7);
    const propio = localConRemitente(`PROPIO ${t2}`, `encargado${t2}@propio.com`);
    const ajeno = db.insert(schema.locales).values({ nombre: `AJENO ${t2}`, estado: 'ACTIVO' }).returning().get();
    const solAjena = db.insert(schema.solicitudes).values({ localId: ajeno.id, estado: 'PENDIENTE', nroOrden: `OA-2026-33${t2.slice(0, 2).replace(/\D/g, '1')}` }).returning().get();

    const email = { id: 1, remitente: `Encargado <encargado${t2}@propio.com>`, asunto: 'Mando documentacion' } as any;
    const c = conflictoDeLocal(email, solAjena.id);
    expect(c, 'tiene que detectar el cruce').toBeTruthy();
    expect(c!.orden).toBe(ajeno.nombre);
    expect(c!.remitente).toBe(propio.nombre);
    // La dirección va también: el dominio suele decir de qué local es.
    expect(c!.direccion).toBe(`encargado${t2}@propio.com`);
  });

  it('si la orden es del mismo local del remitente, no hay conflicto', () => {
    const t2 = Math.random().toString(36).slice(2, 7);
    const local = localConRemitente(`MISMO ${t2}`, `enc${t2}@mismo.com`);
    const sol = db.insert(schema.solicitudes).values({ localId: local.id, estado: 'PENDIENTE' }).returning().get();
    const email = { id: 1, remitente: `Otro <enc${t2}@mismo.com>`, asunto: 'x' } as any;
    expect(conflictoDeLocal(email, sol.id)).toBeNull();
  });

  it('un remitente sin historial no se juzga', () => {
    const t2 = Math.random().toString(36).slice(2, 7);
    const local = db.insert(schema.locales).values({ nombre: `SinHist ${t2}`, estado: 'ACTIVO' }).returning().get();
    const sol = db.insert(schema.solicitudes).values({ localId: local.id, estado: 'PENDIENTE' }).returning().get();
    const email = { id: 1, remitente: `Nuevo <nuevo${t2}@nadie.com>`, asunto: 'x' } as any;
    expect(conflictoDeLocal(email, sol.id)).toBeNull();
  });

  /** Las casillas que reenvían por varios locales (paseocentral@gmail) no se pueden atribuir a uno. */
  it('un remitente que escribe por varios locales tampoco', () => {
    const t2 = Math.random().toString(36).slice(2, 7);
    const addr = `reenvia${t2}@gmail.com`;
    localConRemitente(`UNO ${t2}`, addr);
    localConRemitente(`DOS ${t2}`, addr);
    expect(localDelRemitente(`Reenvio <${addr}>`)).toBeNull();
  });
});


/**
 * Una solicitud borrada no puede ser destino de nada.
 *
 * Caso real (47 Avenida, 05/10/2026): la OA-2026-0221 salió vacía en septiembre y se borró. El
 * local contestó en el mismo hilo con 6 PDF; el sistema reconoció el hilo, quiso sumarlo a esa
 * solicitud y, al encontrarla borrada, dejó el correo en el respaldo. El botón "Crear solicitud"
 * volvía a caer en la misma rama, así que no había forma de destrabarlo desde la pantalla, y el
 * respaldo mostraba "0 adjuntos" porque esa rama volvía antes de contarlos: se descartó a mano
 * como si fuera correspondencia vacía.
 */
describe('solicitud borrada en el hilo', () => {
  const borrar = (solId: number) =>
    db.update(schema.solicitudes).set({ deletedAt: new Date().toISOString() }).where(eq(schema.solicitudes.id, solId)).run();

  it('no es destino por número de orden: el correo entra como pedido nuevo', () => {
    const { sol } = crearSolicitud('OA-2026-7001', `<borr1-${Date.now()}>`);
    borrar(sol.id);
    const email = { asunto: 'RE: orden OA-2026-7001', messageId: '<b1>' } as any;
    expect(detectarSolicitudDestino(email, parsedStub())).toBeNull();
  });

  it('no es destino por el hilo, aunque el correo original sí haya generado esa solicitud', () => {
    const mid = `<borr2-${Date.now()}>`;
    const { sol } = crearSolicitud(null, mid);
    borrar(sol.id);
    const email = { asunto: 'RE: RV: Nómina', messageId: '<b2>' } as any;
    expect(detectarSolicitudDestino(email, parsedStub({ inReplyTo: mid }))).toBeNull();
  });

  it('no es destino aunque la respuesta sea a un correo que mandamos nosotros', () => {
    const { sol } = crearSolicitud('OA-2026-7002', `<borr3-${Date.now()}>`);
    const enviadoMid = `<sent-borr-${Date.now()}@sistema>`;
    db.insert(schema.sentEmails).values({ messageId: enviadoMid, solicitudId: sol.id, tipo: 'RESULTADO_REVISION', ok: true }).run();
    borrar(sol.id);
    const email = { asunto: 'sin orden', messageId: '<b3>' } as any;
    expect(detectarSolicitudDestino(email, parsedStub({ inReplyTo: enviadoMid }))).toBeNull();
  });

  it('una solicitud VIVA en el hilo sigue siendo destino', () => {
    const mid = `<viva-${Date.now()}>`;
    const { sol } = crearSolicitud(null, mid);
    const email = { asunto: 'RE: documentación', messageId: '<b4>' } as any;
    expect(detectarSolicitudDestino(email, parsedStub({ inReplyTo: mid }))).toBe(sol.id);
  });

  /** La red de seguridad: si igual se llega ahí, el respaldo tiene que decir cuántos papeles trae. */
  it('si se llama directo, deja la cuenta de adjuntos y lo dice en el motivo', async () => {
    const { sol } = crearSolicitud(null, `<borr5-${Date.now()}>`);
    borrar(sol.id);
    const email = db.insert(schema.emailMessages).values({ messageId: `<resp-borr-${Date.now()}>`, estado: 'RECEIVED', asunto: 'RE: RV: Nómina' }).returning().get();

    await sumarASolicitud(email as any, email.id, sol.id, parsedStub({ pdf: true }));

    const fila = db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, email.id)).get()!;
    expect(fila.estado).toBe('NEEDS_REVIEW');
    expect(fila.attachmentsCount).toBe(1);
    expect(fila.error).toContain('1 documento');
  });
});
