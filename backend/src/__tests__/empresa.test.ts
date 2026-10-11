/**
 * De qué empresa habla el papel. El caso que importa es el certificado de ART: adentro del mismo
 * documento están el CUIT del empleador (arriba) y el de la aseguradora (en el pie de cada hoja).
 * Informar el de la aseguradora vuelve inútil el dato, porque lo que hay que poder notar es que el
 * local mandó la ART de OTRA empresa.
 */
import { describe, it, expect } from 'vitest';
import { extractEmpresa } from '../modules/ai/empresa.js';

/** Texto tal como sale de pdfjs en un certificado real de Serena ART (el orden viene desordenado). */
const CERTIFICADO_ART =
  ': Desde:   14/05/2024   Hasta:   31/05/2027  : 23214  : 30-71680837-4  :   DELTA FACILITY SERVICES ' +
  'Empresa  C.U.I.T  Contrato  Vigencia  Poliza Digital SRT:   : 5562671  Claudio Bravo Gerente General ' +
  'Serena ART S.A.U.  SEGURO DE RIESGOS DE TRABAJO  CERTIFICADO DE COBERTURA  Fecha de Emision:   18/09/2026  ' +
  'N de folio: 1080880 hoja 1/2  Serena ART S.A.U. |   CUIT: 30-71311482-7 |   AV. Leandro N. Alem 1050';

describe('de qué empresa es el papel', () => {
  it('toma el CUIT del empleador y no el de la aseguradora que emite', () => {
    const r = extractEmpresa(CERTIFICADO_ART);
    expect(r).not.toBeNull();
    // DELTA FACILITY SERVICES, el contratante. El 30713114827 es Serena ART.
    expect(r!.cuit).toBe('30716808374');
    expect(r!.nombre).toContain('DELTA FACILITY SERVICES');
  });

  it('entiende la etiqueta escrita con puntos y el valor antes de su etiqueta', () => {
    // Las dos cosas juntas son lo que hacía fallar el lector anterior, que buscaba "cuit" seguido
    // del número.
    const r = extractEmpresa('33-69501635-8 : LA CASA S.R.L. Empresa C.U.I.T Contrato');
    expect(r!.cuit).toBe('33695016358');
  });

  it('lee la razón social clásica', () => {
    const r = extractEmpresa('CUIT: 30714032433 Razon Social: GMRA S.A.U. Nomina de personal');
    expect(r!.cuit).toBe('30714032433');
    expect(r!.nombre).toBe('GMRA S.A.U.');
  });

  it('sin ninguna etiqueta, se queda con el primer CUIT: el encabezado habla del contratante', () => {
    const r = extractEmpresa('Certificado de cobertura 30-71403243-3 ... pie de pagina CUIT 30-71311482-7');
    expect(r!.cuit).toBe('30714032433');
  });

  it('no confunde un CUIL de persona con el CUIT de la empresa', () => {
    // 20/23/24/27 son de persona física: no son la empresa.
    expect(extractEmpresa('CUIL 20-33163078-1 Perez Juan')).toBeNull();
  });

  it('devuelve null cuando el papel no habla de ninguna empresa', () => {
    expect(extractEmpresa('un texto sin datos de empresa')).toBeNull();
    expect(extractEmpresa(null)).toBeNull();
  });
});
