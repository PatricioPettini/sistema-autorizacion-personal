import { useEffect, useState } from 'react';
import { Spinner } from '../ui';
import { api, fmtFecha } from '../api';

interface Adjunto { index: number; filename: string; contentType: string; size: number; }
interface EmailData { remitente: string | null; asunto: string | null; fecha: string | null; cuerpo: string; adjuntos: Adjunto[]; }

function esPdf(ct: string, n: string) { return /pdf/.test(ct) || /\.pdf$/i.test(n); }
/**
 * La planilla de personas NO se muestra. No es documentación para revisar: es la entrada con la
 * que el sistema da de alta a las personas de la solicitud, y eso ya se ve en la lista de personas.
 */
function esPlanilla(ct: string, n: string) {
  return /\.(xlsx|xlsm|xls|ods|csv|tsv)$/i.test(n) || /spreadsheet|excel|csv|opendocument\.spreadsheet/i.test(ct ?? '');
}

/**
 * Muestra el email de origen embebido (remitente, asunto, cuerpo y adjuntos)
 * directamente dentro del detalle, sin necesidad de abrir una ventana aparte.
 */
export function EmailInline({ emailId, wide }: { emailId: number; wide?: boolean }) {
  const [data, setData] = useState<EmailData | null>(null);
  const [error, setError] = useState('');
  // Qué PDFs están efectivamente abiertos (montados como iframe). Vacío al principio:
  // así abrir la revisión NO dispara la descarga de todos los PDF de golpe.
  const [abiertos, setAbiertos] = useState<Set<number>>(new Set());
  useEffect(() => {
    setData(null); setError(''); setAbiertos(new Set());
    api.get<EmailData>(`/emails/${emailId}/adjuntos`).then(setData).catch((e) => setError(e.message));
  }, [emailId]);
  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <Spinner />;
  // El PDF y el cuerpo se estiran con la ventana en vez de quedar en un alto fijo: en el respaldo
  // hay que leer el mail completo para decidir si la solicitud ya se cargó a mano.
  const alto = wide ? 'calc(100vh - 300px)' : 'calc(100vh - 420px)';
  const altoCuerpo = wide ? 'calc(45vh)' : 'calc(32vh)';
  // Los PDF van con visor propio. El resto NO se esconde: una foto del DNI o del carnet es
  // documentación igual, y antes no se veía en ninguna parte —el correo decía "4 archivos" y acá
  // aparecían 2—. La planilla de personas se lista también, para poder abrirla y controlarla.
  const pdfs = data.adjuntos.filter((a) => esPdf(a.contentType, a.filename));
  const otros = data.adjuntos.filter((a) => !esPdf(a.contentType, a.filename) && !esPlanilla(a.contentType, a.filename));
  const esImagen = (a: Adjunto) => /^image\//i.test(a.contentType ?? '');
  const toggle = (i: number) => setAbiertos((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
  return (
    <>
      <div className="stat-line"><span className="muted">Remitente:</span> <strong>{data.remitente ?? '—'}</strong></div>
      <div className="stat-line"><span className="muted">Asunto:</span> <strong>{data.asunto ?? '—'}</strong></div>
      <div className="stat-line"><span className="muted">Fecha:</span> <strong>{fmtFecha(data.fecha)}</strong></div>
      {data.cuerpo && (
        <div className="card" style={{ margin: '10px 0', padding: 10, whiteSpace: 'pre-wrap', fontSize: 13, maxHeight: altoCuerpo, minHeight: 120, overflow: 'auto' }}>{data.cuerpo}</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 8px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>Documentación PDF ({pdfs.length})</span>
        {pdfs.length > 0 && (
          abiertos.size === pdfs.length
            ? <button className="btn ghost sm" onClick={() => setAbiertos(new Set())}>Cerrar todos</button>
            : <button className="btn ghost sm" onClick={() => setAbiertos(new Set(pdfs.map((a) => a.index)))}>Ver todos</button>
        )}
      </div>
      {pdfs.length === 0 && <p className="muted">El email no tiene documentación en PDF.</p>}
      <div style={wide
        ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }
        : { display: 'flex', flexDirection: 'column', gap: 10 }}>
        {pdfs.map((a) => {
          const url = `/api/emails/${emailId}/adjuntos/${a.index}`;
          const abierto = abiertos.has(a.index);
          // En modo ancho, cada PDF ocupa toda la fila (más legible).
          const cardStyle = wide ? { padding: 8, gridColumn: '1 / -1' as const } : { padding: 8 };
          return (
            <div key={a.index} className="card" style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: abierto ? 6 : 0, gap: 8 }}>
                <strong style={{ fontSize: 12.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.filename}</strong>
                <span className="btn-row">
                  <button className="btn ghost sm" onClick={() => toggle(a.index)}>{abierto ? 'Ocultar' : 'Ver'}</button>
                  <a className="btn ghost sm" href={url} target="_blank" rel="noreferrer">Abrir</a>
                </span>
              </div>
              {/* El iframe (y por ende la descarga) se monta solo cuando el usuario lo pide. */}
              {abierto && <iframe src={url} title={a.filename} style={{ width: '100%', height: alto, minHeight: 380, border: '1px solid var(--border)', borderRadius: 6 }} />}
            </div>
          );
        })}
      </div>
      {otros.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Otros archivos ({otros.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {otros.map((a) => {
              const url = `/api/emails/${emailId}/adjuntos/${a.index}`;
              const abierto = abiertos.has(a.index);
              return (
                <div key={a.index} className="card" style={{ padding: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {esImagen(a) ? '🖼 ' : '📄 '}{a.filename}
                      <span className="muted"> · {(a.size / 1024).toFixed(0)} KB</span>
                    </span>
                    <span className="btn-row">
                      {esImagen(a) && <button className="btn ghost sm" onClick={() => toggle(a.index)}>{abierto ? 'Ocultar' : 'Ver'}</button>}
                      <a className="btn ghost sm" href={url} target="_blank" rel="noreferrer">Abrir</a>
                    </span>
                  </div>
                  {esImagen(a) && abierto && (
                    <img src={url} alt={a.filename} style={{ maxWidth: '100%', marginTop: 8, borderRadius: 6, border: '1px solid var(--border)' }} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
