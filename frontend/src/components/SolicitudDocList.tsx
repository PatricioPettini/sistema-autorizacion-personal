import { useState } from 'react';
import { useToast } from '../ui';
import { api } from '../api';
import { useAuth } from '../auth';

export interface SolDocItem {
  tipoId: number; codigo: string; nombre: string; categoria: string; obligatorio: boolean;
  presente: boolean; tieneArchivo: boolean; soldocId: number | null; originalFilename: string | null;
  verificacion: 'PENDIENTE' | 'VERIFICADO' | 'RECHAZADO'; notaVerificacion: string | null;
  esExtra: boolean;
}
export interface SolDocStatus { items: SolDocItem[]; faltantes: string[]; categoriasPresentes: string[]; requiereCategoria: boolean; }

const CAT_LABEL: Record<string, string> = { EMPRESA: 'empresa', MONOTRIBUTISTA: 'monotributo', AMBOS: 'todos' };

/**
 * Documentación de alcance SOLICITUD: se carga y aprueba UNA sola vez para todo el grupo
 * (Formulario 931, Pago de ARCA, Cláusula, Seguro de Vida). Vale para todas las personas.
 */
export function SolicitudDocList({ solicitudId, docStatus, onChanged, onQuitarExtra }: {
  solicitudId: number; docStatus?: SolDocStatus; onChanged?: () => void;
  onQuitarExtra?: (tipoId: number, nombre: string) => void;
}) {
  const { notify } = useToast();
  const isAdmin = useAuth().user?.rol === 'ADMIN';
  const [busy, setBusy] = useState<number | null>(null);
  if (!docStatus || docStatus.items.length === 0) {
    return <p className="muted">Esta solicitud no tiene documentación de grupo (definí el tipo de contratista de las personas).</p>;
  }

  const verificar = async (it: SolDocItem, estado: 'VERIFICADO' | 'RECHAZADO' | 'PENDIENTE') => {
    setBusy(it.tipoId);
    try {
      await api.post('/documentos/solicitud-verificar', { solicitudId, tipoDocumentoId: it.tipoId, estado });
      notify(estado === 'VERIFICADO' ? 'Documento aprobado para toda la solicitud.' : estado === 'RECHAZADO' ? 'Documento marcado como faltante.' : 'Aprobación deshecha.', 'success');
      onChanged?.();
    } catch (e: any) { notify(e.message, 'error'); } finally { setBusy(null); }
  };

  return (
    <ul className="doc-list">
      {docStatus.items.map((it) => {
        const cls = it.verificacion === 'RECHAZADO' ? 'no' : it.presente ? 'ok' : (it.obligatorio ? 'no' : 'warn');
        const url = it.soldocId ? `/api/documentos/solicitud-doc/${it.soldocId}/archivo` : null;
        return (
          <li key={it.tipoId} style={{ alignItems: 'flex-start' }}>
            <span className={`check ${cls}`}>{it.presente ? '✓' : '✕'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {it.nombre}
                {it.esExtra && <span className="chip" title="Requisito agregado a esta solicitud">extra</span>}
                {it.categoria !== 'AMBOS' && <span className="chip" title="Aplica a este tipo de contratista">{CAT_LABEL[it.categoria] ?? it.categoria}</span>}
                {it.verificacion === 'VERIFICADO' && <span className="badge green">✓ Aprobado</span>}
                {it.verificacion === 'RECHAZADO' && <span className="badge red">Rechazado</span>}
                {it.tieneArchivo && url && <a className="btn ghost sm" href={url} target="_blank" rel="noreferrer">Ver archivo</a>}
                {it.esExtra && onQuitarExtra && <button className="btn ghost sm" onClick={() => onQuitarExtra(it.tipoId, it.nombre)}>Quitar</button>}
              </div>
              {it.originalFilename && <div className="muted" style={{ fontSize: 12.5 }}>Archivo: {it.originalFilename}</div>}
              {it.notaVerificacion && <div className="muted" style={{ fontSize: 12.5 }}>Nota: {it.notaVerificacion}</div>}

              {isAdmin && (
                <div className="btn-row" style={{ marginTop: 8, alignItems: 'center' }}>
                  {it.verificacion === 'PENDIENTE' ? (
                    <>
                      <button className="btn success sm" disabled={busy === it.tipoId} onClick={() => verificar(it, 'VERIFICADO')}>✓ Aprobar</button>
                      <button className="btn danger sm" disabled={busy === it.tipoId} onClick={() => verificar(it, 'RECHAZADO')}>✕ Falta / Rechazar</button>
                    </>
                  ) : (
                    <button className="btn ghost sm" disabled={busy === it.tipoId} onClick={() => verificar(it, 'PENDIENTE')}>Deshacer</button>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
