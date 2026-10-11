import { useState } from 'react';
import { useFetch } from '../hooks';
import { api, fmtSoloFecha } from '../api';
import { Spinner, useToast } from '../ui';
import { useAuth } from '../auth';

interface Adj { emailId: number; index: number; filename: string; contentType?: string; size: number; deReenvio: boolean; }

interface AdjAnalizado {
  emailId: number; index: number; filename: string;
  tipoNombre: string | null; confianza: number;
  emision: string | null; vencimiento: string | null;
  empresa: { nombre: string | null; cuit: string | null } | null;
  personas: { dni: string; nombre: string | null; apellido: string | null }[];
  leido: boolean; nota: string | null;
}
interface Cubierta { personaId: number; nombre: string; dni: string | null; en: string[]; }
interface Analisis {
  activo: boolean; adjuntos: AdjAnalizado[];
  cubiertas: Cubierta[]; sinCubrir: Cubierta[];
  ajenas: { dni: string; nombre: string | null; apellido: string | null; en: string }[];
  sinLeer: number;
  vigenciaSugerida: { fecha: string; archivos: string[]; vencida: boolean } | null;
}

interface Detectada { dni: string; nombre: string | null; apellido: string | null; archivo: string; yaEsta: boolean }
interface FilaDetectada extends Detectada { elegida: boolean; nombre: string; apellido: string }

function esPdf(ct: string | undefined, n: string) { return /pdf/.test(ct ?? '') || /\.pdf$/i.test(n); }

/**
 * Muestra los PDF de la documentación de una solicitud, juntando los adjuntos del correo
 * original y los de las respuestas que sumaron documentación (deduplicados por nombre).
 * Incluye lo que venga dentro de ZIP (ya viene expandido del backend).
 */
export function SolicitudDocumentacion({ solicitudId, alto = 720, personasCargadas = 0, onImportado }:
  { solicitudId: number; alto?: number; personasCargadas?: number; onImportado?: () => void }) {
  const { data, loading } = useFetch<{ adjuntos: Adj[] }>(`/emails/solicitud/${solicitudId}/documentacion`, [solicitudId]);
  // Lo que dice cada papel. Es informativo: no cambia ninguna decisión ni ningún estado.
  const { data: analisis } = useFetch<Analisis>(`/emails/solicitud/${solicitudId}/analisis`, [solicitudId]);
  const porArchivo = new Map((analisis?.adjuntos ?? []).map((a) => [`${a.emailId}-${a.index}`, a]));
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set());
  const { notify } = useToast();

  // Importar personas leídas de los PDF. Vive ACÁ y no en la pantalla de la solicitud porque hay
  // que poder mirar la nómina mientras se elige: la lista y el PDF quedan uno debajo del otro.
  const [importando, setImportando] = useState(false);
  const [detectadas, setDetectadas] = useState<FilaDetectada[] | null>(null);
  const [buscandoPersonas, setBuscandoPersonas] = useState(false);
  const [guardando, setGuardando] = useState(false);

  // Minichat de capturas: se pega la imagen (Ctrl+V) o se elige el archivo, la lee la IA y las
  // personas caen en la MISMA tabla de revisión que el importador de PDF. No se da de alta a nadie
  // sin confirmar: la IA propone, la persona decide.
  const { capturaIA } = useAuth();
  const [notaIA, setNotaIA] = useState<string | null>(null);
  const [leyendoCaptura, setLeyendoCaptura] = useState(false);
  const [instruccion, setInstruccion] = useState('');

  const leerCaptura = async (file: File) => {
    setLeyendoCaptura(true);
    setImportando(true);
    setNotaIA(null);
    try {
      const fd = new FormData();
      fd.append('archivo', file);
      if (instruccion.trim()) fd.append('instruccion', instruccion.trim());
      const r = await api.upload<{ detectadas: Detectada[]; nota: string }>(
        `/solicitudes/${solicitudId}/personas/desde-imagen`, fd);
      setNotaIA(r.nota);
      // Acá SÍ vienen tildadas las nuevas: la captura es la lista que el local mandó a propósito,
      // no el personal entero de una empresa como en una nómina de ART.
      setDetectadas(r.detectadas.map((d) => ({
        ...d,
        elegida: !d.yaEsta && !!(d.nombre || d.apellido),
        nombre: d.nombre ?? '',
        apellido: d.apellido ?? '',
      })));
    } catch (e: any) {
      notify(e.message ?? 'No se pudo leer la captura.', 'error');
    } finally {
      setLeyendoCaptura(false);
    }
  };

  const abrirImportar = async () => {
    setImportando(true);
    setBuscandoPersonas(true);
    setDetectadas(null);
    setNotaIA(null);
    try {
      const r = await api.get<{ detectadas: Detectada[] }>(`/emails/solicitud/${solicitudId}/personas-detectadas`);
      // Medido sobre 210 solicitudes: los PDF nombran mucha más gente que la del pedido, y no es
      // basura —una nómina de ART trae TODO el personal de la empresa—. El papel no dice cuáles son
      // los de este FAO, así que tildar de entrada solo tiene sentido con la solicitud vacía y una
      // lista corta. Con gente ya cargada, el importador sirve para buscar a los que faltan.
      const nuevas = r.detectadas.filter((d) => !d.yaEsta).length;
      const proponer = personasCargadas === 0 && nuevas <= 20;
      setDetectadas(r.detectadas.map((d) => ({
        ...d,
        elegida: proponer && !d.yaEsta && !!(d.nombre || d.apellido),
        nombre: d.nombre ?? '',
        apellido: d.apellido ?? '',
      })));
    } catch (e: any) {
      notify(e.message ?? 'No se pudo leer la documentación.', 'error');
      setImportando(false);
    } finally {
      setBuscandoPersonas(false);
    }
  };

  const importarElegidas = async () => {
    const elegidas = (detectadas ?? []).filter((d) => d.elegida);
    const sinNombre = elegidas.filter((d) => !d.nombre.trim() && !d.apellido.trim());
    if (sinNombre.length > 0) { notify(`Completá el nombre de ${sinNombre.length} persona(s) o destildalas.`, 'error'); return; }
    setGuardando(true);
    try {
      const r = await api.post<{ agregadas: number; salteadas: number }>(`/solicitudes/${solicitudId}/personas/importar`, {
        personas: elegidas.map((d) => ({ dni: d.dni, nombre: d.nombre.trim(), apellido: d.apellido.trim() })),
      });
      notify(`Se agregaron ${r.agregadas} persona(s)${r.salteadas ? ` (${r.salteadas} ya estaban)` : ''}.`, 'success');
      setImportando(false);
      onImportado?.();
    } catch (e: any) {
      notify(e.message ?? 'No se pudieron agregar.', 'error');
    } finally {
      setGuardando(false);
    }
  };

  if (loading) return <Spinner />;
  const pdfs = (data?.adjuntos ?? []).filter((a) => esPdf(a.contentType, a.filename));
  const key = (a: Adj) => `${a.emailId}-${a.index}`;
  const toggle = (k: string) => setAbiertos((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const tarjeta = (a: Adj) => {
          const url = `/api/emails/${a.emailId}/adjuntos/${a.index}`;
      const k = key(a);
      const abierto = abiertos.has(k);
      return (
        <div key={k} className="card" style={{ padding: 8, gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: abierto ? 6 : 0, gap: 8 }}>
            <strong style={{ fontSize: 12.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {a.filename}
              {a.deReenvio && <span className="chip" style={{ marginLeft: 6 }} title="Llegó en una respuesta posterior">reenvío</span>}
              {(() => {
                const an = porArchivo.get(k);
                if (!an) return null;
                const partes = [
                  an.tipoNombre,
                  an.emision ? `emitida ${fmtSoloFecha(an.emision)}` : null,
                  // El vencimiento es el dato que decide hasta cuándo sirve el papel: va siempre.
                  an.vencimiento ? `vence ${fmtSoloFecha(an.vencimiento)}` : null,
                  an.empresa?.nombre ?? (an.empresa?.cuit ? `CUIT ${an.empresa.cuit}` : null),
                  an.personas.length ? `${an.personas.length} persona(s)` : null,
                ].filter(Boolean);
                return (
                  <div className="muted" style={{ fontWeight: 400, fontSize: 12, marginTop: 2, whiteSpace: "normal" }}>
                    {an.leido ? (partes.join(" · ") || "no se reconoció el tipo") : (an.nota ?? "no se pudo leer")}
                  </div>
                );
              })()}
            </strong>
            <span className="btn-row">
              <button className="btn ghost sm" onClick={() => toggle(k)}>{abierto ? 'Ocultar' : 'Ver'}</button>
              <a className="btn ghost sm" href={url} target="_blank" rel="noreferrer">Abrir</a>
            </span>
          </div>
          {abierto && <iframe src={url} title={a.filename} style={{ width: '100%', height: alto, border: '1px solid var(--border)', borderRadius: 6 }} />}
        </div>
      );
  };

  // Agrupado por tipo de documento: todas las ART juntas, todos los seguros de vida juntos.
  // Lo que no se reconoció va al final, que es lo que hay que mirar a mano.
  const SIN_TIPO = 'Sin reconocer';
  const agrupado = !!analisis?.activo && pdfs.length > 1;
  const grupos: { titulo: string; archivos: Adj[] }[] = [];
  for (const a of pdfs) {
    const titulo = (agrupado && porArchivo.get(key(a))?.tipoNombre) || (agrupado ? SIN_TIPO : '');
    const g = grupos.find((x) => x.titulo === titulo);
    if (g) g.archivos.push(a); else grupos.push({ titulo, archivos: [a] });
  }
  grupos.sort((a, b) => Number(a.titulo === SIN_TIPO) - Number(b.titulo === SIN_TIPO));

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 8px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 650 }}>📄 Documentación ({pdfs.length})</span>
        {pdfs.length > 0 && (abiertos.size === pdfs.length
          ? <button className="btn ghost sm" onClick={() => setAbiertos(new Set())}>Cerrar todos</button>
          : <button className="btn ghost sm" onClick={() => setAbiertos(new Set(pdfs.map(key)))}>Ver todos</button>)}
        {pdfs.length > 0 && onImportado && !importando && (
          <button className="btn sm" onClick={abrirImportar} title="Lee las personas que nombran estos PDF">
            👥 Importar personas
          </button>
        )}
        {onImportado && capturaIA && !importando && (
          <button className="btn sm" onClick={() => { setImportando(true); setDetectadas(null); setNotaIA(null); }}
            title="Pegá una captura de la lista y la lee la IA">
            📷 Pegar una captura
          </button>
        )}
      </div>

      {importando && (
        <div className="card" style={{ marginBottom: 12, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>👥 Cargar personas</strong>
            <button className="btn ghost sm" onClick={() => setImportando(false)}>Cerrar</button>
          </div>
          {capturaIA && (
            <div
              // El pegado se escucha en el contenedor: así "captura + Ctrl+V" funciona sin tener que
              // apuntarle a un campo. tabIndex lo hace enfocable, que es lo que habilita el evento.
              tabIndex={0}
              onPaste={(e) => {
                const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'));
                const file = item?.getAsFile();
                if (file) { e.preventDefault(); leerCaptura(file); }
              }}
              style={{
                border: '1px dashed var(--border)', borderRadius: 8, padding: 10, marginBottom: 10,
                background: 'var(--panel-2)',
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 12.5 }}>📷 Captura</strong>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  Hacé clic acá y pegá con <strong>Ctrl+V</strong>, o
                </span>
                <label className="btn ghost sm" style={{ margin: 0 }}>
                  elegir imagen
                  <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) leerCaptura(f); e.target.value = ''; }} />
                </label>
              </div>
              <input
                value={instruccion}
                onChange={(e) => setInstruccion(e.target.value)}
                placeholder="Opcional: aclarale algo (ej.: 'solo los de la columna de la derecha')"
                style={{ width: '100%', marginTop: 8, fontSize: 12.5 }}
              />
              {leyendoCaptura && <div style={{ marginTop: 8 }}><Spinner /></div>}
              {notaIA && (
                <div className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
                  🤖 {notaIA}
                </div>
              )}
            </div>
          )}
          {buscandoPersonas && <Spinner />}
          {!buscandoPersonas && !leyendoCaptura && detectadas && detectadas.length === 0 && (
            <p className="muted" style={{ margin: 0 }}>
              No se encontró ninguna persona. Si la nómina vino como foto o escaneo, pegá una captura acá arriba.
            </p>
          )}
          {!buscandoPersonas && detectadas && detectadas.length > 0 && (
            <>
              <div className="muted" style={{ marginBottom: 8, fontSize: 12.5 }}>
                <strong>Revisá antes de agregar.</strong> Si salió de los PDF, ojo: una nómina de ART nombra a
                <strong> todo el personal de la empresa</strong>, no solo a los de este pedido — abrí el PDF acá abajo
                con "Ver" para comparar. Si salió de una captura, chequeá los documentos dígito por dígito.
                Las que ya están vienen marcadas.
              </div>
              <div style={{ maxHeight: 320, overflow: 'auto' }}>
                <table className="table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={{ width: 30 }}>
                        <input type="checkbox"
                          checked={detectadas.every((d) => d.elegida || d.yaEsta)}
                          onChange={(e) => setDetectadas(detectadas.map((d) => (d.yaEsta ? d : { ...d, elegida: e.target.checked && !!(d.nombre.trim() || d.apellido.trim()) })))} />
                      </th>
                      <th>DNI</th><th>Apellido</th><th>Nombre</th><th>Salió de</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detectadas.map((d, i) => (
                      <tr key={d.dni} style={{ opacity: d.yaEsta ? 0.55 : 1 }}>
                        <td>
                          <input type="checkbox" checked={d.elegida} disabled={d.yaEsta}
                            onChange={(e) => setDetectadas(detectadas.map((x, j) => (j === i ? { ...x, elegida: e.target.checked } : x)))} />
                        </td>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>
                          {d.dni}{d.yaEsta && <span className="chip" style={{ marginLeft: 6 }}>ya está</span>}
                        </td>
                        <td>
                          <input value={d.apellido} disabled={d.yaEsta} placeholder={d.yaEsta ? '' : 'completar'}
                            onChange={(e) => setDetectadas(detectadas.map((x, j) => (j === i ? { ...x, apellido: e.target.value } : x)))}
                            style={{ width: '100%', fontSize: 12.5 }} />
                        </td>
                        <td>
                          <input value={d.nombre} disabled={d.yaEsta} placeholder={d.yaEsta ? '' : 'completar'}
                            onChange={(e) => setDetectadas(detectadas.map((x, j) => (j === i ? { ...x, nombre: e.target.value } : x)))}
                            style={{ width: '100%', fontSize: 12.5 }} />
                        </td>
                        <td className="muted" style={{ fontSize: 11.5, maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.archivo}>
                          {d.archivo}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn primary sm" onClick={importarElegidas}
                  disabled={guardando || !detectadas.some((d) => d.elegida)}>
                  Agregar {detectadas.filter((d) => d.elegida).length} persona(s)
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {/* El cruce: quién de la solicitud aparece nombrado en los papeles y quién no. Es lo que
          hoy se chequea a ojo yendo y volviendo entre la nómina y la lista de personas. */}
      {analisis?.activo && (analisis.cubiertas.length > 0 || analisis.sinCubrir.length > 0) && (
        <div className={`alert ${analisis.sinCubrir.length > 0 ? 'warn' : 'info'}`} style={{ marginBottom: 10, fontSize: 13.5 }}>
          {analisis.sinCubrir.length === 0
            ? <div><strong>Las {analisis.cubiertas.length} personas de la solicitud aparecen en la documentación.</strong></div>
            : <div><strong>{analisis.sinCubrir.length} de {analisis.cubiertas.length + analisis.sinCubrir.length} personas no aparecen en ningún papel:</strong> {analisis.sinCubrir.map((p) => p.nombre).join(" · ")}</div>}
          {analisis.cubiertas.length > 0 && (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {analisis.cubiertas.map((p) => <li key={p.personaId}>{p.nombre} — en {p.en.join(", ")}</li>)}
            </ul>
          )}
          {analisis.sinLeer > 0 && (
            <div className="muted" style={{ marginTop: 6 }}>
              {analisis.sinLeer} archivo(s) no se pudieron leer (escaneados o fotos): esos hay que abrirlos.
            </div>
          )}
          <div className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>
            Esto es solo lectura de los papeles, no una aprobación. Lo que decide seguís siendo vos.
          </div>
        </div>
      )}
      {pdfs.length === 0 && <p className="muted">No hay documentación en PDF (revisá los adjuntos del email).</p>}
      {grupos.map((g) => (
        <div key={g.titulo} style={{ marginBottom: 14 }}>
          {agrupado && (
            <div style={{ fontWeight: 650, fontSize: 12.5, margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>{g.titulo}</span>
              <span className="muted" style={{ fontWeight: 400 }}>({g.archivos.length})</span>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {g.archivos.map((a) => tarjeta(a))}
          </div>
        </div>
      ))}
    </>
  );
}
