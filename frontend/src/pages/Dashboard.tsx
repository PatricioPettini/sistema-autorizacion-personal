import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useFetch } from '../hooks';
import { Badge, Spinner } from '../ui';
import { fmtFecha, tipoLabel } from '../api';

interface Dash {
  contadores: Record<string, number>;
  recientes: { id: number; estado: string; updatedAt: string; local: string; personasCount: number; personasLabel: string; tipo: string | null }[];
}

// `to`: a dónde navega el card al clickear (filtro de solicitudes o pantalla).
const KPIS: { key: string; label: string; color: string; to: string }[] = [
  { key: 'pendientes', label: 'Pendientes', color: 'var(--yellow)', to: '/solicitudes?estado=PENDIENTE' },
  { key: 'autorizados', label: 'Autorizados', color: 'var(--green)', to: '/solicitudes?estado=AUTORIZADA' },
  { key: 'observados', label: 'Observados', color: 'var(--orange)', to: '/solicitudes?estado=OBSERVADA' },
  { key: 'rechazados', label: 'Rechazados', color: 'var(--red)', to: '/solicitudes?estado=RECHAZADA' },
  { key: 'enRevision', label: 'En revisión', color: 'var(--blue)', to: '/solicitudes?estado=EN_REVISION' },
  { key: 'vencimientos', label: 'Vencimientos', color: 'var(--red)', to: '/reportes?tab=vencimientos' },
  { key: 'dentro', label: 'Dentro ahora', color: 'var(--green)', to: '/dentro' },
];

export default function Dashboard() {
  const { data, loading } = useFetch<Dash>('/dashboard');
  const nav = useNavigate();
  const [q, setQ] = useState('');

  if (loading || !data) return <Spinner />;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Panel de control</h1>
          <div className="subtitle">Resumen del estado de ingresos del personal externo</div>
        </div>
      </div>

      <div className="grid kpis" style={{ marginBottom: 18 }}>
        {KPIS.map((k) => (
          <div className="kpi" key={k.key} style={{ cursor: 'pointer' }} onClick={() => nav(k.to)} title="Ver solicitudes">
            <div className="label"><span className="dot" style={{ background: k.color }} />{k.label}</div>
            <div className="value">{data.contadores[k.key] ?? 0}</div>
          </div>
        ))}
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">🔔 Requieren atención</div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Local</th><th>Tipo</th><th>Personas</th><th>Estado</th><th>Actualizado</th></tr></thead>
              <tbody>
                {data.recientes.length === 0 && <tr><td colSpan={5} className="empty">Sin solicitudes todavía.</td></tr>}
                {data.recientes.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/solicitudes/${r.id}`)}>
                    <td><strong>{r.local === '(Sin asignar)' ? <span className="badge orange">Sin asignar</span> : r.local}</strong></td>
                    <td>{r.tipo ? <span className="chip">{tipoLabel(r.tipo)}</span> : <span className="muted">—</span>}</td>
                    <td>
                      <span className="chip">{r.personasCount} {r.personasCount === 1 ? 'persona' : 'personas'}</span>
                      <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{r.personasLabel || '—'}</div>
                    </td>
                    <td><Badge estado={r.estado} /></td>
                    <td className="muted">{fmtFecha(r.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card" style={{ alignSelf: 'start' }}>
          <div className="card-head">🔎 Consulta rápida de Seguridad</div>
          <div className="card-body">
            <p className="muted" style={{ marginTop: 0 }}>¿Esta persona puede entrar ahora?</p>
            <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) nav(`/personas?q=${encodeURIComponent(q.trim())}`); }}>
              <div className="field">
                <input placeholder="DNI o nombre" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
              </div>
              <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }}>Consultar</button>
            </form>
          </div>
        </div>
      </div>
    </>
  );
}
