import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useFetch } from '../hooks';
import { api, fmtFecha, fmtSoloFecha, tipoLabel, hoy } from '../api';
import { Badge, Spinner, Modal, useToast, useConfirm } from '../ui';
import { DocList } from '../components/DocList';
import { EmailInline } from '../components/EmailInline';
import { SolicitudDocumentacion } from '../components/SolicitudDocumentacion';
import { SentEmails } from '../components/SentEmails';
import { SolicitudDocList } from '../components/SolicitudDocList';
import { useAuth } from '../auth';

type AccionModal = { tipo: 'observar' | 'rechazar'; personaId: number; solicitudId: number; nombre: string };

/** Extrae el nombre del local del asunto (mismo criterio flexible que el backend). */
function localFromAsunto(asunto?: string | null): string | null {
  if (!asunto) return null;
  const s = asunto.trim();
  const limpiar = (x: string) =>
    x.replace(/\b(empresas?|monotributistas?|mono)\b/gi, '')
      .replace(/[()\-–—:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  if (/\bfao\b/i.test(s)) {
    const par = s.match(/\(([^)]+)\)/);
    if (par) { const n = limpiar(par[1]); if (n) return n; }
  }
  const m = s.match(/\bfao\b\s*(.+)$/i);
  if (m) {
    let rest = m[1].replace(/^[\s\-–—:]+/, '');
    rest = rest.split(/\b(?:para|de\s+ingreso|ingreso|egreso)\b|[-–—:|]/i)[0];
    const n = limpiar(rest);
    if (n) return n;
  }
  return null;
}

export default function SolicitudDetalle() {
  const { id } = useParams();
  const { data, reload } = useFetch<any>(`/solicitudes/${id}`, [id]);
  const { data: locales } = useFetch<any[]>('/locales', []);
  const { data: tiposDoc } = useFetch<any[]>('/tipos-documento', []);
  const isAdmin = useAuth().user?.rol === 'ADMIN';
  const { notify } = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();

  // Catálogo de requisitos EXTRA que se pueden agregar durante la revisión.
  const catalogoExtra = (tiposDoc ?? []).filter((t: any) => t.categoria === 'EXTRA' && t.activo);

  const [revisando, setRevisando] = useState(false);
  const [confirmarTerminar, setConfirmarTerminar] = useState(false);
  const [resultado, setResultado] = useState<{ nroOrden: string | null; emailEnviado: boolean; to: string; motivo: string | null } | null>(null);
  const [venc, setVenc] = useState('');
  // Hasta cuándo alcanza la documentación, leída de los propios papeles. Es una sugerencia para no
  // tipear la fecha a mano: se precarga, pero no queda guardada hasta que la confirman.
  const { data: analisis } = useFetch<{
    activo: boolean;
    vigenciaSugerida: { fecha: string; archivos: string[]; vencida: boolean } | null;
    /** Quién de la solicitud aparece nombrado en los papeles, y en cuáles. */
    cubiertas?: { personaId: number; en: string[] }[];
  }>(
    revisando ? `/emails/solicitud/${id}/analisis` : null, [id, revisando]);
  const sugerida = analisis?.activo ? analisis.vigenciaSugerida : null;
  const [accion, setAccion] = useState<AccionModal | null>(null);
  const [comentario, setComentario] = useState('');
  const [nuevoComentario, setNuevoComentario] = useState('');
  const [busy, setBusy] = useState(false);
  const [agregar, setAgregar] = useState(false);
  const [nuevaPersona, setNuevaPersona] = useState({ cuil: '', dni: '', nombre: '', apellido: '', categoria: '' });
  const [edit, setEdit] = useState<{ personaId: number; cuil: string; nombre: string; apellido: string } | null>(null);
  const [nuevoLocal, setNuevoLocal] = useState('');
  const [cambiandoLocal, setCambiandoLocal] = useState(false);
  const [reqPersona, setReqPersona] = useState<{ personaId: number; nombre: string } | null>(null);
  const [reqSel, setReqSel] = useState('');
  const [reqNombre, setReqNombre] = useState('');
  const [reqSolOpen, setReqSolOpen] = useState(false);
  const [reqSolSel, setReqSolSel] = useState('');
  const [reqSolNombre, setReqSolNombre] = useState('');
  // null = todavía no lo tocó nadie, así que manda el valor por defecto: abierto cuando la
  // solicitud no tiene personas (hay que leer el mail para cargarlas a mano). Antes esto era un
  // booleano y el panel se abría con `verEmail || personas.length === 0`, así que en una solicitud
  // sin personas el botón "Ocultar" cambiaba el estado y no cerraba nada: quedaba muerto.
  const [verEmail, setVerEmail] = useState<boolean | null>(null);
  const [buscarRev, setBuscarRev] = useState('');
  const [trabajoTxt, setTrabajoTxt] = useState('');
  const [editTrabajo, setEditTrabajo] = useState(false);

  // Sincronizar el campo de vencimiento con lo que trae la solicitud.
  useEffect(() => { if (data?.solicitud) setVenc(data.solicitud.fechaVencimiento ?? ''); }, [data?.solicitud?.fechaVencimiento]);
  // No se precarga la fecha de los papeles: medido sobre 153 solicitudes, la vigencia que se carga
  // a mano no sale de ningún documento (va a ~30 días del pedido). Precargarla con la del papel
  // sería empujar a una fecha que nadie usa. El papel se usa para AVISAR, abajo.
  useEffect(() => { if (data?.solicitud) setTrabajoTxt(data.solicitud.trabajo ?? ''); }, [data?.solicitud?.trabajo]);

  /**
   * Fichas que podrían ser la misma persona. Es la única red contra el typo de un dígito: ese
   * documento existe y es válido, así que ninguna búsqueda exacta lo puede frenar. Avisa, no bloquea.
   */
  const [parecidas, setParecidas] = useState<any[]>([]);
  useEffect(() => {
    if (!agregar) { setParecidas([]); return; }
    const { cuil, dni, nombre, apellido } = nuevaPersona;
    if (!(cuil || dni) && !(nombre && apellido)) { setParecidas([]); return; }
    // Espera a que dejen de tipear: si no, se consulta con el documento a medio escribir.
    const t = setTimeout(() => {
      const q = new URLSearchParams({ cuil, dni, nombre, apellido }).toString();
      api.get<{ parecidas: any[] }>(`/personas/parecidas?${q}`)
        .then((r) => setParecidas(r.parecidas))
        .catch(() => setParecidas([]));
    }, 400);
    return () => clearTimeout(t);
  }, [agregar, nuevaPersona.cuil, nuevaPersona.dni, nuevaPersona.nombre, nuevaPersona.apellido]);

  /** Aprobar un requisito para varias personas: qué requisito y a quiénes. */
  const [enBloque, setEnBloque] = useState<{ tipoId: number; nombre: string } | null>(null);
  const [elegidas, setElegidas] = useState<Set<number>>(new Set());

  // Todos los hooks van ANTES de este return: uno que quede después hace que en el primer render
  // (sin datos) React cuente menos hooks que en el siguiente, y la página queda en blanco.
  if (!data) return <Spinner />;
  const { solicitud, local, email, comentarios, personas, solicitudDocs } = data;
  const sinLocal = local?.nombre === '(Sin asignar)';
  // Sin personas el email arranca abierto, porque es de donde se sacan; una vez que alguien
  // tocó el botón, manda lo que eligió.
  const emailAbierto = verEmail ?? personas.length === 0;
  const localSugerido = localFromAsunto(email?.asunto);
  const catsSolicitud = new Set<string>(personas.map((p: any) => p.docStatus?.categoria).filter(Boolean));
  const tipoSolicitud = catsSolicitud.size === 0 ? null : catsSolicitud.size === 1 ? [...catsSolicitud][0] : 'MIXTO';
  // No se puede terminar la revisión si a alguna persona le falta el tipo (empresa/monotributo).
  const personasSinTipo = (personas as any[]).filter((p: any) => !p.docStatus?.categoria);
  const faltaTipo = personasSinTipo.length > 0;
  const fechaVenc = solicitud.fechaVencimiento as string | null;
  // La fecha de vencimiento solo hace falta si al menos una persona va a quedar autorizada.
  // Si están todas rechazadas o con documentación incompleta, se puede terminar (y enviar el
  // email de rechazo) sin cargar fecha.
  const hayAutorizable = (personas as any[]).some((p: any) => p.autorizable && p.estado !== 'RECHAZADA');
  const requiereFecha = hayAutorizable && !fechaVenc;
  // El campo muestra la fecha que sugirieron los papeles y la solicitud todavía no la tiene guardada.
  // La fecha que va a regir: la que está en el campo, o la ya guardada.
  const vigenciaElegida = venc || fechaVenc || null;
  // Un papel que vence ANTES de la vigencia deja gente autorizada con la documentación ya vencida.
  // Pasa de verdad: hay autorizaciones hasta octubre con la ART vencida en marzo.
  const papelVenceAntes = !!(sugerida && vigenciaElegida && sugerida.fecha < vigenciaElegida);

  // No se puede terminar/enviar si quedó algún documento SIN decidir (ni aprobado ni marcado
  // como falta). Se ignoran personas ya rechazadas/reemplazadas.
  const solDocPend = (solicitudDocs?.items ?? []).some((it: any) => it.verificacion === 'PENDIENTE');
  const perDocPend = (personas as any[]).some((p: any) => !['RECHAZADA', 'REEMPLAZADA'].includes(p.estado) && (p.docStatus?.items ?? []).some((it: any) => it.verificacion === 'PENDIENTE'));
  const revisionIncompleta = solDocPend || perDocPend;

  const run = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    try { await fn(); notify(ok, 'success'); reload(); }
    catch (e: any) { notify(e.message, 'error'); }
    finally { setBusy(false); }
  };

  const cerrarAccion = () => { setAccion(null); setComentario(''); };
  const confirmarAccion = async () => {
    if (!accion) return;
    const { tipo, personaId, solicitudId } = accion;
    if (tipo === 'observar') await run(() => api.post(`/solicitudes/${solicitudId}/personas/${personaId}/observar`, { comentario }), 'Persona observada.');
    else if (tipo === 'rechazar') await run(() => api.post(`/solicitudes/${solicitudId}/personas/${personaId}/rechazar`, { motivo: comentario }), 'Persona rechazada.');
    cerrarAccion();
  };

  /**
   * Vigencia propia de una persona. Vacío = vuelve a regir la general de la solicitud, que es lo
   * normal: esto es la excepción para quien entra por menos días o tiene la documentación
   * venciendo antes que el resto.
   */
  /**
   * Pedirle al local la nómina en un formato legible.
   *
   * El correo automático se sacó: la mayoría de las veces la nómina está adentro del PDF y se carga
   * a mano, y ese aviso quedaba mal porque el local ya la había mandado. Ahora se manda desde acá,
   * cuando quien revisa miró la documentación y no la encontró.
   */
  /**
   * Aprobar el mismo requisito para varias personas.
   *
   * La Nómina ART es UN papel que lista a todo el grupo, pero el requisito es por persona: en un
   * pedido de 28 había que aprobarlo 28 veces mirando siempre el mismo PDF. Medido: de 163
   * solicitudes de 2+ personas, en 110 se aprueba para TODAS y sólo en 5 para algunas sí y otras
   * no. Por eso vienen tildadas —salvo las que el papel no nombra, que es justo el caso raro—.
   */

  /** A quién nombra la documentación, para tildar sólo lo que el papel respalda. */
  const papelRespalda = (personaId: number) =>
    (analisis?.cubiertas ?? []).find((c) => c.personaId === personaId)?.en ?? [];

  const abrirEnBloque = (tipoId: number, nombre: string) => {
    setEnBloque({ tipoId, nombre });
    setElegidas(new Set(
      personas
        .filter((p: any) => {
          const it = (p.docStatus?.items ?? []).find((x: any) => x.tipoId === tipoId);
          if (!it || it.verificacion === 'VERIFICADO') return false;   // ya aprobado: no se re-toca
          // Si el análisis está andando, se tilda sólo a quien el papel nombra. Si no hay análisis,
          // se tilda a todos: volver a la conducta de antes es mejor que no ofrecer nada.
          return !analisis?.activo || papelRespalda(p.personaId).length > 0;
        })
        .map((p: any) => p.personaId),
    ));
  };

  /** Las personas de la solicitud, con las que ya tienen el requisito aprobado al final. */
  const personasDelBloque = !enBloque ? [] : [...(personas as any[])].sort((a, b) => {
    const ok = (p: any) => ((p.docStatus?.items ?? []).find((x: any) => x.tipoId === enBloque.tipoId)?.verificacion === 'VERIFICADO' ? 1 : 0);
    return ok(a) - ok(b);
  });

  const aprobarEnBloque = async () => {
    if (!enBloque || elegidas.size === 0) return;
    await run(
      () => api.post('/documentos/verificar-varios', {
        personaIds: [...elegidas], tipoDocumentoId: enBloque.tipoId, estado: 'VERIFICADO',
      }),
      `${enBloque.nombre} aprobado para ${elegidas.size} persona(s).`,
    );
    setEnBloque(null);
  };

  /** Los requisitos POR PERSONA que aplican a este grupo, con cuántos ya están aprobados. */
  const requisitosDeGrupo = (() => {
    const mapa = new Map<number, { tipoId: number; nombre: string; total: number; aprobados: number }>();
    for (const p of personas as any[]) {
      for (const it of p.docStatus?.items ?? []) {
        // Los de alcance SOLICITUD se aprueban una sola vez y ya tienen su propia tarjeta arriba.
        if (!it.obligatorio) continue;
        const e = mapa.get(it.tipoId) ?? { tipoId: it.tipoId, nombre: it.nombre, total: 0, aprobados: 0 };
        e.total++;
        if (it.verificacion === 'VERIFICADO') e.aprobados++;
        mapa.set(it.tipoId, e);
      }
    }
    return [...mapa.values()];
  })();

  const pedirNomina = async () => {
    if (!await confirm({
      title: 'Pedir la nómina al remitente',
      message: `Se le manda un correo a ${email?.remitente ?? 'el remitente'} explicándole que la lista de personas tiene que venir en un Excel o escrita en el cuerpo, porque el sistema no puede leerla de una foto ni de un PDF. Queda registrado como comentario en la solicitud.`,
      confirmLabel: 'Enviar',
    })) return;
    await run(() => api.post(`/solicitudes/${solicitud.id}/pedir-nomina`), 'Se le pidió la nómina al remitente.');
  };

  const vencimientoDePersona = (personaId: number, fecha: string) =>
    run(() => api.post(`/solicitudes/${solicitud.id}/personas/${personaId}/vencimiento`, { fechaVencimiento: fecha || null }),
      fecha ? 'Vigencia propia guardada para esa persona.' : 'Vuelve a regir la vigencia general.');

  const guardarVencimiento = () => run(() => api.post(`/solicitudes/${solicitud.id}/vencimiento`, { fechaVencimiento: venc || null }), venc ? 'Fecha de vigencia guardada. Se autorizó a quienes tienen la documentación completa.' : 'Fecha de vigencia quitada.');
  const terminarRevision = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ nroOrden: string | null; emailEnviado: boolean; to: string; motivo: string | null }>(`/solicitudes/${solicitud.id}/terminar-revision`);
      setConfirmarTerminar(false);
      setResultado(r);
      reload();
    } catch (e: any) { notify(e.message, 'error'); } finally { setBusy(false); }
  };

  const asignarLocal = (localId: number) => { if (localId) run(() => api.post(`/solicitudes/${solicitud.id}/local`, { localId }), 'Local asignado.').then(() => setCambiandoLocal(false)); };
  const crearYAsignarLocal = (nombre: string) => run(async () => {
    const nuevo = await api.post<{ id: number }>('/locales', { nombre });
    await api.post(`/solicitudes/${solicitud.id}/local`, { localId: nuevo.id });
  }, `Local "${nombre}" creado y asignado.`).then(() => setCambiandoLocal(false));
  const crearLocalLibre = () => {
    const nombre = nuevoLocal.trim();
    if (!nombre) { notify('Escribí el nombre del local.', 'error'); return; }
    crearYAsignarLocal(nombre).then(() => setNuevoLocal(''));
  };
  const definirTipo = (categoria: string) => { if (categoria) run(() => api.post(`/solicitudes/${solicitud.id}/tipo`, { categoria }), 'Tipo de contratista definido.'); };
  const abrirAgregarReq = (personaId: number, nombre: string) => { setReqPersona({ personaId, nombre }); setReqSel(''); setReqNombre(''); };
  const agregarRequisito = async () => {
    if (!reqPersona) return;
    const body: any = { personaId: reqPersona.personaId, solicitudId: solicitud.id };
    if (reqNombre.trim()) body.nombre = reqNombre.trim();
    else if (reqSel) body.tipoDocumentoId = Number(reqSel);
    else { notify('Elegí un requisito de la lista o escribí uno nuevo.', 'error'); return; }
    await run(() => api.post('/documentos/requisitos', body), 'Requisito agregado.');
    setReqPersona(null); setReqSel(''); setReqNombre('');
  };
  const quitarRequisito = async (personaId: number, tipoDocumentoId: number, nombre: string) => {
    if (!await confirm({ title: 'Quitar requisito', message: `¿Quitar el requisito "${nombre}"?`, confirmLabel: 'Quitar', danger: true })) return;
    run(() => api.del(`/documentos/requisitos/${personaId}/${tipoDocumentoId}`), 'Requisito quitado.');
  };
  // Requisito EXTRA a nivel SOLICITUD (uno para todo el grupo, como el Formulario 931).
  const agregarReqSol = async () => {
    const body: any = { solicitudId: solicitud.id };
    if (reqSolNombre.trim()) body.nombre = reqSolNombre.trim();
    else if (reqSolSel) body.tipoDocumentoId = Number(reqSolSel);
    else { notify('Elegí un requisito de la lista o escribí uno nuevo.', 'error'); return; }
    await run(() => api.post('/documentos/requisitos-solicitud', body), 'Requisito agregado a la solicitud.');
    setReqSolOpen(false); setReqSolSel(''); setReqSolNombre('');
  };
  const quitarReqSol = async (tipoDocumentoId: number, nombre: string) => {
    if (!await confirm({ title: 'Quitar requisito de la solicitud', message: `¿Quitar "${nombre}"? Deja de pedirse para todo el grupo.`, confirmLabel: 'Quitar', danger: true })) return;
    run(() => api.del(`/documentos/requisitos-solicitud/${solicitud.id}/${tipoDocumentoId}`), 'Requisito quitado.');
  };
  const addComentario = () => { if (!nuevoComentario.trim()) return; run(() => api.post(`/solicitudes/${solicitud.id}/comentarios`, { contenido: nuevoComentario }), 'Comentario agregado.').then(() => setNuevoComentario('')); };
  /** Apaga el aviso de documentación nueva. No toca autorizaciones ni el estado de la solicitud. */
  const marcarVisto = async () => {
    await run(() => api.post(`/solicitudes/${solicitud.id}/visto`), 'Listo, se sacó el aviso.');
  };

  const agregarPersona = async () => {
    if (!(nuevaPersona.cuil || nuevaPersona.dni) || !nuevaPersona.nombre || !nuevaPersona.apellido) { notify('Completá el CUIL o el DNI, el nombre y el apellido.', 'error'); return; }
    await run(() => api.post(`/solicitudes/${solicitud.id}/personas`, { ...nuevaPersona, categoria: nuevaPersona.categoria || undefined }), 'Persona agregada.');
    setAgregar(false); setNuevaPersona({ cuil: '', dni: '', nombre: '', apellido: '', categoria: '' });
  };
  const guardarTrabajo = async () => {
    await run(() => api.patch(`/solicitudes/${solicitud.id}/trabajo`, { trabajo: trabajoTxt }), 'Trabajo guardado.');
    setEditTrabajo(false);
  };
  const restaurar = () => run(() => api.post(`/solicitudes/${solicitud.id}/restaurar`), 'Solicitud restaurada de la papelera.');
  const quitarPersona = async (solicitudId: number, personaId: number, nombre: string) => {
    if (!await confirm({ title: 'Quitar persona', message: `¿Quitar a ${nombre} de esta solicitud? No se borra la persona ni su documentación: solo deja de estar en esta solicitud.`, confirmLabel: 'Quitar', danger: true })) return;
    run(() => api.del(`/solicitudes/${solicitudId}/personas/${personaId}`), 'Persona quitada.');
  };
  const guardarEdit = async () => {
    if (!edit) return;
    await run(() => api.patch(`/personas/${edit.personaId}`, { cuil: edit.cuil, nombre: edit.nombre, apellido: edit.apellido }), 'Datos actualizados.');
    setEdit(null);
  };

  // Tarjeta de una persona (checklist + acciones). Se reutiliza en el modal de revisión.
  const PersonaCard = ({ p }: { p: any }) => (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span>
          <strong>{p.apellido}, {p.nombre}</strong>{' '}
          <span className="muted" style={{ fontWeight: 400 }}>CUIL {p.cuilFormat}</span>{' '}
          <Badge estado={p.estado} />
          {p.vigencia === 'AUTORIZADO' && <span className="badge green" style={{ marginLeft: 6 }}>🟢 Ingreso vigente</span>}
        </span>
        {isAdmin && (
          <span className="btn-row">
            <button className="btn ghost sm" onClick={() => setEdit({ personaId: p.personaId, cuil: p.cuil ?? '', nombre: p.nombre, apellido: p.apellido })} title="Corregir datos">✎ Editar</button>
            <button className="btn ghost sm" onClick={() => quitarPersona(p.solicitudId, p.personaId, `${p.apellido}, ${p.nombre}`)} title="Quitar de la solicitud">🗑 Quitar</button>
          </span>
        )}
      </div>
      <div className="card-body">
        {isAdmin && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap', fontSize: 12.5 }}>
            <span className="muted">🗓 Vigencia:</span>
            {p.fechaVencimiento
              ? <span className="chip" title="Esta persona tiene su propia fecha">propia</span>
              : <span className="muted">la general{fechaVenc ? ` (${fmtSoloFecha(fechaVenc)})` : ' (sin cargar)'}</span>}
            <input type="date" value={p.fechaVencimiento ?? ''} min={hoy()}
              onChange={(e) => vencimientoDePersona(p.personaId, e.target.value)}
              style={{ padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12.5 }} />
            {p.fechaVencimiento && (
              <button className="btn ghost sm" onClick={() => vencimientoDePersona(p.personaId, '')}
                title="Que vuelva a regir la vigencia general">usar la general</button>
            )}
          </div>
        )}
        <DocList docStatus={p.docStatus} personaId={p.personaId} onChanged={reload}
          onQuitarRequisito={isAdmin ? (tipoId, nombre) => quitarRequisito(p.personaId, tipoId, nombre) : undefined} />
        {isAdmin && (
          <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => abrirAgregarReq(p.personaId, `${p.apellido}, ${p.nombre}`)}>➕ Agregar requisito</button>
        )}
        {p.estado === 'RECHAZADA' && p.motivoRechazo && <div className="alert error" style={{ marginTop: 10 }}>Rechazada: {p.motivoRechazo}</div>}
        {isAdmin && (
          <>
            {p.autorizable && !fechaVenc && (
              <div className="alert warn" style={{ marginTop: 10 }}>✅ Documentación completa (persona + solicitud). Cargá la <strong>"Vigencia hasta"</strong> (arriba) para autorizarla.</div>
            )}
            {p.autorizable && fechaVenc && p.estado === 'AUTORIZADA' && (
              <div className="alert success" style={{ marginTop: 10 }}>🟢 Autorizada automáticamente. Puede ingresar hasta el <strong>{fmtSoloFecha(fechaVenc)}</strong>.</div>
            )}
            {!p.autorizable && (
              <div className="alert warn" style={{ marginTop: 10 }}>Falta: {(p.faltantesTotales ?? []).join(', ') || 'documentación por aprobar'}.</div>
            )}
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button className="btn warning sm" onClick={() => setAccion({ tipo: 'observar', personaId: p.personaId, solicitudId: p.solicitudId, nombre: `${p.apellido}, ${p.nombre}` })}>Observar</button>
              <button className="btn danger sm" onClick={() => setAccion({ tipo: 'rechazar', personaId: p.personaId, solicitudId: p.solicitudId, nombre: `${p.apellido}, ${p.nombre}` })}>Rechazar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <a className="muted" onClick={() => nav('/solicitudes')} style={{ cursor: 'pointer' }}>← Solicitudes</a>
          <h1 style={{ marginTop: 6 }}>{sinLocal ? <span className="badge orange">Local sin asignar</span> : local.nombre}
            {isAdmin && !sinLocal && <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => setCambiandoLocal((v) => !v)} title="Cambiar el local de esta solicitud">✎ Cambiar local</button>}
          </h1>
          <div className="subtitle">
            {solicitud.nroOrden && <><span className="chip" title="Número de orden de la revisión">Orden {solicitud.nroOrden}</span>{' · '}</>}
            {personas.length} {personas.length === 1 ? 'persona' : 'personas'}
            {' · '}Tipo:{' '}
            {isAdmin && personas.length > 0
              ? <select value={tipoSolicitud === 'EMPRESA' || tipoSolicitud === 'MONOTRIBUTISTA' ? tipoSolicitud : ''} disabled={busy}
                  onChange={(e) => definirTipo(e.target.value)} title="Cambiar tipo de contratista (define la documentación exigida)"
                  style={{ padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 6 }}>
                  <option value="" disabled>{tipoSolicitud === 'MIXTO' ? 'Mixto — elegir…' : 'definir…'}</option>
                  <option value="EMPRESA">Empresa</option>
                  <option value="MONOTRIBUTISTA">Monotributista</option>
                </select>
              : <strong>{tipoLabel(tipoSolicitud)}</strong>}
            {' · '}<Badge estado={solicitud.estado} />
            {fechaVenc && <> {' · '}Vigencia hasta <strong>{fmtSoloFecha(fechaVenc)}</strong></>}
          </div>
        </div>
        <div className="btn-row">
          {isAdmin && <button className="btn" onClick={() => setAgregar(true)}>+ Agregar persona</button>}
          {isAdmin && email && (
            <button className="btn" onClick={pedirNomina} disabled={busy}
              title="Mandarle un correo al remitente pidiéndole la nómina en Excel o en el cuerpo">✉ Pedir la nómina</button>
          )}
          {isAdmin && personas.length > 0 && <button className="btn primary" onClick={() => setRevisando(true)}>🔍 Revisar documentación</button>}
        </div>
      </div>

      {/* Llegó documentación después de informarle el resultado al local. Se puede apagar sin
          rehacer la revisión: si no, para sacar el cartel había que mandar la FAO a la papelera. */}
      {solicitud.docNuevaAt && !solicitud.deletedAt && (
        <div className="alert warn" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>📎 Llegó <strong>documentación nueva</strong> el {fmtFecha(solicitud.docNuevaAt)}, después de haberle informado el resultado al local. Revisala abajo.</span>
          {isAdmin && <button className="btn sm" disabled={busy} onClick={marcarVisto}>✓ Ya lo revisé</button>}
        </div>
      )}

      {solicitud.deletedAt && (
        <div className="alert warn" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>🗑️ Esta solicitud está en la <strong>papelera</strong>: no aparece en el listado. Las autorizaciones de las personas se mantienen.</span>
          {isAdmin && <button className="btn sm primary" disabled={busy} onClick={restaurar}>↩ Restaurar</button>}
        </div>
      )}

      {isAdmin && (sinLocal || cambiandoLocal) && (
        <div className={`alert ${sinLocal ? 'warn' : 'info'}`} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {sinLocal
            ? <span>⚠️ El local del asunto no coincide con ninguno cargado{localSugerido && <> — el email dice: <strong>“{localSugerido}”</strong></>}. Asignalo para poder autorizar:</span>
            : <span>Cambiar el local de esta solicitud (hoy: <strong>{local.nombre}</strong>). Elegí uno cargado o escribí uno nuevo:</span>}
          {sinLocal && localSugerido && <button className="btn sm primary" disabled={busy} onClick={() => crearYAsignarLocal(localSugerido)}>➕ Crear “{localSugerido}” y asignar</button>}
          <select className="btn sm" onChange={(e) => asignarLocal(Number(e.target.value))} defaultValue="" disabled={busy}>
            <option value="" disabled>elegir uno existente…</option>
            {(locales ?? []).filter((l) => l.nombre !== '(Sin asignar)' && l.id !== local.id).map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
          </select>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input value={nuevoLocal} onChange={(e) => setNuevoLocal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') crearLocalLibre(); }} placeholder="o escribir un local nuevo…" style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8 }} />
            <button className="btn sm" disabled={busy || !nuevoLocal.trim()} onClick={crearLocalLibre}>➕ Crear y asignar</button>
          </span>
          {!sinLocal && <button className="btn ghost sm" disabled={busy} onClick={() => { setCambiandoLocal(false); setNuevoLocal(''); }}>Cancelar</button>}
        </div>
      )}

      {/* Definir el tipo de contratista si el asunto/cuerpo no lo declaró (define la documentación exigida). */}
      {isAdmin && personas.length > 0 && (tipoSolicitud === null || tipoSolicitud === 'MIXTO') && (
        <div className="alert info" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>{tipoSolicitud === 'MIXTO' ? 'La solicitud tiene personas de distinto tipo.' : 'No se pudo determinar si es empresa o monotributista.'} Definí el tipo de contratista (fija qué documentación se exige):</span>
          <button className="btn sm" disabled={busy} onClick={() => definirTipo('EMPRESA')}>Empresa</button>
          <button className="btn sm" disabled={busy} onClick={() => definirTipo('MONOTRIBUTISTA')}>Monotributista</button>
        </div>
      )}

      {email?.aviso && personas.length === 0 && (
        <div className="alert warn">📄 {email.aviso}{isAdmin && ' Abajo podés ver el email y "+ Agregar persona".'}</div>
      )}

      {/* Email recibido: se puede ver SIN entrar a revisar. Abierto solo cuando no hay personas
          (para leer el cuerpo/adjuntos y cargar la gente a mano). */}
      {solicitud.emailMessageId && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head" style={{ cursor: 'pointer' }} onClick={() => setVerEmail(!emailAbierto)}>
            <span>📧 Email recibido {email?.asunto && <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>— {email.asunto}</span>}</span>
            <button className="btn ghost sm">{emailAbierto ? 'Ocultar' : 'Ver email'}</button>
          </div>
          {emailAbierto && (
            <div className="card-body"><EmailInline emailId={solicitud.emailMessageId} /></div>
          )}
        </div>
      )}

      {/* Trabajo / tarea a realizar (lo carga el admin; Seguridad lo ve en la ficha de la persona). */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span>🔧 Trabajo a realizar</span>
          {isAdmin && !editTrabajo && <button className="btn ghost sm" onClick={() => setEditTrabajo(true)}>✎ {solicitud.trabajo ? 'Editar' : 'Cargar'}</button>}
        </div>
        <div className="card-body">
          {editTrabajo ? (
            <>
              <textarea rows={2} value={trabajoTxt} onChange={(e) => setTrabajoTxt(e.target.value)} placeholder="Ej: Mantenimiento de aire acondicionado en el local; pintura del depósito…" style={{ width: '100%', padding: 10, border: '1px solid var(--border)', borderRadius: 9 }} />
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button className="btn primary sm" onClick={guardarTrabajo} disabled={busy}>Guardar</button>
                <button className="btn ghost sm" onClick={() => { setEditTrabajo(false); setTrabajoTxt(solicitud.trabajo ?? ''); }}>Cancelar</button>
              </div>
            </>
          ) : solicitud.trabajo
            ? <div style={{ whiteSpace: 'pre-wrap' }}>{solicitud.trabajo}</div>
            : <p className="muted">Sin especificar. {isAdmin && 'Cargá para qué trabajo se autoriza a estas personas.'}</p>}
        </div>
      </div>

      {/* Documentación de alcance SOLICITUD (una sola para todo el grupo). */}
      {personas.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
            <span>📎 Documentación de la solicitud <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>(vale para todas las personas del grupo)</span></span>
            {isAdmin && <button className="btn ghost sm" onClick={() => { setReqSolOpen(true); setReqSolSel(''); setReqSolNombre(''); }}>➕ Agregar requisito</button>}
          </div>
          <div className="card-body">
            <SolicitudDocList solicitudId={solicitud.id} docStatus={solicitudDocs} onChanged={reload} onQuitarExtra={isAdmin ? quitarReqSol : undefined} />
          </div>
        </div>
      )}

      {/* Resumen de personas (la revisión completa se hace en el modal). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, marginBottom: 16, alignItems: 'start' }}>
        {personas.map((p: any) => (
          <div className="card" key={p.spId}>
            <div className="card-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <div><strong>{p.apellido}, {p.nombre}</strong> <span className="muted" style={{ fontSize: 12.5 }}>CUIL {p.cuilFormat}</span></div>
                <div style={{ marginTop: 4 }}>
                  <Badge estado={p.estado} />{' '}
                  <span className="muted" style={{ fontSize: 12.5 }}>{p.docStatus.verificadosObligatorios}/{p.docStatus.totalObligatorios} docs aprobados</span>
                  {p.vigencia === 'AUTORIZADO' && <span className="badge green" style={{ marginLeft: 6 }}>🟢 vigente</span>}
                </div>
              </div>
              <button className="btn ghost sm" onClick={() => nav(`/personas/${p.personaId}`)}>Ver ficha</button>
            </div>
          </div>
        ))}
      </div>

      {personas.length === 0 && (
        <div className="card"><div className="card-body empty">
          Esta solicitud todavía no tiene personas.
          {isAdmin && <> <button className="btn sm primary" style={{ marginLeft: 8 }} onClick={() => setAgregar(true)}>+ Agregar persona</button></>}
          {isAdmin && email && (
            <> <button className="btn sm" style={{ marginLeft: 6 }} disabled={busy} onClick={pedirNomina}
              title="Mandarle un correo al remitente pidiéndole la nómina en Excel o en el cuerpo">
              ✉ Pedir la nómina
            </button></>
          )}
        </div></div>
      )}

      {/* Correos enviados al remitente desde el sistema */}
      <div className="card">
        <div className="card-head">📤 Correos enviados</div>
        <div className="card-body"><SentEmails solicitudId={solicitud.id} /></div>
      </div>

      {/* Comentarios */}
      <div className="card">
        <div className="card-head">💬 Comentarios</div>
        <div className="card-body">
          {isAdmin && (
            <div style={{ marginBottom: 14 }}>
              <textarea rows={2} placeholder="Escribir un comentario…" value={nuevoComentario} onChange={(e) => setNuevoComentario(e.target.value)} style={{ width: '100%', padding: 10, border: '1px solid var(--border)', borderRadius: 9 }} />
              <button className="btn sm primary" style={{ marginTop: 8 }} onClick={addComentario} disabled={busy}>Agregar comentario</button>
            </div>
          )}
          {comentarios.length === 0 && <p className="muted">Sin comentarios.</p>}
          {comentarios.map((c: any) => (
            <div key={c.id} style={{ padding: '10px 0', borderTop: '1px dashed var(--border)' }}>
              <div className="muted" style={{ fontSize: 12 }}>{fmtFecha(c.createdAt)} · {c.userNombre ?? 'Sistema'}</div>
              <div>{c.contenido}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ===== Modal de revisión: 2 columnas (izq. aprobar docs / der. PDFs) ===== */}
      {revisando && (
        <Modal full title={`Revisión — ${sinLocal ? 'Local sin asignar' : local.nombre}`} onClose={() => setRevisando(false)}
          footer={<>
            <button className="btn" onClick={() => setRevisando(false)}>Cerrar</button>
            {faltaTipo && <span className="muted" style={{ fontSize: 12.5, alignSelf: 'center' }}>⚠ Definí si es empresa o monotributista para poder terminar.</span>}
            {!faltaTipo && revisionIncompleta && <span className="muted" style={{ fontSize: 12.5, alignSelf: 'center' }}>⚠ Aprobá o marcá como falta cada documento antes de enviar.</span>}
            {!faltaTipo && !revisionIncompleta && requiereFecha && <span className="muted" style={{ fontSize: 12.5, alignSelf: 'center' }}>⚠ Cargá y guardá la "Vigencia hasta" (arriba): si no, quedan aprobadas pero sin autorización.</span>}
            <button className="btn primary" onClick={() => setConfirmarTerminar(true)} disabled={busy || faltaTipo || revisionIncompleta || requiereFecha} title={faltaTipo ? 'Falta definir el tipo de contratista.' : revisionIncompleta ? 'Quedan documentos sin decidir (aprobar o marcar como falta).' : requiereFecha ? 'Hay gente con la documentación completa y la solicitud no tiene vigencia cargada.' : undefined}>✅ Terminar revisión y avisar al remitente</button>
          </>}>
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Barra de vigencia (fecha única de la solicitud) */}
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: 'var(--panel-2)' }}>
              <label style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                🗓 Vigencia hasta:
                <input type="date" value={venc} min={hoy()} onChange={(e) => setVenc(e.target.value)} style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8 }} />
              </label>
              <button className="btn primary sm" onClick={guardarVencimiento} disabled={busy}>Guardar</button>
              {papelVenceAntes
                ? <span style={{ fontSize: 12.5, color: 'var(--danger)' }}>
                    ⚠ <strong>{sugerida!.archivos.join(', ')}</strong> vence el <strong>{fmtSoloFecha(sugerida!.fecha)}</strong>
                    {sugerida!.vencida ? ' (ya está vencido)' : ''}, antes de esta vigencia: quedarían autorizados con la documentación vencida.
                  </span>
                : <span className="muted" style={{ fontSize: 12.5 }}>
                    Las personas con toda la documentación aprobada quedan <strong>autorizadas hasta esta fecha</strong>.
                    {sugerida && <> La documentación alcanza hasta el <strong>{fmtSoloFecha(sugerida.fecha)}</strong>.</>}
                  </span>}
            </div>
            {/* 2 columnas */}
            <div className="revision-cols" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
              <div style={{ flex: '1 1 30%', minWidth: 300, overflow: 'auto', padding: 16, borderRight: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                  <span className="muted">Aprobá cada requisito contra los PDF de la derecha. Al completar todos, la persona queda autorizada sola.</span>
                  {/* Acá también: revisando la documentación es cuando se ve que falta alguien. */}
                  <button className="btn sm" onClick={() => setAgregar(true)}>+ Agregar persona</button>
                </div>
                <div className="card" style={{ marginBottom: 14 }}>
                  <div className="card-head" style={{ fontSize: 13, flexWrap: 'wrap', gap: 6 }}>
                    <span>📎 Documentación de la solicitud <span className="muted" style={{ fontWeight: 400 }}>(una para todo el grupo)</span></span>
                    {isAdmin && <button className="btn ghost sm" onClick={() => { setReqSolOpen(true); setReqSolSel(''); setReqSolNombre(''); }}>➕ Requisito</button>}
                  </div>
                  <div className="card-body"><SolicitudDocList solicitudId={solicitud.id} docStatus={solicitudDocs} onChanged={reload} onQuitarExtra={isAdmin ? quitarReqSol : undefined} /></div>
                </div>

                {/* Un papel, muchas personas: la Nómina ART lista a todo el grupo pero el requisito
                    es por persona. Sin esto, un pedido de 28 son 28 clics sobre el mismo PDF. */}
                {personas.length > 1 && requisitosDeGrupo.length > 0 && (
                  <div className="card" style={{ marginBottom: 14 }}>
                    <div className="card-head" style={{ fontSize: 13 }}>⚡ Aprobar para varias personas</div>
                    <div className="card-body">
                      {requisitosDeGrupo.map((r) => (
                        <div key={r.tipoId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 0', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12.5 }}>
                            {r.nombre}{' '}
                            <span className="muted">({r.aprobados} de {r.total} aprobados)</span>
                          </span>
                          <button className="btn sm" disabled={busy || r.aprobados === r.total}
                            onClick={() => abrirEnBloque(r.tipoId, r.nombre)}>
                            {r.aprobados === r.total ? '✓ listo' : 'Aprobar en bloque'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {personas.length > 3 && (
                  <div className="field" style={{ marginBottom: 12 }}>
                    <input value={buscarRev} onChange={(e) => setBuscarRev(e.target.value)} placeholder="🔎 Buscar persona por nombre o CUIL…" style={{ width: '100%' }} />
                  </div>
                )}
                {(() => {
                  const q = buscarRev.trim().toLowerCase();
                  const qd = q.replace(/\D/g, '');
                  const lista = q
                    ? personas.filter((p: any) => `${p.apellido} ${p.nombre}`.toLowerCase().includes(q) || (qd && (p.cuil ?? '').includes(qd)))
                    : personas;
                  if (lista.length === 0) return <p className="muted">No hay personas que coincidan con "{buscarRev}".</p>;
                  return lista.map((p: any) => <PersonaCard key={p.spId} p={p} />);
                })()}
              </div>
              <div style={{ flex: '1 1 70%', minWidth: 0, overflow: 'auto', padding: 16 }}>
                {solicitud.emailMessageId
                  ? <SolicitudDocumentacion solicitudId={solicitud.id} personasCargadas={personas.length} onImportado={reload} />
                  : <><div style={{ fontWeight: 650, marginBottom: 10 }}>📄 Documentación (PDF)</div><p className="muted">Esta solicitud es manual (sin email). Cargá los documentos desde la ficha de cada persona.</p></>}
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Modales de acción por persona */}
      {accion?.tipo === 'observar' && (
        <Modal title={`Observar — ${accion.nombre}`} onClose={cerrarAccion}
          footer={<><button className="btn" onClick={cerrarAccion}>Cancelar</button><button className="btn warning" onClick={confirmarAccion} disabled={busy}>Confirmar</button></>}>
          <div className="field"><label>Observación</label><textarea rows={3} value={comentario} onChange={(e) => setComentario(e.target.value)} placeholder="Ej: Falta presentar el Formulario 931 actualizado." /></div>
        </Modal>
      )}
      {accion?.tipo === 'rechazar' && (
        <Modal title={`Rechazar — ${accion.nombre}`} onClose={cerrarAccion}
          footer={<><button className="btn" onClick={cerrarAccion}>Cancelar</button><button className="btn danger" onClick={confirmarAccion} disabled={busy || !comentario.trim()}>Confirmar rechazo</button></>}>
          <div className="alert warn">El motivo es obligatorio y quedará registrado en la auditoría.</div>
          <div className="field"><label>Motivo del rechazo *</label><textarea rows={3} value={comentario} onChange={(e) => setComentario(e.target.value)} /></div>
        </Modal>
      )}

      {/* Confirmación de "Terminar revisión" (reemplaza el alert del navegador) */}
      {confirmarTerminar && (
        <Modal title="Terminar revisión" onClose={() => setConfirmarTerminar(false)}
          footer={<>
            <button className="btn" onClick={() => setConfirmarTerminar(false)}>Cancelar</button>
            {requiereFecha
              ? <button className="btn primary" onClick={() => { setConfirmarTerminar(false); setRevisando(true); }}>Cargar fecha de vencimiento</button>
              : <button className="btn primary" onClick={terminarRevision} disabled={busy}>Terminar y enviar email</button>}
          </>}>
          {requiereFecha && (
            <div className="alert warn">⚠️ <strong>Falta cargar la fecha de vencimiento</strong> (hasta cuándo pueden ingresar). Hay al menos una persona con la documentación completa que va a quedar autorizada, y sin esa fecha no se autoriza. Cargala en la ventana de revisión y volvé a terminar.</div>
          )}
          {!requiereFecha && !fechaVenc && !hayAutorizable && (
            <div className="alert info">Ninguna persona va a quedar autorizada (todas rechazadas o con documentación incompleta), así que no hace falta cargar fecha de vencimiento. Se va a enviar el email con el resultado (rechazos / pendientes) al remitente.</div>
          )}
          {!requiereFecha && (
            <p>Se va a enviar un email al <strong>remitente del correo original</strong>{email?.remitente ? <> (<span className="muted">{email.remitente}</span>)</> : ''} con el resultado por persona: quién quedó autorizado (y hasta cuándo) y qué documentación falta.</p>
          )}
        </Modal>
      )}

      {/* Resultado del envío */}
      {resultado && (
        <Modal title="Revisión terminada" onClose={() => setResultado(null)}
          footer={<button className="btn primary" onClick={() => setResultado(null)}>Cerrar</button>}>
          {resultado.nroOrden && (
            <div className="alert info" style={{ fontSize: 15 }}>
              Número de orden: <strong>{resultado.nroOrden}</strong>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>Identifica esta revisión. Va en el asunto y en el cuerpo del email, y no cambia si reenviás.</div>
            </div>
          )}
          {resultado.emailEnviado
            ? <div className="alert success">✅ Email de resultado enviado a <strong>{resultado.to}</strong>.</div>
            : <div className="alert warn">No se envió el email: {resultado.motivo}<br /><span className="muted" style={{ fontSize: 12.5 }}>La revisión quedó guardada igual. Podés reenviar cuando el email esté configurado.</span></div>}
        </Modal>
      )}

      {enBloque && (
        <Modal title={`Aprobar ${enBloque.nombre} para varias personas`} onClose={() => setEnBloque(null)}
          footer={<>
            <button className="btn" onClick={() => setEnBloque(null)}>Cancelar</button>
            <button className="btn primary" onClick={aprobarEnBloque} disabled={busy || elegidas.size === 0}>
              ✓ Aprobar para {elegidas.size} persona(s)
            </button>
          </>}>
          <div className="muted" style={{ marginBottom: 10, fontSize: 13 }}>
            {analisis?.activo
              ? <>Vienen tildadas las personas que <strong>la documentación nombra</strong>. Las que no figuran en ningún papel quedan destildadas: si igual les corresponde, tildalas.</>
              : <>Revisá la lista antes de aprobar. Aprobar un requisito es decir que viste el papel de esa persona.</>}
          </div>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ width: 30 }}>
                  <input type="checkbox"
                    checked={elegidas.size === personasDelBloque.length && personasDelBloque.length > 0}
                    onChange={(e) => setElegidas(new Set(e.target.checked ? personasDelBloque.map((p: any) => p.personaId) : []))} />
                </th>
                <th>Persona</th>
                <th>Según los papeles</th>
              </tr>
            </thead>
            <tbody>
              {personasDelBloque.map((p: any) => {
                const en = papelRespalda(p.personaId);
                const yaEsta = (p.docStatus?.items ?? []).find((x: any) => x.tipoId === enBloque.tipoId)?.verificacion === 'VERIFICADO';
                return (
                  <tr key={p.personaId} style={{ opacity: yaEsta ? 0.5 : 1 }}>
                    <td>
                      <input type="checkbox" checked={elegidas.has(p.personaId)} disabled={yaEsta}
                        onChange={(e) => setElegidas((prev) => {
                          const n = new Set(prev);
                          e.target.checked ? n.add(p.personaId) : n.delete(p.personaId);
                          return n;
                        })} />
                    </td>
                    <td style={{ fontSize: 12.5 }}>
                      {p.apellido}, {p.nombre}
                      {yaEsta && <span className="chip" style={{ marginLeft: 6 }}>ya aprobado</span>}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {en.length > 0
                        ? en.join(', ')
                        : analisis?.activo ? <span style={{ color: 'var(--danger)' }}>no figura en ningún papel</span> : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Modal>
      )}
      {agregar && (
        <Modal title="Agregar persona a la solicitud" onClose={() => setAgregar(false)}
          footer={<><button className="btn" onClick={() => setAgregar(false)}>Cancelar</button><button className="btn primary" onClick={agregarPersona} disabled={busy}>Agregar</button></>}>
          <div className="alert info">Con el CUIL <strong>o</strong> el DNI alcanza. Si la persona ya existe, se usa esa (no se duplica).</div>
          {parecidas.length > 0 && (
            <div className="alert warn" style={{ fontSize: 13 }}>
              <strong>Fijate que no sea alguien que ya está cargado:</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {parecidas.map((p) => (
                  <li key={p.id}>
                    {p.apellido}, {p.nombre} — DNI {p.dni ?? '—'} · CUIL {p.cuil ?? '—'}{' '}
                    <span className="muted">
                      ({p.motivo === 'DOCUMENTO_PARECIDO' ? 'el documento difiere en un dígito' : 'se llama igual'})
                    </span>
                  </li>
                ))}
              </ul>
              <div className="muted" style={{ marginTop: 6 }}>
                Si es la misma persona, cancelá y cargala con el documento que ya tiene. Si es otra, seguí.
              </div>
            </div>
          )}
          <div className="form-row">
            <div className="field"><label>Apellido *</label><input value={nuevaPersona.apellido} onChange={(e) => setNuevaPersona({ ...nuevaPersona, apellido: e.target.value })} /></div>
            <div className="field"><label>Nombre *</label><input value={nuevaPersona.nombre} onChange={(e) => setNuevaPersona({ ...nuevaPersona, nombre: e.target.value })} /></div>
          </div>
          <div className="form-row">
            <div className="field"><label>CUIL</label><input value={nuevaPersona.cuil} onChange={(e) => setNuevaPersona({ ...nuevaPersona, cuil: e.target.value })} placeholder="20-30410849-0" /></div>
            <div className="field"><label>DNI</label><input value={nuevaPersona.dni} onChange={(e) => setNuevaPersona({ ...nuevaPersona, dni: e.target.value })} placeholder="30410849" /></div>
          </div>
          <div className="form-row">
            <div className="field"><label>Tipo de contratista</label>
              <select value={nuevaPersona.categoria} onChange={(e) => setNuevaPersona({ ...nuevaPersona, categoria: e.target.value })}>
                <option value="">Sin cambios</option>
                <option value="EMPRESA">Empresa</option>
                <option value="MONOTRIBUTISTA">Monotributista</option>
              </select>
              <div className="hint">Define qué documentación se le exige.</div>
            </div>
          </div>
        </Modal>
      )}

      {reqPersona && (
        <Modal title={`Agregar requisito — ${reqPersona.nombre}`} onClose={() => setReqPersona(null)}
          footer={<><button className="btn" onClick={() => setReqPersona(null)}>Cancelar</button><button className="btn primary" onClick={agregarRequisito} disabled={busy}>Agregar</button></>}>
          <div className="alert info">Documentación extra que se le exige solo a esta persona (ej. trabajo en altura). Queda como obligatoria hasta aprobarla.</div>
          <div className="field">
            <label>Elegir de la lista</label>
            <select value={reqSel} onChange={(e) => { setReqSel(e.target.value); if (e.target.value) setReqNombre(''); }}>
              <option value="">— elegir —</option>
              {catalogoExtra.map((t: any) => <option key={t.id} value={t.id}>{t.nombre}</option>)}
            </select>
          </div>
          <div className="field">
            <label>o escribir uno nuevo</label>
            <input value={reqNombre} onChange={(e) => { setReqNombre(e.target.value); if (e.target.value) setReqSel(''); }} placeholder="Ej: Permiso de trabajo en caliente" />
          </div>
        </Modal>
      )}

      {reqSolOpen && (
        <Modal title="Agregar requisito a la solicitud" onClose={() => setReqSolOpen(false)}
          footer={<><button className="btn" onClick={() => setReqSolOpen(false)}>Cancelar</button><button className="btn primary" onClick={agregarReqSol} disabled={busy}>Agregar</button></>}>
          <div className="alert info">Documentación extra que se pide <strong>una sola vez para toda la solicitud</strong> (igual que el Formulario 931). Vale para todas las personas del grupo y queda obligatoria hasta aprobarla.</div>
          <div className="field">
            <label>Elegir de la lista</label>
            <select value={reqSolSel} onChange={(e) => { setReqSolSel(e.target.value); if (e.target.value) setReqSolNombre(''); }}>
              <option value="">— elegir —</option>
              {catalogoExtra.map((t: any) => <option key={t.id} value={t.id}>{t.nombre}</option>)}
            </select>
          </div>
          <div className="field">
            <label>o escribir uno nuevo</label>
            <input value={reqSolNombre} onChange={(e) => { setReqSolNombre(e.target.value); if (e.target.value) setReqSolSel(''); }} placeholder="Ej: Plan de trabajo, Seguro de caución…" />
          </div>
        </Modal>
      )}

      {edit && (
        <Modal title="Editar datos de la persona" onClose={() => setEdit(null)}
          footer={<><button className="btn" onClick={() => setEdit(null)}>Cancelar</button><button className="btn primary" onClick={guardarEdit} disabled={busy}>Guardar</button></>}>
          <div className="alert info">El CUIL identifica a la persona: si lo cambiás, se corrige en todo el sistema.</div>
          <div className="form-row">
            <div className="field"><label>Apellido</label><input value={edit.apellido} onChange={(e) => setEdit({ ...edit, apellido: e.target.value })} /></div>
            <div className="field"><label>Nombre</label><input value={edit.nombre} onChange={(e) => setEdit({ ...edit, nombre: e.target.value })} /></div>
          </div>
          <div className="field"><label>CUIL</label><input value={edit.cuil} onChange={(e) => setEdit({ ...edit, cuil: e.target.value })} placeholder="20-30410849-0" /></div>
        </Modal>
      )}
    </>
  );
}
