import { useState } from 'react';
import { useFetch } from '../hooks';
import { fmtFecha } from '../api';
import { Spinner } from '../ui';

interface AuditResp {
  rows: { id: number; accion: string; descripcion: string; createdAt: string; userNombre: string | null }[];
  total: number;
  page: number;
  pageSize: number;
}

const PAGE_SIZE = 50;

// Etiquetas legibles para el filtro de acción (las que no matchean muestran el código crudo).
const ACCION_LABEL: Record<string, string> = {
  LOGIN: 'Inicios de sesión', LOGOUT: 'Cierres de sesión',
  PERSONA_CREADA: 'Personas creadas', PERSONA_MODIFICADA: 'Personas modificadas',
  SOLICITUD_CREADA: 'Solicitudes creadas', SOLICITUD_CREADA_MANUAL: 'Solicitudes manuales',
  SOLICITUD_PERSONA_QUITADA: 'Personas quitadas', SOLICITUD_LOCAL_ASIGNADO: 'Locales asignados',
  DOCUMENTO_VERIFICADO: 'Documentos aprobados/rechazados', AUTORIZACION_REALIZADA: 'Autorizaciones',
  AUTORIZACION_REVOCADA: 'Revocaciones', RECHAZO_REALIZADO: 'Rechazos',
  INGRESO_REGISTRADO: 'Ingresos', SALIDA_REGISTRADA: 'Salidas',
  EMAIL_RECIBIDO: 'Emails recibidos', EMAIL_PROCESADO: 'Emails procesados',
  EMAIL_ENVIADO: 'Emails enviados', EMAIL_SUMADO_A_SOLICITUD: 'Documentación sumada',
  SOLICITUD_ELIMINADA: 'Enviadas a papelera', LOCAL_CREADO: 'Locales creados',
};

export default function Auditoria() {
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [q, setQ] = useState('');
  const [accion, setAccion] = useState('');
  const [userId, setUserId] = useState('');
  const [page, setPage] = useState(1);

  const { data: opciones } = useFetch<{ acciones: string[]; usuarios: { id: number; nombre: string }[] }>('/auditoria/opciones', []);

  const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (desde) query.set('desde', desde);
  if (hasta) query.set('hasta', hasta);
  if (q.trim()) query.set('q', q.trim());
  if (accion) query.set('accion', accion);
  if (userId) query.set('userId', userId);

  const { data, loading } = useFetch<AuditResp>(`/auditoria?${query.toString()}`, [desde, hasta, q, accion, userId, page]);
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const hayFiltros = !!(desde || hasta || q || accion || userId);
  const limpiar = () => { setDesde(''); setHasta(''); setQ(''); setAccion(''); setUserId(''); setPage(1); };
  const on = (setter: (v: string) => void) => (v: string) => { setter(v); setPage(1); };

  return (
    <>
      <div className="page-head"><div><h1>Auditoría</h1><div className="subtitle">Registro de todas las acciones del sistema</div></div></div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <div className="field" style={{ margin: 0, flex: 1, minWidth: 200 }}><label>Buscar (persona, local, CUIL, texto…)</label>
            <input value={q} onChange={(e) => on(setQ)(e.target.value)} placeholder="Ej: Ferreira, GRUPO DELTA, 20-33…" />
          </div>
          <div className="field" style={{ margin: 0, minWidth: 160 }}><label>Acción</label>
            <select value={accion} onChange={(e) => on(setAccion)(e.target.value)}>
              <option value="">Todas</option>
              {(opciones?.acciones ?? []).map((a) => <option key={a} value={a}>{ACCION_LABEL[a] ?? a}</option>)}
            </select>
          </div>
          <div className="field" style={{ margin: 0, minWidth: 150 }}><label>Usuario</label>
            <select value={userId} onChange={(e) => on(setUserId)(e.target.value)}>
              <option value="">Todos</option>
              {(opciones?.usuarios ?? []).map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}><label>Desde</label><input type="date" value={desde} max={hasta || undefined} onChange={(e) => on(setDesde)(e.target.value)} /></div>
          <div className="field" style={{ margin: 0 }}><label>Hasta</label><input type="date" value={hasta} min={desde || undefined} onChange={(e) => on(setHasta)(e.target.value)} /></div>
          {hayFiltros && <button className="btn sm" style={{ marginBottom: 2 }} onClick={limpiar}>Limpiar filtros</button>}
          <div style={{ flex: 1 }} />
          <div className="muted" style={{ fontSize: 13 }}>{total} registro{total === 1 ? '' : 's'}</div>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          {loading ? <div className="card-body"><Spinner /></div> : (
            <table className="tbl">
              <thead><tr><th>Fecha</th><th>Usuario</th><th>Detalle</th></tr></thead>
              <tbody>
                {data?.rows.length === 0 && <tr><td colSpan={3} className="empty">Sin registros con esos filtros.</td></tr>}
                {data?.rows.map((a) => (
                  <tr key={a.id}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtFecha(a.createdAt)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{a.userNombre ?? <span className="muted">Sistema</span>}</td>
                    <td>{a.descripcion || <span className="muted">{a.accion}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {totalPages > 1 && (
          <div className="card-body" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'center' }}>
            <button className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Anterior</button>
            <span className="muted" style={{ fontSize: 13 }}>Página {page} de {totalPages}</span>
            <button className="btn sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Siguiente →</button>
          </div>
        )}
      </div>
    </>
  );
}
