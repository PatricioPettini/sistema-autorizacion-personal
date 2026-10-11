import { useState } from 'react';
import { useFetch } from '../hooks';
import { api, fmtFecha } from '../api';
import { Badge, Spinner, Modal, useToast } from '../ui';

interface U { id: number; nombre: string; email: string; rol: string; activo: boolean; lastLoginAt: string | null; }

export default function Usuarios() {
  const { data, loading, reload } = useFetch<U[]>('/usuarios');
  const { notify } = useToast();
  const [nuevo, setNuevo] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const crear = async () => {
    setBusy(true);
    try { await api.post('/usuarios', nuevo); notify('Usuario creado.', 'success'); setNuevo(null); reload(); }
    catch (e: any) { notify(e.message, 'error'); } finally { setBusy(false); }
  };
  const toggleActivo = async (u: U) => {
    try { await api.patch(`/usuarios/${u.id}`, { activo: !u.activo }); reload(); }
    catch (e: any) { notify(e.message, 'error'); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Usuarios</h1><div className="subtitle">Administradores y personal de Seguridad</div></div>
        <button className="btn primary" onClick={() => setNuevo({ rol: 'SEGURIDAD' })}>+ Nuevo usuario</button>
      </div>
      <div className="card">
        <div className="table-wrap">
          {loading ? <div className="card-body"><Spinner /></div> : (
            <table className="tbl">
              <thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Estado</th><th>Último acceso</th><th></th></tr></thead>
              <tbody>
                {data?.map((u) => (
                  <tr key={u.id}>
                    <td><strong>{u.nombre}</strong></td>
                    <td>{u.email}</td>
                    <td>{u.rol === 'ADMIN' ? 'Administrador' : 'Seguridad'}</td>
                    <td><Badge estado={u.activo ? 'ACTIVO' : 'INACTIVO'} /></td>
                    <td className="muted">{u.lastLoginAt ? fmtFecha(u.lastLoginAt) : '—'}</td>
                    <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => toggleActivo(u)}>{u.activo ? 'Desactivar' : 'Activar'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {nuevo && (
        <Modal title="Nuevo usuario" onClose={() => setNuevo(null)}
          footer={<><button className="btn" onClick={() => setNuevo(null)}>Cancelar</button><button className="btn primary" onClick={crear} disabled={busy}>Crear</button></>}>
          <div className="field"><label>Nombre</label><input value={nuevo.nombre ?? ''} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} /></div>
          <div className="field"><label>Email</label><input type="email" value={nuevo.email ?? ''} onChange={(e) => setNuevo({ ...nuevo, email: e.target.value })} /></div>
          <div className="field"><label>Contraseña</label><input type="password" value={nuevo.password ?? ''} onChange={(e) => setNuevo({ ...nuevo, password: e.target.value })} /><div className="hint">Mínimo 8 caracteres.</div></div>
          <div className="field"><label>Rol</label><select value={nuevo.rol} onChange={(e) => setNuevo({ ...nuevo, rol: e.target.value })}><option value="SEGURIDAD">Seguridad</option><option value="ADMIN">Administrador</option></select></div>
        </Modal>
      )}
    </>
  );
}
