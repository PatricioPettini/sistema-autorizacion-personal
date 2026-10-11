import { useState } from 'react';
import { Badge, useToast } from '../ui';
import { api, fmtSoloFecha } from '../api';
import { useAuth } from '../auth';

interface Item {
  tipoId: number; codigo: string; nombre: string; obligatorio: boolean; presente: boolean; tieneArchivo: boolean;
  versionId: number | null; version: number | null; fechaEmision: string | null; fechaVencimiento: string | null;
  diasParaVencer: number | null; vigencia: string | null; documentoId: number | null; controlaEmision: boolean;
  esRequisitoExtra?: boolean;
  verificacion: 'PENDIENTE' | 'VERIFICADO' | 'RECHAZADO'; notaVerificacion: string | null; clasificacionConfianza: number | null;
}
interface DocStatus { items: Item[]; faltantes: string[]; estadoDocumental: string; completos: number; totalObligatorios: number; categoria?: string | null; requiereCategoria?: boolean; }

export function DocList({ docStatus, personaId, onChanged, onQuitarRequisito }: {
  docStatus?: DocStatus;
  personaId?: number;
  onChanged?: () => void;
  onQuitarRequisito?: (tipoId: number, nombre: string) => void;
}) {
  const { notify } = useToast();
  const isAdmin = useAuth().user?.rol === 'ADMIN';
  const [busy, setBusy] = useState<number | null>(null);
  if (!docStatus) return <p className="muted">Sin información.</p>;

  const verificar = async (it: Item, estado: 'VERIFICADO' | 'RECHAZADO' | 'PENDIENTE') => {
    if (!personaId) return;
    setBusy(it.tipoId);
    try {
      await api.post('/documentos/verificar', { personaId, tipoDocumentoId: it.tipoId, estado });
      notify(estado === 'VERIFICADO' ? 'Documento aprobado.' : estado === 'RECHAZADO' ? 'Documento marcado como faltante/rechazado.' : 'Aprobación deshecha.', 'success');
      onChanged?.();
    } catch (e: any) { notify(e.message, 'error'); } finally { setBusy(null); }
  };

  const reclasificar = async (it: Item, nuevoTipoId: number) => {
    if (!it.documentoId || nuevoTipoId === it.tipoId) return;
    setBusy(it.tipoId);
    try {
      await api.post(`/documentos/${it.documentoId}/reclasificar`, { tipoDocumentoId: nuevoTipoId });
      notify('Documento reclasificado.', 'success');
      onChanged?.();
    } catch (e: any) { notify(e.message, 'error'); } finally { setBusy(null); }
  };

  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <Badge estado={docStatus.estadoDocumental} />{' '}
        {/* Sin tipo definido la lista de requisitos está vacía, y "0 de 0" se lee como "no falta
            nada". Lo que falta es el dato que decide QUÉ pedirle. */}
        {docStatus.requiereCategoria
          ? <span className="muted">falta definir el tipo de contratista</span>
          : <span className="muted">{docStatus.completos} de {docStatus.totalObligatorios} obligatorios</span>}
      </div>
      {docStatus.requiereCategoria && (
        <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>
          Hasta que se defina si es <strong>empresa</strong> o <strong>monotributista</strong> no se
          sabe qué documentación pedirle, así que la lista está vacía. Se define en la solicitud.
        </p>
      )}
      <ul className="doc-list">
        {docStatus.items.map((it) => {
          const cls = it.verificacion === 'RECHAZADO' ? 'no'
            : it.presente ? (it.vigencia === 'VENCIDO' ? 'warn' : 'ok')
            : (it.obligatorio ? 'no' : 'warn');
          return (
            <li key={it.tipoId} style={{ alignItems: 'flex-start' }}>
              <span className={`check ${cls}`}>{it.presente ? '✓' : '✕'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {it.nombre}
                  {it.esRequisitoExtra && <span className="chip" title="Requisito agregado a esta persona">extra</span>}
                  {!it.obligatorio && <span className="chip">opcional</span>}
                  {it.verificacion === 'VERIFICADO' && <span className="badge green">✓ Aprobado</span>}
                  {it.verificacion === 'RECHAZADO' && <span className="badge red">Rechazado</span>}
                  {it.esRequisitoExtra && onQuitarRequisito && (
                    <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => onQuitarRequisito(it.tipoId, it.nombre)}>Quitar requisito</button>
                  )}
                </div>
                {it.notaVerificacion && <div className="muted" style={{ fontSize: 12.5 }}>Nota: {it.notaVerificacion}</div>}

                {/* Acciones de aprobación manual (el "check" de Seguridad) */}
                {personaId && isAdmin && (
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
    </>
  );
}
