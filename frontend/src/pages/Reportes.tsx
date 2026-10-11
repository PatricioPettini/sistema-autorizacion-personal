import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useFetch } from '../hooks';
import { fmtFecha, fmtSoloFecha, fmtDia, hoy, ahoraHora } from '../api';
import { Spinner, Badge } from '../ui';

type Tab = 'dentro' | 'momento' | 'ingresos' | 'autorizados' | 'vencimientos';

export default function Reportes() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || 'dentro');
  const { data: locales } = useFetch<any[]>('/locales', []);
  const localesReales = (locales ?? []).filter((l) => l.nombre !== '(Sin asignar)');

  return (
    <>
      <div className="page-head"><div><h1>Reportes</h1><div className="subtitle">Consultá información del sistema</div></div></div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className={`btn ${tab === 'dentro' ? 'primary' : ''}`} onClick={() => setTab('dentro')}>🟢 Dentro ahora</button>
          <button className={`btn ${tab === 'momento' ? 'primary' : ''}`} onClick={() => setTab('momento')}>🕐 Quién estaba a tal hora</button>
          <button className={`btn ${tab === 'ingresos' ? 'primary' : ''}`} onClick={() => setTab('ingresos')}>📅 Ingresos y salidas</button>
          <button className={`btn ${tab === 'autorizados' ? 'primary' : ''}`} onClick={() => setTab('autorizados')}>✅ Autorizados por local</button>
          <button className={`btn ${tab === 'vencimientos' ? 'primary' : ''}`} onClick={() => setTab('vencimientos')}>⏰ Vencimientos</button>
        </div>
      </div>

      {tab === 'dentro' && <Dentro />}
      {tab === 'momento' && <EnUnMomento locales={localesReales} />}
      {tab === 'ingresos' && <Ingresos locales={localesReales} />}
      {tab === 'autorizados' && <Autorizados locales={localesReales} />}
      {tab === 'vencimientos' && <Vencimientos />}
    </>
  );
}

function Vencimientos() {
  const { data, loading } = useFetch<any[]>('/reportes/vencimientos?dias=15');
  return (
    <div className="card">
      <div className="card-head">Documentación vencida o por vencer (próximos 15 días) ({data?.length ?? 0})</div>
      <div className="table-wrap">
        {loading ? <div className="card-body"><Spinner /></div> : (
          <table className="tbl">
            <thead><tr><th>Persona</th><th>CUIL</th><th>Documento</th><th>Vence</th><th>Estado</th></tr></thead>
            <tbody>
              {data?.length === 0 && <tr><td colSpan={5} className="empty">No hay documentación por vencer. 🎉</td></tr>}
              {data?.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.apellido}, {r.nombre}</strong></td><td>{r.cuilFormat}</td><td>{r.tipo}</td>
                  <td>{fmtSoloFecha(r.fechaVencimiento)}</td>
                  <td>{r.diasParaVencer < 0
                    ? <span className="badge red">Vencido hace {-r.diasParaVencer} días</span>
                    : <span className="badge yellow">Vence en {r.diasParaVencer} días</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Dentro() {
  const { data, loading } = useFetch<any[]>('/reportes/dentro');
  return (
    <div className="card">
      <div className="card-head">Personas dentro del shopping ({data?.length ?? 0})</div>
      <div className="table-wrap">
        {loading ? <div className="card-body"><Spinner /></div> : (
          <table className="tbl">
            <thead><tr><th>Local</th><th>Persona</th><th>CUIL</th><th>Ingreso</th></tr></thead>
            <tbody>
              {data?.length === 0 && <tr><td colSpan={4} className="empty">No hay personas dentro en este momento.</td></tr>}
              {data?.map((r) => (
                <tr key={r.id}><td>{r.local}</td><td><strong>{r.apellido}, {r.nombre}</strong></td><td>{r.cuilFormat}</td><td>{fmtFecha(r.ingreso)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/**
 * "¿Quién estaba adentro el día X a la hora Y?" — la pregunta que aparece cuando hay que
 * reconstruir un episodio (un faltante, un daño, un accidente) y el registro de ingresos y salidas
 * por rango no alcanza: hay que cruzar a mano quién había entrado y todavía no había salido.
 */
function EnUnMomento({ locales }: { locales: any[] }) {
  const [fecha, setFecha] = useState(hoy());
  const [hora, setHora] = useState(ahoraHora());
  const [localId, setLocalId] = useState('');
  const query = new URLSearchParams({ fecha, hora });
  if (localId) query.set('localId', localId);
  const { data, loading, error } = useFetch<any>(`/reportes/presentes?${query.toString()}`, [fecha, hora, localId]);

  const rows: any[] = data?.personas ?? [];
  const sinSalida = rows.filter((r) => r.sinSalida).length;

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <div className="field" style={{ margin: 0 }}><label>Día</label><input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} /></div>
          <div className="field" style={{ margin: 0 }}><label>Hora</label><input type="time" value={hora} onChange={(e) => setHora(e.target.value)} /></div>
          <div className="field" style={{ margin: 0, minWidth: 160 }}><label>Local</label>
            <select value={localId} onChange={(e) => setLocalId(e.target.value)}>
              <option value="">Todos</option>
              {locales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 2, flexWrap: 'wrap' }}>
            {['08:00', '12:00', '16:00', '20:00'].map((h) => (
              <button key={h} className="btn" onClick={() => setHora(h)}>{h}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          {`Adentro el ${fmtDia(fecha)} a las ${hora} (${rows.length})`}
          {sinSalida > 0 && <span className="chip" style={{ marginLeft: 8 }}>⚠ {sinSalida} sin salida registrada</span>}
        </div>
        <div className="table-wrap">
          {loading ? <div className="card-body"><Spinner /></div> : error ? <div className="card-body error">{error}</div> : (
            <table className="tbl">
              <thead><tr><th>Local</th><th>Persona</th><th>Documento</th><th>Ingreso</th><th>Salida</th></tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={5} className="empty">No había nadie adentro en ese momento.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.local}</td>
                    <td><strong>{r.apellido}, {r.nombre}</strong></td>
                    <td style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{r.documento}</td>
                    <td>{fmtFecha(r.ingreso)}</td>
                    <td>{r.salida ? fmtFecha(r.salida) : <span className="badge yellow">Sin salida registrada</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {sinSalida > 0 && (
          <div className="card-body muted" style={{ borderTop: '1px solid var(--borde)', fontSize: 13 }}>
            A los marcados en amarillo nunca les registraron la salida, así que figuran adentro desde
            que entraron. Que aparezcan a esta hora no prueba que estuvieran: prueba que entraron antes.
          </div>
        )}
      </div>
    </>
  );
}

function Ingresos({ locales }: { locales: any[] }) {
  const [desde, setDesde] = useState(hoy());
  const [hasta, setHasta] = useState(hoy());
  const [localId, setLocalId] = useState('');
  const query = new URLSearchParams({ desde, hasta });
  if (localId) query.set('localId', localId);
  const { data, loading } = useFetch<any[]>(`/reportes/ingresos?${query.toString()}`, [desde, hasta, localId]);

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <div className="field" style={{ margin: 0 }}><label>Desde</label><input type="date" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} /></div>
          <div className="field" style={{ margin: 0 }}><label>Hasta</label><input type="date" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} /></div>
          <div className="field" style={{ margin: 0, minWidth: 160 }}><label>Local</label>
            <select value={localId} onChange={(e) => setLocalId(e.target.value)}>
              <option value="">Todos</option>
              {locales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head">Ingresos y salidas ({data?.length ?? 0})</div>
        <div className="table-wrap">
          {loading ? <div className="card-body"><Spinner /></div> : (
            <table className="tbl">
              <thead><tr><th>Local</th><th>Persona</th><th>CUIL</th><th>Ingreso</th><th>Salida</th></tr></thead>
              <tbody>
                {data?.length === 0 && <tr><td colSpan={5} className="empty">Sin movimientos en ese rango.</td></tr>}
                {data?.map((r) => (
                  <tr key={r.id}>
                    <td>{r.local}</td><td><strong>{r.apellido}, {r.nombre}</strong></td><td>{r.cuilFormat}</td>
                    <td>{fmtFecha(r.ingreso)}</td>
                    <td>{r.salida ? fmtFecha(r.salida) : <span className="badge green">Dentro</span>}</td>
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

function Autorizados({ locales }: { locales: any[] }) {
  const [localId, setLocalId] = useState('');
  const [soloVigentes, setSoloVigentes] = useState(true);
  const query = new URLSearchParams();
  if (localId) query.set('localId', localId);
  if (soloVigentes) query.set('soloVigentes', '1');
  const { data, loading } = useFetch<any[]>(`/reportes/autorizados?${query.toString()}`, [localId, soloVigentes]);

  const rango = (r: any) => (r.fechaHasta && r.fechaHasta !== r.fecha ? `${fmtSoloFecha(r.fecha)} – ${fmtSoloFecha(r.fechaHasta)}` : fmtSoloFecha(r.fecha));

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="field" style={{ margin: 0, minWidth: 160 }}><label>Local</label>
            <select value={localId} onChange={(e) => setLocalId(e.target.value)}>
              <option value="">Todos</option>
              {locales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 18 }}>
            <input type="checkbox" checked={soloVigentes} onChange={(e) => setSoloVigentes(e.target.checked)} /> Solo vigentes hoy
          </label>
        </div>
      </div>
      <div className="card">
        <div className="card-head">Personal autorizado ({data?.length ?? 0})</div>
        <div className="table-wrap">
          {loading ? <div className="card-body"><Spinner /></div> : (
            <table className="tbl">
              <thead><tr><th>Local</th><th>Persona</th><th>CUIL</th><th>Fecha</th><th>Horario</th><th>Vigencia</th></tr></thead>
              <tbody>
                {data?.length === 0 && <tr><td colSpan={6} className="empty">Sin autorizaciones con esos filtros.</td></tr>}
                {data?.map((r) => (
                  <tr key={r.id}>
                    <td>{r.local}</td><td><strong>{r.apellido}, {r.nombre}</strong></td><td>{r.cuilFormat}</td>
                    <td>{rango(r)}</td><td>{r.horaDesde}–{r.horaHasta}</td>
                    <td>{r.vigenteHoy ? <Badge estado="AUTORIZADO" /> : <span className="muted">Fuera de fecha</span>}</td>
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
