import { useState, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFetch } from '../hooks';
import { api, fmtFecha } from '../api';
import { Spinner, useToast, useConfirm } from '../ui';
import { EmailInline } from '../components/EmailInline';
import { avisarRespaldoCambio } from '../components/Layout';

interface SolRef { id: number; nroOrden: string | null; local: string; }
interface Row {
  id: number; remitente: string | null; asunto: string | null; fecha: string | null;
  fechaRecibido: string; estado: string; motivo: string | null; attachmentsCount: number;
  replySolicitudId: number | null; solicitud: SolRef | null; localDetectado: string | null;
  /** A qué solicitud iría al procesarlo. null = no pertenece a ninguna, se crea una nueva. */
  destino: SolRef | null;
  aviso: { fecha: string; tipo: string | null } | null;
}

const ESTADO_LABEL: Record<string, string> = { NEEDS_REVIEW: 'Para revisar', ERROR: 'Con error' };

interface Deteccion {
  local: string | null;
  localExistente: { id: number; nombre: string } | null;
  tipo: string | null;
  personas: number;
  descartadas: number;
  origen: 'excel' | 'cuerpo' | null;
  adjuntos: number;
  desglose: { pdfs: number; imagenes: number; otros: number } | null;
  solicitudDestino: { id: number; nroOrden: string | null; local: string } | null;
  conflicto: { remitente: string; direccion: string; orden: string; nroOrden: string | null } | null;
}

/**
 * Qué va a poder leer el sistema de este correo si se lo procesa: el local, el tipo de contratista
 * y la lista de personas. Se consulta al desplegar la fila, para decidir con información en vez
 * de a ciegas: si no detecta personas, "Procesar igual" va a crear una solicitud vacía.
 */
function QueDetecta({ emailId }: { emailId: number }) {
  const { data, loading } = useFetch<Deteccion>(`/emails/${emailId}/deteccion`, [emailId]);
  if (loading) return <div className="muted" style={{ fontSize: 12.5 }}>Analizando el correo…</div>;
  if (!data) return null;
  const ok = { color: 'var(--green)', fontWeight: 650 };
  const no = { color: 'var(--red)', fontWeight: 650 };
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12, background: 'var(--panel-2)' }}>
      <div style={{ fontWeight: 650, marginBottom: 8, fontSize: 13 }}>Qué detecta el sistema en este correo</div>
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', fontSize: 13 }}>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>Local (del asunto)</div>
          {data.localExistente
            ? <span style={ok}>✓ {data.localExistente.nombre}</span>
            : data.local
              ? <span style={{ color: 'var(--yellow)', fontWeight: 650 }}>“{data.local}” — no coincide con ninguno cargado</span>
              : <span style={no}>✕ no se detectó</span>}
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>Personas</div>
          {data.personas > 0
            ? <span style={ok}>✓ {data.personas} {data.personas === 1 ? 'persona' : 'personas'} ({data.origen === 'excel' ? 'del Excel' : 'del cuerpo del mail'})</span>
            : <span style={no}>✕ no se detectaron</span>}
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>Tipo</div>
          {data.tipo ? <span style={ok}>✓ {data.tipo.toLowerCase()}</span> : <span style={{ color: 'var(--yellow)', fontWeight: 650 }}>a definir a mano</span>}
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>Archivos adjuntos</div>
          {/* Desglosado: el total decía "4 archivos" y abajo se veían 2, que son los PDF. Los
              otros eran una foto y la planilla de personas. */}
          {data.adjuntos > 0
            ? <span style={ok}>✓ {[
                data.desglose?.pdfs ? `${data.desglose.pdfs} PDF` : null,
                data.desglose?.imagenes ? `${data.desglose.imagenes} ${data.desglose.imagenes === 1 ? 'imagen' : 'imágenes'}` : null,
                data.desglose?.otros ? `${data.desglose.otros} otro(s)` : null,
              ].filter(Boolean).join(' · ') || `${data.adjuntos} archivo(s)`}</span>
            : <span style={no}>✕ sin adjuntos</span>}
        </div>
      </div>

      {/* El correo cita la orden de otro local. Los dos nombres juntos, que es lo que hay que
          comparar para decidir: de quién es la orden, y por quién escribe siempre el remitente. */}
      {data.conflicto && (
        <div className="alert warn" style={{ marginTop: 10, fontSize: 13.5 }}>
          <div style={{ fontWeight: 650, marginBottom: 6 }}>⚠ La orden que cita es de otro local</div>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 6 }}>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>La orden {data.conflicto.nroOrden ?? ''} es de</div>
              <strong>{data.conflicto.orden}</strong>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>Pero {data.conflicto.direccion} siempre escribió por</div>
              <strong>{data.conflicto.remitente}</strong>
            </div>
          </div>
          <div className="muted">
            No se sumó a ninguna solicitud y no se tocó nada. Si el número está bien, <strong>Procesar</strong>
            lo suma a esa orden; si en realidad es un pedido del remitente, <strong>Es otro pedido</strong> le abre la suya.
          </div>
        </div>
      )}

      {/* A dónde va a ir: es lo que más cambia el resultado de tocar "Procesar igual". */}
      <div style={{ marginTop: 10, fontSize: 13 }}>
        <span className="muted" style={{ fontSize: 12 }}>Al procesarlo… </span>
        {data.solicitudDestino
          ? <span style={ok}>se suma a la solicitud {data.solicitudDestino.nroOrden ?? `#${data.solicitudDestino.id}`} · {data.solicitudDestino.local}</span>
          : <span>se crea una <strong>solicitud nueva</strong></span>}
      </div>

      {data.descartadas > 0 && (
        <div style={{ fontSize: 12.5, marginTop: 8, color: 'var(--yellow)' }}>
          Se descartan {data.descartadas} fila(s) del cuerpo que no parecen una persona (suele ser el teléfono o la dirección de la firma).
        </div>
      )}
      {data.personas === 0 && (
        <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
          Sin personas legibles. Si la nómina vino como <strong>imagen o PDF</strong>, el sistema no la puede leer:
          hay que pedirla en Excel, o cargar las personas a mano.
        </div>
      )}
    </div>
  );
}

export default function Respaldo() {
  const { data, loading, reload } = useFetch<Row[]>('/emails/respaldo', []);
  const nav = useNavigate();
  const { notify } = useToast();
  const confirm = useConfirm();
  const [abierto, setAbierto] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  /**
   * `nuevaSolicitud` ignora a qué solicitud cree el sistema que pertenece el correo y abre una
   * aparte. La detección automática acierta casi siempre, pero cuando se equivoca no había forma
   * de imponerle el criterio propio desde la pantalla: 'Procesar igual' respetaba su lectura y
   * terminaba sumando el correo a la solicitud equivocada, o negándose a procesarlo.
   */
  const procesar = async (r: Row, nuevaSolicitud = false) => {
    const mensaje = nuevaSolicitud
      ? 'Crear una solicitud NUEVA con este correo, ignorando la solicitud a la que el sistema cree que pertenece. Usalo cuando sabés que es otro trabajo.'
      : r.destino
        ? `Sumar la documentación y las personas de este correo a la solicitud ${r.destino.nroOrden ?? `#${r.destino.id}`} (${r.destino.local})?`
        : 'Dar de alta este correo como una solicitud nueva? No pertenece a ninguna existente.';
    const titulo = nuevaSolicitud ? 'Crear solicitud nueva' : r.destino ? `Sumar a ${r.destino.nroOrden ?? 'la solicitud'}` : 'Crear solicitud';
    if (!await confirm({ title: titulo, message: mensaje, confirmLabel: titulo })) return;
    setBusy(r.id);
    try {
      const res = await api.post<{ estado: string; motivo: string | null }>(`/emails/${r.id}/procesar`, { nuevaSolicitud });
      // NEEDS_REVIEW no es un fallo: la documentación se sumó a una solicitud que ya se había
      // informado al local, y queda marcada para volver a revisarse. Mostrarlo en rojo como
      // "No se pudo procesar" hacía pensar que no había pasado nada, cuando sí había pasado.
      if (res.estado === 'PROCESSED') notify('Listo: se creó o se actualizó la solicitud.', 'success');
      else if (res.estado === 'NEEDS_REVIEW') notify(res.motivo ?? 'Se sumó a una solicitud ya informada: hay que volver a revisarla.', 'info');
      else notify(`No se pudo procesar: ${res.motivo ?? res.estado}`, 'error');
      reload(); avisarRespaldoCambio();
    } catch (e: any) { notify(e.message, 'error'); } finally { setBusy(null); }
  };
  const descartar = async (r: Row) => {
    if (!await confirm({ title: 'Descartar correo', message: 'Descartar este correo del respaldo? Se marca como revisado y sale de la lista (no se borra).', confirmLabel: 'Descartar' })) return;
    setBusy(r.id);
    try { await api.post(`/emails/${r.id}/descartar`); notify('Correo descartado del respaldo.', 'success'); reload(); avisarRespaldoCambio(); }
    catch (e: any) { notify(e.message, 'error'); } finally { setBusy(null); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Respaldo de correos</h1><div className="subtitle">Correos que no terminaron en una solicitud automática: revisalos a mano</div></div>
      </div>

      <div className="alert info" style={{ marginBottom: 16 }}>
        Acá caen los correos con error, sin planilla legible, con demasiadas personas, o que son
        <strong> respuestas/reenvíos</strong> de un pedido anterior. Revisalos, cargá lo que corresponda
        en la solicitud original y después <strong>descartalos</strong> para sacarlos de la lista.
      </div>

      <div className="card">
        <div className="table-wrap">
          {loading ? <div className="card-body"><Spinner /></div> : (
            <table className="tbl">
              <thead><tr><th>Recibido</th><th>Remitente</th><th>Asunto</th><th>Estado</th><th>Motivo</th><th></th></tr></thead>
              <tbody>
                {data?.length === 0 && <tr><td colSpan={6} className="empty">No hay correos en respaldo. 🎉</td></tr>}
                {data?.map((r) => (
                  <Fragment key={r.id}>
                    {/* La fila entera abre el correo: un botón menos y el gesto es el que se espera
                        de una lista. Los botones de acción cortan la propagación. */}
                    <tr onClick={() => setAbierto(abierto === r.id ? null : r.id)} style={{ cursor: 'pointer' }} title={abierto === r.id ? 'Cerrar el correo' : 'Ver el correo'}>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-block', width: 14, color: 'var(--muted)' }}>{abierto === r.id ? '▾' : '▸'}</span>
                        {fmtFecha(r.fechaRecibido)}
                      </td>
                      <td>{r.remitente ?? '—'}</td>
                      <td>
                        <strong>{r.asunto ?? '(sin asunto)'}</strong>
                        {r.attachmentsCount > 0 && <span className="chip" style={{ marginLeft: 6 }}>📎 {r.attachmentsCount}</span>}
                        {r.localDetectado && <div className="muted" style={{ fontSize: 12 }}>Local detectado en el asunto: <strong>{r.localDetectado}</strong></div>}
                      </td>
                      <td><span className={`badge ${r.estado === 'ERROR' ? 'red' : 'orange'}`}>{ESTADO_LABEL[r.estado] ?? r.estado}</span></td>
                      <td style={{ maxWidth: 320, fontSize: 12.5 }}>
                        {r.motivo ?? '—'}
                        {r.aviso && <div style={{ marginTop: 4, color: 'var(--ok, #15803d)' }}>✓ Ya se le avisó el {fmtFecha(r.aviso.fecha)}</div>}
                        {r.solicitud && (
                          <div style={{ marginTop: 4 }}>
                            <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); nav(`/solicitudes/${r.solicitud!.id}`); }}>
                              → Ir a la solicitud{r.solicitud.nroOrden ? ` ${r.solicitud.nroOrden}` : ''} · {r.solicitud.local}
                            </button>
                          </div>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <span className="btn-row">
                          {/* El botón dice a dónde va a ir. Cuando no pertenece a ninguna solicitud,
                              "Es otro pedido" hacía exactamente lo mismo que "Procesar" y sobraba. */}
                          <button className="btn sm" disabled={busy === r.id} onClick={() => procesar(r)}
                            title={r.destino ? `Suma la documentación y las personas de este correo a esa solicitud` : 'Crea una solicitud nueva con este correo'}>
                            {r.destino ? `Sumar a ${r.destino.nroOrden ?? `#${r.destino.id}`}` : 'Crear solicitud'}
                          </button>
                          {r.destino && (
                            <button className="btn ghost sm" disabled={busy === r.id} onClick={() => procesar(r, true)} title="Abrir una solicitud aparte, ignorando la solicitud a la que el sistema cree que pertenece">Es otro pedido</button>
                          )}
                          <button className="btn ghost sm" disabled={busy === r.id} onClick={() => descartar(r)}>Descartar</button>
                        </span>
                      </td>
                    </tr>
                    {abierto === r.id && (
                      <tr>
                        <td colSpan={6} style={{ background: 'var(--panel-2)' }}>
                          <QueDetecta emailId={r.id} />
                          <EmailInline emailId={r.id} wide />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
