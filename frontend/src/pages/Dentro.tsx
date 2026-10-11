import { useFetch } from '../hooks';
import { api, fmtFecha } from '../api';
import { Spinner, useToast } from '../ui';

export default function Dentro() {
  const { data, loading, reload } = useFetch<any[]>('/ingresos/dentro');
  const { notify } = useToast();
  const salida = async (idEntrada: number) => {
    try { await api.post(`/ingresos/${idEntrada}/salida`); notify('Salida registrada.', 'success'); reload(); }
    catch (e: any) { notify(e.message, 'error'); }
  };
  return (
    <>
      <div className="page-head"><div><h1>Dentro del shopping</h1><div className="subtitle">Personas que ingresaron y todavía no registraron salida</div></div></div>
      <div className="card">
        <div className="table-wrap">
          {loading ? <div className="card-body"><Spinner /></div> : (
            <table className="tbl">
              <thead><tr><th>Persona</th><th>Local</th><th>Ingreso</th><th></th></tr></thead>
              <tbody>
                {data?.length === 0 && <tr><td colSpan={4} className="empty">No hay personas dentro en este momento.</td></tr>}
                {data?.map((e) => (
                  <tr key={e.id}>
                    <td><strong>{e.apellido}, {e.nombre}</strong></td>
                    <td>{e.local}</td>
                    <td>{fmtFecha(e.ingreso)}</td>
                    <td style={{ textAlign: 'right' }}><button className="btn warning sm" onClick={() => salida(e.id)}>Registrar salida</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
