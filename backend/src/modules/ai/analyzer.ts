import { getPersonaDocStatus, type PersonaDocStatus } from '../documentos/service.js';

export interface PersonaAnalysis {
  estadoDocumental: 'COMPLETO' | 'INCOMPLETO';
  faltantes: string[];
  vencidos: string[];
  porVencer: string[];
  observaciones: string[];
  recomendacion: 'APTO_PARA_REVISION' | 'REQUIERE_CORRECCION' | 'REQUIERE_REVISION_MANUAL';
  recomendacionTexto: string;
  confianza: number | null;
  docStatus: PersonaDocStatus;
}

/**
 * Analizador local basado en reglas. Es determinístico y NO inventa datos:
 * si algo falta o no se pudo leer, lo marca; nunca autoriza automáticamente.
 * La capa está abstraída para poder enchufar en el futuro un analizador
 * externo (API de Claude/OpenAI) sin cambiar el resto del sistema.
 */
export function analyzePersona(personaId: number): PersonaAnalysis {
  const docStatus = getPersonaDocStatus(personaId);
  const observaciones: string[] = [];

  if (docStatus.requiereCategoria) {
    observaciones.push('Falta definir si el contratista es Empresa o Monotributista para saber qué documentación se exige.');
  }
  if (docStatus.faltantes.length > 0) {
    observaciones.push(`Falta documentación obligatoria: ${docStatus.faltantes.join(', ')}.`);
  }
  if (docStatus.vencidos.length > 0) {
    observaciones.push(`Documentación con emisión mayor a 30 días (vencida): ${docStatus.vencidos.join(', ')}.`);
  }
  if (docStatus.porVencer.length > 0) {
    observaciones.push(`Documentación próxima a superar los 30 días de emisión: ${docStatus.porVencer.join(', ')}.`);
  }
  const sinFecha = docStatus.items.filter((i) => i.presente && i.controlaEmision && i.vigencia === 'SIN_FECHA');
  if (sinFecha.length > 0) {
    observaciones.push(`No se pudo determinar la fecha de emisión de: ${sinFecha.map((i) => i.nombre).join(', ')}. Verificar que no supere los 30 días.`);
  }
  if (observaciones.length === 0) {
    observaciones.push('No se detectaron inconsistencias evidentes.');
  }

  let recomendacion: PersonaAnalysis['recomendacion'];
  let recomendacionTexto: string;
  if (docStatus.requiereCategoria) {
    recomendacion = 'REQUIERE_REVISION_MANUAL';
    recomendacionTexto = 'Definí primero si es Empresa o Monotributista para evaluar la documentación exigida.';
  } else if (docStatus.faltantes.length > 0 || docStatus.vencidos.length > 0) {
    recomendacion = 'REQUIERE_CORRECCION';
    recomendacionTexto = 'Documentación incompleta o con más de 30 días de emisión. Requiere corrección antes de autorizar.';
  } else if (sinFecha.length > 0) {
    recomendacion = 'REQUIERE_REVISION_MANUAL';
    recomendacionTexto = 'Documentación presente, pero hay fechas de emisión que requieren verificación manual.';
  } else {
    recomendacion = 'APTO_PARA_REVISION';
    recomendacionTexto = 'Documentación aparentemente completa. Requiere decisión de Seguridad.';
  }

  // Confianza: promedio de confianzas de clasificación disponibles (si las hay).
  const confs = docStatus.items
    .map((i) => i.versionId)
    .filter(Boolean).length;
  const confianza = confs > 0 ? null : null; // Se completará cuando el OCR aporte confianzas.

  return {
    estadoDocumental: docStatus.estadoDocumental,
    faltantes: docStatus.faltantes,
    vencidos: docStatus.vencidos,
    porVencer: docStatus.porVencer,
    observaciones,
    recomendacion,
    recomendacionTexto,
    confianza,
    docStatus,
  };
}
