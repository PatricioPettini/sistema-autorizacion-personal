import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useFetch } from '../hooks';
import { Badge, Spinner, Modal, useToast, useConfirm } from '../ui';
import { api, fmtFecha, tipoLabel, hoy } from '../api';
import { useAuth } from '../auth';

interface Row { id: number; estado: string; updatedAt: string; fecha: string | null; local: string; localId: number; emailAsunto: string | null; personasCount: number; personasLabel: string; tipo: string | null; nroOrden: string | null; docNuevaAt: string | null; }
interface Local { id: number; nombre: string; }

const PLACEHOLDER_PEGADO = '20-30410849-0\tJuan Pérez\n27-12345678-4\tMaría Gómez';
const ESTADOS = ['', 'PENDIENTE', 'EN_REVISION', 'OBSERVADA', 'AUTORIZADA', 'RECHAZADA', 'REVOCADA'];
interface FilaPersona { cuil: string; dni: string; apellido: string; nombre: string; }
const FILA_VACIA: FilaPersona = { cuil: '', dni: '', apellido: '', nombre: '' };
const VACIO = { local: '', categoria: '', personas: [{ ...FILA_VACIA }] as FilaPersona[] };

/** Compara nombres de local ignorando mayúsculas, acentos y espacios de más. */
const normLocal = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

export default function Solicitudes() {
  const [params, setParams] = useSearchParams();
  const [estado, setEstado] = useState(params.get('estado') ?? '');
  const [localId, setLocalId] = useState('');
  const [q, setQ] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  // Si llega ?estado= desde el panel, aplicarlo.
  useEffect(() => { setEstado(params.get('estado') ?? ''); }, [params.get('estado')]);

  const query = new URLSearchParams();
  if (estado) query.set('estado', estado);
  if (localId) query.set('localId', localId);
  if (q) query.set('q', q);
  if (desde) query.set('desde', desde);
  if (hasta) query.set('hasta', hasta);

  const { data, loading, reload } = useFetch<Row[]>(`/solicitudes?${query.toString()}`, [estado, localId, q, desde, hasta]);
  const { data: locales } = useFetch<Local[]>('/locales');
  const nav = useNavigate();
  const isAdmin = useAuth().user?.rol === 'ADMIN';
  const { notify } = useToast();
  const confirm = useConfirm();
  const [nueva, setNueva] = useState(false);
  const [form, setForm] = useState(VACIO);
  const [pegar, setPegar] = useState(false);
  const [pegado, setPegado] = useState('');
  const [busy, setBusy] = useState(false);
  const [eliminando, setEliminando] = useState<number | null>(null);

  const eliminar = async (r: Row) => {
    const n = r.personasCount;
    // El texto decía "se borra... no se puede deshacer", que es lo que hace el borrado definitivo
    // de la papelera, no este botón. Lo importante que NO decía: las autorizaciones siguen vigentes,
    // así que la solicitud desaparece del listado pero esa gente sigue pudiendo entrar.
    if (!await confirm({
      title: 'Mandar a la papelera',
      danger: true,
      confirmLabel: 'Mandar a la papelera',
      message: `¿Mandar a la papelera la solicitud de "${r.local}"${n ? ` (${n} ${n === 1 ? 'persona' : 'personas'})` : ''}?\n\nDesaparece del listado, pero se puede restaurar desde Papelera.\n\nOJO: las autorizaciones NO se tocan. Si esa gente está autorizada, sigue pudiendo ingresar aunque la solicitud no se vea.`,
    })) return;
    setEliminando(r.id);
    try {
      await api.del<{ ok: boolean; papelera: boolean }>(`/solicitudes/${r.id}`);
      notify('Solicitud enviada a la papelera. Se puede restaurar desde ahí.', 'success');
      reload();
    } catch (e: any) { notify(e.message, 'error'); } finally { setEliminando(null); }
  };

  const localesReales = (locales ?? []).filter((l) => l.nombre !== '(Sin asignar)');

  const cambiarEstado = (e: string) => { setEstado(e); setParams(e ? { estado: e } : {}); };

  // El local se escribe libremente: si el texto coincide con uno cargado se reusa,
  // si no, se crea al guardar (igual que hace el lector de emails con el asunto).
  const localExistente = localesReales.find((l) => normLocal(l.nombre) === normLocal(form.local));
  const localEsNuevo = !!form.local.trim() && !localExistente;

  // Filas de personas del formulario (una solicitud = un local + varias personas).
  const setFila = (i: number, campo: keyof FilaPersona, v: string) =>
    setForm({ ...form, personas: form.personas.map((p, j) => (j === i ? { ...p, [campo]: v } : p)) });
  const addFila = () => setForm({ ...form, personas: [...form.personas, { ...FILA_VACIA }] });
  const delFila = (i: number) => setForm({ ...form, personas: form.personas.length === 1 ? [{ ...FILA_VACIA }] : form.personas.filter((_, j) => j !== i) });

  // Pegado masivo: una persona por línea. El CUIL se detecta por ser el token con
  // 10+ dígitos, así que da igual si viene antes o después del nombre, y sirve
  // cualquier separador (tab de Excel, coma, punto y coma o espacios).
  const pegarLista = (texto: string) => {
    const filas: FilaPersona[] = [];
    for (const linea of texto.split(/\r?\n/)) {
      const tokens = linea.split(/[\t;,]+|\s+/).map((x) => x.trim()).filter(Boolean);
      // Se acepta el CUIL (10-11 dígitos) o el DNI (7-8): antes solo miraba 10 o más, así que una
      // lista pegada con DNI no reconocía ninguna línea.
      const largoDoc = (x: string) => x.replace(/\D/g, '').length;
      const iCuil = tokens.findIndex((x) => largoDoc(x) >= 10 || [7, 8].includes(largoDoc(x)));
      if (iCuil < 0) continue;
      // Igual que el Excel: la primera palabra es el nombre, el resto el apellido.
      const resto = tokens.filter((_, k) => k !== iCuil);
      // El token de documento puede ser un CUIL (11) o un DNI (7-8): va al campo que corresponde.
      const doc = tokens[iCuil].replace(/\D/g, '');
      const esCuil = doc.length >= 10;
      filas.push({ cuil: esCuil ? doc : '', dni: esCuil ? '' : doc, nombre: resto[0] ?? '', apellido: resto.slice(1).join(' ') });
    }
    if (filas.length === 0) { notify('No se reconoció ninguna persona. Cada línea necesita un CUIL o un DNI.', 'error'); return; }
    const previas = form.personas.filter((p) => p.cuil || p.dni || p.nombre || p.apellido);
    setForm({ ...form, personas: [...previas, ...filas] });
    notify(`${filas.length} ${filas.length === 1 ? 'persona agregada' : 'personas agregadas'}.`, 'success');
  };

  const crear = async () => {
    const nombreLocal = form.local.trim();
    if (!nombreLocal) { notify('Elegí un local o escribí uno nuevo.', 'error'); return; }
    const personas = form.personas
      .map((p) => ({ cuil: p.cuil.replace(/\D/g, ''), dni: p.dni.replace(/\D/g, ''), nombre: p.nombre.trim(), apellido: p.apellido.trim() }))
      .filter((p) => p.cuil || p.dni || p.nombre || p.apellido);
    if (personas.length === 0) { notify('Cargá al menos una persona.', 'error'); return; }
    // Con el CUIL o el DNI alcanza para identificarla.
    const mala = personas.findIndex((p) => !(p.cuil.length >= 10 || [7, 8].includes(p.dni.length)) || !(p.nombre || p.apellido));
    if (mala >= 0) { notify(`Revisá la persona ${mala + 1}: falta el nombre, o el CUIL (11 dígitos) o el DNI (7 u 8).`, 'error'); return; }
    setBusy(true);
    try {
      // Si coincide con uno cargado se reusa; si no, el backend lo crea.
      const r = await api.post<{ solicitudId: number; personas: number; local: { nombre: string; creado: boolean } }>('/solicitudes/manual', {
        localId: localExistente?.id,
        localNombre: localExistente ? undefined : nombreLocal,
        categoria: form.categoria || undefined,
        personas,
      });
      const cuantas = `${r.personas} ${r.personas === 1 ? 'persona' : 'personas'}`;
      notify(r.local?.creado ? `Local "${r.local.nombre}" creado y solicitud cargada con ${cuantas}.` : `Solicitud creada con ${cuantas}.`, 'success');
      setNueva(false); setForm(VACIO); reload();
      nav(`/solicitudes/${r.solicitudId}`);
    } catch (e: any) { notify(e.message, 'error'); } finally { setBusy(false); }
  };

  // Atajos de fecha (rango en días, en zona local).
  const hoyStr = hoy();
  const menosDias = (n: number) => { const d = new Date(`${hoyStr}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const presets = [
    { k: 'hoy', label: 'Hoy', d: hoyStr, h: hoyStr },
    { k: 'ayer', label: 'Ayer', d: menosDias(1), h: menosDias(1) },
    { k: '7', label: 'Últimos 7 días', d: menosDias(6), h: hoyStr },
    { k: 'mes', label: 'Este mes', d: `${hoyStr.slice(0, 8)}01`, h: hoyStr },
  ];
  const hayFiltros = !!(desde || hasta || estado || localId || q);
  const limpiar = () => { setDesde(''); setHasta(''); setLocalId(''); setQ(''); cambiarEstado(''); };

  return (
    <>
      <div className="page-head">
        <div><h1>Solicitudes</h1><div className="subtitle">Cada solicitud es un local con una o varias personas a autorizar</div></div>
        {isAdmin && <button className="btn primary" onClick={() => { setForm({ ...VACIO, personas: [{ ...FILA_VACIA }] }); setPegar(false); setPegado(''); setNueva(true); }}>+ Nueva solicitud</button>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head" style={{ fontSize: 13 }}>
          <span>🔎 Filtros</span>
          {hayFiltros && <button className="btn ghost sm" onClick={limpiar}>Limpiar filtros</button>}
        </div>
        <div className="card-body" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div className="field" style={{ margin: 0, minWidth: 150 }}>
            <label>Estado</label>
            <select value={estado} onChange={(e) => cambiarEstado(e.target.value)}>
              {ESTADOS.map((e) => <option key={e} value={e}>{e === '' ? 'Todos' : e.replace('_', ' ')}</option>)}
            </select>
          </div>
          <div className="field" style={{ margin: 0, minWidth: 150 }}>
            <label>Local</label>
            <select value={localId} onChange={(e) => setLocalId(e.target.value)}>
              <option value="">Todos</option>
              {locales?.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Fecha de envío</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="date" value={desde} max={hasta || undefined} onChange={(e) => setDesde(e.target.value)} style={{ width: 150 }} />
              <span className="muted">→</span>
              <input type="date" value={hasta} min={desde || undefined} onChange={(e) => setHasta(e.target.value)} style={{ width: 150 }} />
            </div>
            <div className="btn-row" style={{ marginTop: 8, gap: 6 }}>
              {presets.map((p) => {
                const activo = desde === p.d && hasta === p.h;
                return <button key={p.k} className={`btn sm ${activo ? 'primary' : 'ghost'}`} style={{ padding: '3px 10px', fontSize: 12, border: activo ? undefined : '1px solid var(--border)' }} onClick={() => { setDesde(p.d); setHasta(p.h); }}>{p.label}</button>;
              })}
            </div>
          </div>
          <div className="field" style={{ margin: 0, flex: 1, minWidth: 180 }}>
            <label>Buscar persona / CUIL / orden</label>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nombre, CUIL o N° de orden" />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          {loading ? <div className="card-body"><Spinner /></div> : (
            <table className="tbl">
              <thead><tr><th>Orden</th><th>Local</th><th>Tipo</th><th>Personas</th><th>Estado</th><th>Enviado</th><th>Actualizado</th>{isAdmin && <th></th>}</tr></thead>
              <tbody>
                {data?.length === 0 && <tr><td colSpan={isAdmin ? 8 : 7} className="empty">No hay solicitudes con esos filtros.</td></tr>}
                {data?.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/solicitudes/${r.id}`)}>
                    <td>{r.nroOrden ? <span className="chip">{r.nroOrden}</span> : <span className="muted">—</span>}</td>
                    <td><strong>{r.local === '(Sin asignar)' ? <span className="badge orange">Sin asignar</span> : r.local}</strong></td>
                    <td>{r.tipo ? <span className="chip">{tipoLabel(r.tipo)}</span> : <span className="muted">—</span>}</td>
                    <td>
                      <span className="chip">{r.personasCount} {r.personasCount === 1 ? 'persona' : 'personas'}</span>
                      <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>{r.personasLabel || '—'}</div>
                    </td>
                    <td>
                      <Badge estado={r.estado} />
                      {/* Llegó documentación DESPUÉS de informarle el resultado al local: hay que
                          volver a revisarla. El aviso va acá, en la solicitud, y no en el respaldo:
                          el correo se procesó bien y su documentación ya está adentro. */}
                      {r.docNuevaAt && (
                        <div style={{ marginTop: 4 }}>
                          <span className="badge orange" title={`Llegó documentación el ${fmtFecha(r.docNuevaAt)}, después de informar el resultado`}>📎 Documentación nueva</span>
                        </div>
                      )}
                    </td>
                    <td className="muted">{fmtFecha(r.fecha)}</td>
                    <td className="muted">{fmtFecha(r.updatedAt)}</td>
                    {isAdmin && <td onClick={(e) => e.stopPropagation()}><button className="btn ghost sm" title="Eliminar solicitud" disabled={eliminando === r.id} onClick={() => eliminar(r)}>{eliminando === r.id ? '…' : '🗑'}</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {nueva && (
        <Modal title="Nueva solicitud" onClose={() => setNueva(false)}
          footer={<><button className="btn" onClick={() => setNueva(false)}>Cancelar</button><button className="btn primary" onClick={crear} disabled={busy}>Crear solicitud</button></>}>
          <div className="alert info">Una solicitud es <strong>un local con una o varias personas</strong>. Cargá todas las que necesites. Si un CUIL ya existe, se usa esa persona (no se duplica).</div>
          <div className="form-row">
            <div className="field"><label>Local *</label>
              <input list="locales-cargados" value={form.local} onChange={(e) => setForm({ ...form, local: e.target.value })}
                placeholder="Elegí uno o escribí el nombre" autoComplete="off" />
              <datalist id="locales-cargados">
                {localesReales.map((l) => <option key={l.id} value={l.nombre} />)}
              </datalist>
              <div className="hint">
                {localEsNuevo
                  ? <>➕ No está cargado: se va a crear el local <strong>“{form.local.trim()}”</strong>.</>
                  : localExistente ? <>✓ Local ya cargado.</> : <>Escribí para buscar entre los {localesReales.length} cargados, o poné uno nuevo.</>}
              </div>
            </div>
            <div className="field"><label>Tipo de contratista</label>
              <select value={form.categoria} onChange={(e) => setForm({ ...form, categoria: e.target.value })}>
                <option value="">Definir después</option>
                <option value="EMPRESA">Empresa</option>
                <option value="MONOTRIBUTISTA">Monotributista</option>
              </select>
              <div className="hint">Define qué documentación se le exige a cada persona.</div>
            </div>
          </div>

          <label style={{ fontWeight: 600, fontSize: 13, display: 'block', marginTop: 4 }}>Personas *</label>
          <div className="table-wrap" style={{ marginBottom: 8 }}>
            <table className="tbl">
              <thead><tr><th style={{ width: 28 }}>#</th><th>Apellido</th><th>Nombre</th><th style={{ width: 170 }}>CUIL</th><th style={{ width: 130 }}>o DNI</th><th style={{ width: 40 }}></th></tr></thead>
              <tbody>
                {form.personas.map((p, i) => (
                  <tr key={i}>
                    <td className="muted">{i + 1}</td>
                    <td><input value={p.apellido} onChange={(e) => setFila(i, 'apellido', e.target.value)} placeholder="Pérez" /></td>
                    <td><input value={p.nombre} onChange={(e) => setFila(i, 'nombre', e.target.value)} placeholder="Juan" /></td>
                    <td><input value={p.cuil} onChange={(e) => setFila(i, 'cuil', e.target.value)} placeholder="20-30410849-0" /></td>
                    <td><input value={p.dni} onChange={(e) => setFila(i, 'dni', e.target.value)} placeholder="30410849" /></td>
                    <td><button className="btn ghost sm" onClick={() => delFila(i)} title="Quitar fila">✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="btn-row">
            <button className="btn sm" onClick={addFila}>+ Agregar otra persona</button>
            <button className="btn ghost sm" onClick={() => setPegar(!pegar)}>{pegar ? 'Ocultar pegado masivo' : '📋 Pegar lista'}</button>
          </div>
          {pegar && (
            <div className="field" style={{ marginTop: 10 }}>
              <label>Pegar varias personas (una por línea)</label>
              <textarea rows={5} value={pegado} onChange={(e) => setPegado(e.target.value)} placeholder={PLACEHOLDER_PEGADO} />
              <div className="hint">Cada línea necesita un CUIL y el nombre (formato <em>Nombre Apellido</em>, igual que el Excel). Sirve para copiar y pegar directo de un Excel o del cuerpo del email.</div>
              <button className="btn sm" style={{ marginTop: 6 }} onClick={() => { pegarLista(pegado); setPegado(''); }}>Agregar a la lista</button>
            </div>
          )}
          {localesReales.length === 0 && <div className="alert info">Todavía no hay locales cargados. Escribí el nombre acá y se crea junto con la solicitud.</div>}
        </Modal>
      )}
    </>
  );
}
