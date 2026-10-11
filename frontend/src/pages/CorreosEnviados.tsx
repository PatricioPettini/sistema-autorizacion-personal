import { useState } from 'react';
import { SentEmails } from '../components/SentEmails';

const TIPOS = [
  { v: '', label: 'Todos' },
  { v: 'RESULTADO_REVISION', label: 'Resultado de revisión' },
  { v: 'OBSERVACION', label: 'Observación' },
  { v: 'RECHAZO', label: 'Rechazo' },
  { v: 'AUTORIZACION', label: 'Autorización' },
  { v: 'PLANILLA_EXCESIVA', label: 'Aviso: planilla excesiva' },
];

/** Respuestas automáticas del sistema, con filtro por N° de orden / destinatario / asunto y tipo. */
export default function CorreosEnviados() {
  const [q, setQ] = useState('');
  const [tipo, setTipo] = useState('');

  return (
    <>
      <div className="page-head">
        <div><h1>Correos enviados</h1><div className="subtitle">Respuestas automáticas del sistema (resultado, observación, rechazo, autorización…)</div></div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ margin: 0, flex: 1, minWidth: 220 }}>
            <label>Buscar por N° de orden, destinatario o asunto</label>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ej: OA-2026-0012" />
          </div>
          <div className="field" style={{ margin: 0, minWidth: 200 }}>
            <label>Tipo</label>
            <select value={tipo} onChange={(e) => setTipo(e.target.value)}>
              {TIPOS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-body">
          <SentEmails q={q} tipo={tipo} showOrden />
        </div>
      </div>
    </>
  );
}
