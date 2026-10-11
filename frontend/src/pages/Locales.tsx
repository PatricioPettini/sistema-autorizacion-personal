import { useState } from 'react';
import { useFetch } from '../hooks';
import { api } from '../api';
import { Badge, Spinner, Modal, useToast, useConfirm } from '../ui';

interface Local { id: number; nombre: string; email: string | null; estado: string; observaciones: string | null; usos?: number; eliminable?: boolean; }

export default function Locales() {
  const { data, loading, reload } = useFetch<Local[]>('/locales');
  const { notify } = useToast();
  const confirm = useConfirm();
  const [edit, setEdit] = useState<Partial<Local> | null>(null);
  const [busy, setBusy] = useState(false);

  const guardar = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      if (edit.id) await api.patch(`/locales/${edit.id}`, edit);
      else await api.post('/locales', edit);
      notify('Local guardado.', 'success'); setEdit(null); reload();
    } catch (e: any) { notify(e.message, 'error'); } finally { setBusy(false); }
  };

  const borrar = async (l: Local) => {
    if (!await confirm({ title: 'Borrar local', danger: true, confirmLabel: 'Borrar', message: `¿Borrar el local "${l.nombre}"? No tiene solicitudes ni ingresos asociados.` })) return;
    setBusy(true);
    try { await api.del(`/locales/${l.id}`); notify('Local borrado.', 'success'); reload(); }
    catch (e: any) { notify(e.message, 'error'); } finally { setBusy(false); }
  };

  const vacios = (data ?? []).filter((l) => l.eliminable).length;
  const limpiarVacios = async () => {
    if (!await confirm({ title: 'Limpiar locales vacíos', danger: true, confirmLabel: `Borrar ${vacios}`, message: `Se van a borrar los ${vacios} locales sin ninguna solicitud, email ni ingreso (útil para limpiar duplicados). ¿Continuar?` })) return;
    setBusy(true);
    try { const r = await api.post<{ borrados: string[] }>('/locales/limpiar-vacios'); notify(`${r.borrados.length} local(es) borrado(s).`, 'success'); reload(); }
    catch (e: any) { notify(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Locales</h1><div className="subtitle">Locales del shopping y su email de contacto</div></div>
        <div className="btn-row">
          {vacios > 0 && <button className="btn" disabled={busy} onClick={limpiarVacios}>🧹 Limpiar vacíos ({vacios})</button>}
          <button className="btn primary" onClick={() => setEdit({ estado: 'ACTIVO' })}>+ Nuevo local</button>
        </div>
      </div>
      <div className="card">
        <div className="table-wrap">
          {loading ? <div className="card-body"><Spinner /></div> : (
            <table className="tbl">
              <thead><tr><th>Nombre</th><th>Email</th><th>Estado</th><th>Usos</th><th></th></tr></thead>
              <tbody>
                {data?.map((l) => (
                  <tr key={l.id}>
                    <td><strong>{l.nombre}</strong></td>
                    <td>{l.email ?? '—'}</td>
                    <td><Badge estado={l.estado} /></td>
                    <td className="muted">{l.usos === 0 ? <span className="badge orange">vacío</span> : `${l.usos} uso${l.usos === 1 ? '' : 's'}`}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="btn-row" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn sm" onClick={() => setEdit(l)}>Editar</button>
                        {l.eliminable && <button className="btn ghost sm" disabled={busy} title="Borrar (no tiene usos)" onClick={() => borrar(l)}>🗑</button>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {edit && (
        <Modal title={edit.id ? 'Editar local' : 'Nuevo local'} onClose={() => setEdit(null)}
          footer={<><button className="btn" onClick={() => setEdit(null)}>Cancelar</button><button className="btn primary" onClick={guardar} disabled={busy}>Guardar</button></>}>
          <div className="field"><label>Nombre</label><input value={edit.nombre ?? ''} onChange={(e) => setEdit({ ...edit, nombre: e.target.value })} /></div>
          <div className="field"><label>Email del local</label><input value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></div>
          <div className="field"><label>Estado</label><select value={edit.estado ?? 'ACTIVO'} onChange={(e) => setEdit({ ...edit, estado: e.target.value })}><option value="ACTIVO">Activo</option><option value="INACTIVO">Inactivo</option></select></div>
          <div className="field"><label>Observaciones</label><textarea rows={2} value={edit.observaciones ?? ''} onChange={(e) => setEdit({ ...edit, observaciones: e.target.value })} /></div>
        </Modal>
      )}
    </>
  );
}
