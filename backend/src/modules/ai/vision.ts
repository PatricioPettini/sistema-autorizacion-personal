import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * Lee la lista de personas de una CAPTURA de pantalla.
 *
 * Existe porque muchos locales mandan la nómina como imagen —una foto del WhatsApp, un recorte de
 * una planilla— y ahí no hay texto que leer: el sistema las rechaza y alguien las tipea a mano.
 *
 * Es lo único del sistema que sale a Internet, y manda datos de personas (documento y nombre) a la
 * API de Anthropic. Por eso está apagado salvo que haya una API key configurada, y por eso NO da
 * de alta a nadie: devuelve una lista para que el que revisa la mire, la corrija y la confirme.
 * Igual que el importador de PDF, que usa la misma tabla.
 */

/**
 * El formato de la respuesta se le exige al modelo con un JSON Schema (`output_config.format`), y
 * además se valida acá con zod: el schema lo hace devolver la forma correcta, la validación nos
 * protege de confiar en algo que no la tenga.
 */
const ESQUEMA = {
  type: 'object',
  properties: {
    personas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cuil: { type: 'string', description: 'CUIL de 11 dígitos, sin guiones. Vacío si la imagen no lo muestra.' },
          dni: { type: 'string', description: 'DNI de 7 u 8 dígitos, sin puntos. Vacío si la imagen no lo muestra.' },
          apellido: { type: 'string', description: 'Apellido. Vacío si no se distingue del nombre.' },
          nombre: { type: 'string', description: 'Nombre de pila. Vacío si no se distingue del apellido.' },
        },
        required: ['cuil', 'dni', 'apellido', 'nombre'],
        additionalProperties: false,
      },
    },
    nota: { type: 'string', description: 'Una línea sobre lo que se ve: qué planilla es, o qué no se pudo leer.' },
  },
  required: ['personas', 'nota'],
  additionalProperties: false,
} as const;

const Respuesta = z.object({
  personas: z.array(z.object({
    cuil: z.string(),
    dni: z.string(),
    apellido: z.string(),
    nombre: z.string(),
  })),
  nota: z.string(),
});

export type PersonaDeImagen = z.infer<typeof Respuesta>['personas'][number];

const INSTRUCCIONES = `Sos parte de un sistema de autorización de ingreso de personal a un shopping.

Te paso una captura de pantalla que mandó un local con la gente que quiere autorizar. Extraé UNA
FILA POR PERSONA con su documento y su nombre.

Reglas, en orden de importancia:

1. NO INVENTES. Si un dígito no se lee, dejá ese campo vacío antes que adivinarlo. Un documento
   equivocado autoriza a entrar a una persona que no es.
2. Copiá exactamente lo que se ve. No completes nombres abreviados ni corrijas la ortografía.
3. Los números que NO son documentos no van: importes, teléfonos, números de póliza, de contrato,
   de folio, códigos de barras, fechas, totales.
4. Un CUIL tiene 11 dígitos y empieza con 20, 23, 24 o 27 para personas. Un DNI tiene 7 u 8.
   Si la imagen muestra el CUIL, poné el CUIL; si muestra el DNI, poné el DNI; si muestra los dos,
   poné los dos.
5. Mirá el encabezado de la tabla para saber qué columna es el apellido y cuál el nombre. Si no hay
   encabezado y no podés distinguirlos, poné todo en "apellido" y dejá "nombre" vacío: lo completa
   a mano quien revisa.
6. Si la imagen no es una lista de personas, devolvé la lista vacía y explicá en "nota" qué es.`;

/** Formatos que acepta la API. Un archivo de otro tipo se rechaza antes de gastar la llamada. */
const TIPOS = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export interface LecturaDeImagen {
  personas: PersonaDeImagen[];
  nota: string;
  /** Para poder mostrar cuánto salió cada lectura sin tener que ir a la consola de Anthropic. */
  tokens: { entrada: number; salida: number };
}

export function visionDisponible(): boolean {
  return !!env.ia.apiKey;
}

export async function leerPersonasDeImagen(
  imagen: Buffer,
  mediaType: string,
  instruccion?: string,
): Promise<LecturaDeImagen> {
  if (!visionDisponible()) {
    throw new Error('La lectura de capturas no está configurada (falta ANTHROPIC_API_KEY).');
  }
  if (!TIPOS.has(mediaType)) {
    throw new Error(`Formato no soportado (${mediaType}). Mandá una imagen PNG, JPG, GIF o WEBP.`);
  }

  const client = new Anthropic({ apiKey: env.ia.apiKey });
  const pedido = instruccion?.trim()
    ? `${INSTRUCCIONES}\n\nAdemás, el que revisa aclara: ${instruccion.trim()}`
    : INSTRUCCIONES;

  const response = await client.messages.create({
    model: env.ia.modelo,
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType as 'image/png', data: imagen.toString('base64') } },
        { type: 'text', text: pedido },
      ],
    }],
    output_config: { format: { type: 'json_schema', schema: ESQUEMA as unknown as Record<string, unknown> } },
  });

  const texto = response.content.find((b) => b.type === 'text');
  const parsed = texto ? Respuesta.safeParse(JSON.parse(texto.text)) : null;
  if (!parsed?.success) {
    logger.warn({ stopReason: response.stop_reason }, 'La lectura de la captura no devolvió una lista utilizable.');
    throw new Error('No se pudo leer la captura. Probá con una imagen más nítida, o cargá la gente a mano.');
  }

  return {
    personas: parsed.data.personas,
    nota: parsed.data.nota,
    tokens: { entrada: response.usage.input_tokens, salida: response.usage.output_tokens },
  };
}
