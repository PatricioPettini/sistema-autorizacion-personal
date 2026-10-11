import { useState } from 'react';
import { useFetch } from '../hooks';
import { api } from '../api';
import { Badge, Spinner, Modal, useToast } from '../ui';

interface T { id: number; codigo: string; nombre: string; obligatorio: boolean; tieneVencimiento: boolean; orden: number; activo: boolean; }

export default function TiposDocumento() {
  const { data, loading, reload } = useFetch<T[]>('/tipos-documento');
  const { notify } = useToast();
  const [edit, setEdit] = useState<Partial<T> | null>(null);
  const [busy, setBusy] = useState(false);

  const guardar = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      if (edit.id) await api.patch(`/tipos-documento/${edit.id}`, edit);
      else await api.post('/tipos-documento', edit);
      notify('Tipo guardado.', 'success'); setEdit(null); reload();
    } catch (e: any) { notify(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Tipos de documento</h1><div className="subtitle">Documentación requerida (configurable)</div></div>
        <button className="btn primary" onClick={() => setEdit({ obligatorio: true, tieneVencimiento: false, activo: true, orden: (data?.length ?? 0) + 1 })}>+ Nuevo tipo</button>
      </div>
      <div className="card">
        <div className="table-wrap">
          {loading ? <div className="card-body"><Spinner /></div> : (
            <table className="tbl">
              <thead><tr><th>Nombre</th><th>Código</th><th>Obligatorio</th><th>Vencimiento</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {data?.filter((t) => t.codigo !== 'DOCUMENTACION' && t.activo).map((t) => (
                  <tr key={t.id}>
                    <td><strong>{t.nombre}</strong></td>
                    <td><span className="chip">{t.codigo}</span></td>
                    <td>{t.obligatorio ? 'Sí' : 'No'}</td>
                    <td>{t.tieneVencimiento ? 'Sí' : 'No'}</td>
                    <td><Badge estado={t.activo ? 'ACTIVO' : 'INACTIVO'} /></td>
                    <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => setEdit(t)}>Editar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {edit && (
        <Modal title={edit.id ? 'Editar tipo' : 'Nuevo tipo de documento'} onClose={() => setEdit(null)}
          footer={<><button className="btn" onClick={() => setEdit(null)}>Cancelar</button><button className="btn primary" onClick={guardar} disabled={busy}>Guardar</button></>}>
          <div className="field"><label>Nombre</label><input value={edit.nombre ?? ''} onChange={(e) => setEdit({ ...edit, nombre: e.target.value })} /></div>
          {!edit.id && <div className="field"><label>Código (solo MAYÚSCULAS, números y _)</label><input value={edit.codigo ?? ''} onChange={(e) => setEdit({ ...edit, codigo: e.target.value.toUpperCase() })} placeholder="APTO_MEDICO" /></div>}
          <div className="form-row">
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={!!edit.obligatorio} onChange={(e) => setEdit({ ...edit, obligatorio: e.target.checked })} /> Obligatorio</label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={!!edit.tieneVencimiento} onChange={(e) => setEdit({ ...edit, tieneVencimiento: e.target.checked })} /> Tiene vencimiento</label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={edit.activo ?? true} onChange={(e) => setEdit({ ...edit, activo: e.target.checked })} /> Activo</label>
          </div>
        </Modal>
      )}
    </>
  );
}
