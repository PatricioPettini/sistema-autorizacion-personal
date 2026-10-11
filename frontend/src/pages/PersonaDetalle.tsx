import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useFetch } from '../hooks';
import { api, fmtFecha, fmtSoloFecha } from '../api';
import { Badge, Spinner, Modal, useToast } from '../ui';
import { DocList } from '../components/DocList';
import { useAuth } from '../auth';

export default function PersonaDetalle() {
  const { id } = useParams();
  const { data, loading, reload } = useFetch<any>(`/personas/${id}`, [id]);
  const isAdmin = useAuth().user?.rol === 'ADMIN';
  const { notify } = useToast();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [edit, setEdit] = useState({ nombre: '', apellido: '', cuil: '', categoria: '', empresa: '' });

  if (!data) return <Spinner />; // solo en la carga inicial; en recargas mantenemos el contenido
  const { persona, docStatus, analisis, solicitudes = [], autorizaciones, ingresos, vigencia, autorizacionVigente, localVigente, trabajoVigente, vigentes = [], ingresoAbierto } = data;
  const autorizado = vigencia === 'AUTORIZADO';
  // Autorizada por más de un local a la vez (ej. el mismo técnico contratado por dos negocios).
  const varios = (vigentes as any[]).length > 1;
  // Solicitudes todavía abiertas (no cerradas/rechazadas) donde se autoriza a esta persona.
  // Se excluyen las que están en la papelera: no habilitan ingreso ni se deben seguir trabajando.
  const solicitudesAbiertas = (solicitudes as any[]).filter((s) => !s.deletedAt && !['RECHAZADA', 'REEMPLAZADA'].includes(s.estadoPersona));

  const registrarIngreso = async (localId?: number) => {
    const destino = localId ?? autorizacionVigente?.localId;
    if (!destino) return;
    setBusy(true);
    try { await api.post('/ingresos', { personaId: persona.id, localId: destino }); notify('Ingreso registrado.', 'success'); reload(); }
    catch (e: any) { notify(e.message, 'error'); } finally { setBusy(false); }
  };
  const registrarSalida = async () => {
    if (!ingresoAbierto) return;
    setBusy(true);
    try { await api.post(`/ingresos/${ingresoAbierto.id}/salida`); notify('Salida registrada.', 'success'); reload(); }
    catch (e: any) { notify(e.message, 'error'); } finally { setBusy(false); }
  };

  const abrirEdit = () => { setEdit({ nombre: persona.nombre, apellido: persona.apellido, cuil: persona.cuil ?? '', categoria: persona.categoria ?? '', empresa: persona.empresa ?? '' }); setEditOpen(true); };
  const guardarEdit = async () => {
    setBusy(true);
    try { await api.patch(`/personas/${persona.id}`, { ...edit, categoria: edit.categoria || null }); notify('Datos actualizados.', 'success'); setEditOpen(false); reload(); }
    catch (e: any) { notify(e.message, 'error'); } finally { setBusy(false); }
  };


  return (
    <>
      <div className="page-head">
        <div>
          <a className="muted" onClick={() => (window.history.length > 1 ? nav(-1) : nav('/personas'))} style={{ cursor: 'pointer' }}>← Volver</a>
          <h1 style={{ marginTop: 6 }}>{persona.apellido}, {persona.nombre} {isAdmin && <button className="btn ghost sm" onClick={abrirEdit} title="Corregir nombre o CUIL">✎ Editar datos</button>}</h1>
          <div className="subtitle">CUIL {persona.cuilFormat}</div>
        </div>
      </div>

      <div className="card person-lookup" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <div className="big-status" style={{ background: autorizado ? 'var(--green-soft)' : 'var(--red-soft)', color: autorizado ? '#15803d' : '#b91c1c' }}>
            {autorizado ? '🟢 AUTORIZADO' : '🔴 NO AUTORIZADO'}
          </div>
          {!autorizado && <p className="muted" style={{ marginTop: 6 }}>No permitir el ingreso sin autorización vigente.</p>}
          {autorizacionVigente && varios && (
            <div style={{ marginTop: 8 }}>
              <div className="stat-line"><span className="muted">Autorizada por {vigentes.length} locales:</span></div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {vigentes.map((v: any) => (
                  <li key={v.autorizacionId} style={{ marginBottom: 2 }}>
                    <strong>{v.local}</strong>
                    {v.trabajo && <span className="muted"> — {v.trabajo}</span>}
                    <span className="muted"> ({v.horaDesde}–{v.horaHasta})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {autorizacionVigente && !varios && (
            <div style={{ marginTop: 8 }}>
              <div className="stat-line"><span className="muted">Local:</span> <strong>{localVigente?.nombre ?? '—'}</strong></div>
              {trabajoVigente && <div className="stat-line"><span className="muted">Trabajo:</span> <strong>{trabajoVigente}</strong></div>}
              <div className="stat-line">
                <span className="muted">Fecha:</span>{' '}
                <strong>{autorizacionVigente.fechaHasta && autorizacionVigente.fechaHasta !== autorizacionVigente.fecha
                  ? `${fmtSoloFecha(autorizacionVigente.fecha)} — ${fmtSoloFecha(autorizacionVigente.fechaHasta)}`
                  : fmtSoloFecha(autorizacionVigente.fecha)}</strong>
              </div>
              <div className="stat-line"><span className="muted">Horario:</span> <strong>{autorizacionVigente.horaDesde} — {autorizacionVigente.horaHasta}</strong></div>
            </div>
          )}
          <div className="divider" />
          <div className="stat-line">
            <span className="muted">Ingreso en curso:</span>{' '}
            <strong>{ingresoAbierto ? `${fmtFecha(ingresoAbierto.fechaHoraIngreso)}${ingresoAbierto.local ? ` — ${ingresoAbierto.local}` : ''}` : '—'}</strong>
          </div>
          <div className="btn-row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
            {/* Con varios locales no hay un "Registrar ingreso" a secas: hay que decir a cuál entra,
                porque el ingreso queda imputado a ese local y de ahí sale el reporte del local. */}
            {autorizado && !ingresoAbierto && varios && vigentes.map((v: any) => (
              <button key={v.autorizacionId} className="btn success" onClick={() => registrarIngreso(v.localId)} disabled={busy}>
                Ingreso a {v.local}
              </button>
            ))}
            {autorizado && !ingresoAbierto && !varios && <button className="btn success" onClick={() => registrarIngreso()} disabled={busy}>Registrar ingreso</button>}
            {ingresoAbierto && <button className="btn warning" onClick={registrarSalida} disabled={busy}>Registrar salida{ingresoAbierto.local ? ` de ${ingresoAbierto.local}` : ''}</button>}
          </div>
          {autorizado && !ingresoAbierto && varios && (
            <p className="muted" style={{ marginTop: 8, fontSize: 13, marginBottom: 0 }}>
              Está autorizada por más de un local. Elegí a cuál está entrando: el ingreso queda
              registrado a nombre de ese local.
            </p>
          )}
        </div>
      </div>

      <div className="grid cols-2">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-head">Documentación</div>
            <div className="card-body">
              {isAdmin && (
                <div className="alert info" style={{ marginBottom: 12 }}>
                  Acá aprobás o rechazás la documentación (vale para <strong>todas</strong> las solicitudes de esta persona).
                  La <strong>autorización de ingreso</strong> y la <strong>fecha de vigencia</strong> se cargan en la solicitud, porque son por local.
                  {docStatus.todosVerificados && <div style={{ marginTop: 6 }}>✅ Documentación completa: entrá a la solicitud y cargá la <strong>“Vigencia hasta”</strong> para autorizarla.</div>}
                  {solicitudesAbiertas.length > 0 && (
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {solicitudesAbiertas.map((s: any) => (
                        <button key={s.solicitudId} className="btn ghost sm" onClick={() => nav(`/solicitudes/${s.solicitudId}`)}>
                          Ir a la solicitud{s.nroOrden ? ` ${s.nroOrden}` : ''} · {s.local}{s.fechaVencimiento ? '' : ' (sin vigencia)'}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <DocList docStatus={docStatus} personaId={persona.id} onChanged={reload} />
            </div>
          </div>

          <div className="card">
            <div className="card-head">Estado de documentación</div>
            <div className="card-body">
              <div style={{ marginBottom: 8 }}><Badge estado={analisis.estadoDocumental} /></div>
              {/* "Sin faltantes" no significa "todo aprobado": mientras no se sepa si trabaja como
                  empresa o como monotributista, no hay lista de requisitos que comparar. Decir que
                  está todo aprobado cuando la lista está vacía es lo que hacía que una persona sin
                  tipo definido apareciera como "Incompleto" y "todo aprobado" al mismo tiempo. */}
              {docStatus.requiereCategoria
                ? <div className="muted">Todavía no se sabe qué documentación le corresponde: falta definir si trabaja como <strong>empresa</strong> o como <strong>monotributista</strong>. Se define en la solicitud, con <em>Definir tipo de contratista</em>.</div>
                : docStatus.faltantes.length > 0
                ? <div className="muted">Falta aprobar: {docStatus.faltantes.join(', ')}.</div>
                : docStatus.totalObligatorios === 0
                ? <div className="muted">No tiene requisitos propios para aprobar. La documentación de su tipo se aprueba una vez para toda la solicitud.</div>
                : <div className="tag-ok">Toda la documentación obligatoria está aprobada.</div>}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-head">Autorizaciones</div>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Local</th><th>Fecha</th><th>Horario</th><th>Estado</th></tr></thead>
                <tbody>
                  {autorizaciones.length === 0 && <tr><td colSpan={4} className="empty">Sin autorizaciones.</td></tr>}
                  {autorizaciones.map((a: any) => (
                    <tr key={a.id}><td>{a.local}</td><td>{a.fechaHasta && a.fechaHasta !== a.fecha ? `${fmtSoloFecha(a.fecha)} – ${fmtSoloFecha(a.fechaHasta)}` : fmtSoloFecha(a.fecha)}</td><td>{a.horaDesde}–{a.horaHasta}</td><td><Badge estado={a.estado} /></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-head">Historial de ingresos</div>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Local</th><th>Ingreso</th><th>Salida</th></tr></thead>
                <tbody>
                  {ingresos.length === 0 && <tr><td colSpan={3} className="empty">Sin ingresos registrados.</td></tr>}
                  {ingresos.map((e: any) => (
                    <tr key={e.id}><td>{e.local}</td><td>{fmtFecha(e.ingreso)}</td><td>{e.salida ? fmtFecha(e.salida) : <span className="badge green">Dentro</span>}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>


      {editOpen && (
        <Modal title="Editar datos de la persona" onClose={() => setEditOpen(false)}
          footer={<><button className="btn" onClick={() => setEditOpen(false)}>Cancelar</button><button className="btn primary" onClick={guardarEdit} disabled={busy}>Guardar</button></>}>
          <div className="alert info">Corregí lo que el asistente pudo haber leído mal.</div>
          <div className="form-row">
            <div className="field"><label>Apellido</label><input value={edit.apellido} onChange={(e) => setEdit({ ...edit, apellido: e.target.value })} /></div>
            <div className="field"><label>Nombre</label><input value={edit.nombre} onChange={(e) => setEdit({ ...edit, nombre: e.target.value })} /></div>
          </div>
          <div className="form-row">
            <div className="field"><label>CUIL</label><input value={edit.cuil} onChange={(e) => setEdit({ ...edit, cuil: e.target.value })} placeholder="20-30410849-0" /></div>
            <div className="field"><label>Tipo de contratista</label>
              <select value={edit.categoria} onChange={(e) => setEdit({ ...edit, categoria: e.target.value })}>
                <option value="">(a definir)</option>
                <option value="EMPRESA">Empresa</option>
                <option value="MONOTRIBUTISTA">Monotributista</option>
              </select>
            </div>
          </div>
          <div className="field"><label>Empresa (si corresponde)</label><input value={edit.empresa} onChange={(e) => setEdit({ ...edit, empresa: e.target.value })} placeholder="Ej: GMRA S.A.U." /></div>
        </Modal>
      )}
    </>
  );
}
