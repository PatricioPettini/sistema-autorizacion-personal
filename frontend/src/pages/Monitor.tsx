import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFetch } from '../hooks';
import { api, fmtFecha, fmtSoloFecha } from '../api';
import { Badge, Spinner, useToast } from '../ui';

export default function Monitor() {
  // Se refresca solo: el lector corre en segundo plano y esta pantalla es para vigilarlo.
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  const { data, loading } = useFetch<any>('/config/monitor', [tick]);
  const { data: casilla } = useFetch<any>('/config/email', [tick]);
  const { notify } = useToast();
  const nav = useNavigate();
  const [revisando, setRevisando] = useState(false);

  const revisarAhora = async () => {
    setRevisando(true);
    try {
      const r = await api.post<any>('/config/email/revisar-ahora', {});
      notify(r.ok ? `Revisión hecha: ${r.nuevos} nuevo(s), ${r.procesados} procesado(s).` : `No se pudo revisar: ${r.error}`, r.ok ? 'success' : 'error');
      setTick((n) => n + 1);
    } catch (e: any) { notify(e.message, 'error'); } finally { setRevisando(false); }
  };

  if (loading || !data) return <Spinner />;
  const s = data.scheduler;
  return (
    <>
      <div className="page-head">
        <div><h1>Monitoreo</h1><div className="subtitle">Estado del procesamiento automático de emails</div></div>
        <button className="btn primary" onClick={revisarAhora} disabled={revisando}>{revisando ? 'Revisando…' : 'Revisar buzón ahora'}</button>
      </div>

      <div className="grid kpis" style={{ marginBottom: 16 }}>
        <div className="kpi"><div className="label">Lector automático</div><div className="value" style={{ fontSize: 18 }}>{s.configurado ? (s.pollMinutes > 0 ? `Cada ${s.pollMinutes} min` : 'Pausado') : 'Sin configurar'}</div></div>
        <div className="kpi"><div className="label">Última sincronización</div><div className="value" style={{ fontSize: 16 }}>{s.lastSyncAt ? fmtFecha(s.lastSyncAt) : '—'}</div></div>
        <div className="kpi"><div className="label">Próxima revisión</div><div className="value" style={{ fontSize: 16 }}>{s.activo && s.nextRunAt ? fmtFecha(s.nextRunAt) : '—'}</div></div>
        <div className="kpi"><div className="label">Jobs con error</div><div className="value">{data.jobsConError}</div></div>
      </div>

      {casilla && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">✉️ Casilla del sistema</div>
          <div className="card-body" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13.5 }}>
            <div><div className="muted">Casilla</div><strong>{casilla.imapUser || '—'}</strong></div>
            <div><div className="muted">Recepción</div><strong>{casilla.imapHost || '—'}:{casilla.imapPort}</strong></div>
            <div><div className="muted">Envío</div><strong>{casilla.smtpHost || '—'}:{casilla.smtpPort}</strong></div>
            <div><div className="muted">Contraseña</div><strong>{casilla.passwordCargada ? 'cargada' : 'FALTA'}</strong></div>
            {casilla.revisarAntesDe && (
              <div><div className="muted">Van al respaldo los anteriores a</div><strong>{fmtSoloFecha(casilla.revisarAntesDe)}</strong></div>
            )}
          </div>
          <div className="card-body" style={{ paddingTop: 0 }}>
            <div className="hint">
              La casilla se configura en el servidor (variables <code>MAIL_*</code>), no desde el panel: así no puede
              quedar mal cargada por error. Para cambiar la contraseña, <code>flyctl secrets set MAIL_IMAP_PASSWORD=…</code>
            </div>
          </div>
        </div>
      )}

      {!s.activo && (
        <div className="alert warn" style={{ marginBottom: 16 }}>
          El lector automático <strong>no está corriendo</strong> {s.configurado ? '(frecuencia en 0)' : '(falta configurar la casilla en el servidor)'}.
        </div>
      )}
      {casilla && !casilla.passwordCargada && (
        <div className="alert error" style={{ marginBottom: 16 }}>
          <strong>Falta la contraseña de la casilla.</strong> Sin eso el buzón no se puede leer y las solicitudes no entran.
          Se carga en el servidor: <code>flyctl secrets set MAIL_IMAP_PASSWORD=… MAIL_SMTP_PASSWORD=…</code>
        </div>
      )}
      {data.emailsPorEstado.some((e: any) => e.estado === 'NEEDS_REVIEW') && (
        <div className="alert info" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          Hay correos esperando revisión manual.
          <button className="btn sm" onClick={() => nav('/respaldo')}>Ir al respaldo</button>
        </div>
      )}
      {s.lastResult && !s.lastResult.ok && (
        <div className="alert error" style={{ marginBottom: 16 }}>Última revisión con error: {s.lastResult.error}</div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">Emails por estado</div>
          <div className="table-wrap">
            <table className="tbl"><thead><tr><th>Estado</th><th>Cantidad</th></tr></thead>
              <tbody>
                {data.emailsPorEstado.length === 0 && <tr><td colSpan={2} className="empty">Todavía no se recibieron emails.</td></tr>}
                {data.emailsPorEstado.map((e: any) => <tr key={e.estado}><td><Badge estado={e.estado} /></td><td>{e.n}</td></tr>)}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-head">Últimos emails</div>
          <div className="table-wrap">
            <table className="tbl"><thead><tr><th>Asunto</th><th>Estado</th><th>Recibido</th></tr></thead>
              <tbody>
                {data.ultimosEmails.length === 0 && <tr><td colSpan={3} className="empty">—</td></tr>}
                {data.ultimosEmails.map((e: any) => <tr key={e.id}><td>{e.asunto ?? '—'}</td><td><Badge estado={e.estado} /></td><td className="muted">{fmtFecha(e.fechaRecibido)}</td></tr>)}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
