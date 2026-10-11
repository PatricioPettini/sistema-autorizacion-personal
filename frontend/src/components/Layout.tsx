import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { api } from '../api';

/** Evento para avisarle a la campanita que la bandeja de respaldo cambió. */
export const RESPALDO_CAMBIO = 'respaldo:cambio';
export const avisarRespaldoCambio = () => window.dispatchEvent(new Event(RESPALDO_CAMBIO));

function Item({ to, ico, label, pill }: { to: string; ico: string; label: string; pill?: number }) {
  return (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
      <span className="ico">{ico}</span>
      <span>{label}</span>
      {pill ? <span className="pill">{pill}</span> : null}
    </NavLink>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [q, setQ] = useState('');
  // Sidebar como cajón en pantalla angosta. Se cierra al navegar: si no, tapa la pantalla nueva.
  const [menuAbierto, setMenuAbierto] = useState(false);
  useEffect(() => { setMenuAbierto(false); }, [loc.pathname]);
  const isAdmin = user?.rol === 'ADMIN';
  const [respaldo, setRespaldo] = useState(0);

  // Contador de correos en respaldo (para la campanita). Con un intervalo solo, el número queda
  // mintiendo hasta un minuto entero: de más cuando ya vaciaste la bandeja, y de menos cuando
  // acaba de entrar un correo. Así que además se refresca al navegar, al volver a la pestaña y
  // cuando la pantalla de Respaldo resuelve algo.
  const cargarRespaldo = useCallback(() => {
    if (!isAdmin) return;
    api.get<{ count: number }>('/emails/respaldo/count').then((r) => setRespaldo(r.count)).catch(() => {});
  }, [isAdmin]);

  useEffect(() => { cargarRespaldo(); }, [cargarRespaldo, loc.pathname]);

  useEffect(() => {
    if (!isAdmin) return;
    const alVolver = () => { if (!document.hidden) cargarRespaldo(); };
    const t = setInterval(cargarRespaldo, 20000);
    window.addEventListener(RESPALDO_CAMBIO, cargarRespaldo);
    window.addEventListener('focus', cargarRespaldo);
    document.addEventListener('visibilitychange', alVolver);
    return () => {
      clearInterval(t);
      window.removeEventListener(RESPALDO_CAMBIO, cargarRespaldo);
      window.removeEventListener('focus', cargarRespaldo);
      document.removeEventListener('visibilitychange', alVolver);
    };
  }, [isAdmin, cargarRespaldo]);

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (q.trim()) nav(`/personas?q=${encodeURIComponent(q.trim())}`);
  };

  return (
    <div className="app">
      <div className={`sidebar-backdrop ${menuAbierto ? 'visible' : ''}`} onClick={() => setMenuAbierto(false)} />
      <aside className={`sidebar ${menuAbierto ? 'abierta' : ''}`}>
        <div className="brand">
          <span className="logo">🛡️</span>
          <span>Control de Ingresos</span>
        </div>
        <nav>
          <Item to="/" ico="▦" label="Panel" />
          <Item to="/solicitudes" ico="📄" label="Solicitudes" />
          <Item to="/personas" ico="👤" label="Personas" />
          <Item to="/dentro" ico="🟢" label="Dentro del shopping" />
          <Item to="/reportes" ico="📊" label="Reportes" />
          {isAdmin && (
            <>
              <div className="nav-group">Administración</div>
              <Item to="/respaldo" ico="🛟" label="Respaldo" pill={respaldo || undefined} />
              <Item to="/correos" ico="📤" label="Correos enviados" />
              <Item to="/papelera" ico="🗑️" label="Papelera" />
              <Item to="/locales" ico="🏬" label="Locales" />
              <Item to="/usuarios" ico="👥" label="Usuarios" />
              <Item to="/tipos-documento" ico="🗂️" label="Tipos de documento" />
              <Item to="/monitor" ico="📡" label="Monitoreo" />
              <Item to="/auditoria" ico="📚" label="Auditoría" />
            </>
          )}
        </nav>
        <div className="userbox">
          <div className="name">{user?.nombre}</div>
          <div className="rol">{user?.rol === 'ADMIN' ? 'Administrador' : 'Seguridad'}</div>
          <button className="btn ghost sm" style={{ color: '#cbd5e1', marginTop: 8, paddingLeft: 0 }} onClick={() => logout()}>
            ↩ Cerrar sesión
          </button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <button className="menu-btn" onClick={() => setMenuAbierto((v) => !v)} aria-label="Abrir el menú" title="Menú">☰</button>
          <form className="search" onSubmit={onSearch}>
            <span className="ico">🔎</span>
            <input placeholder="Buscar por CUIL, DNI o nombre…" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          {isAdmin && (
            <button
              className="bell"
              onClick={() => nav('/respaldo')}
              title={respaldo ? `${respaldo} correo(s) en respaldo para revisar` : 'Respaldo: sin pendientes'}
              style={{ position: 'relative', marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}
            >
              🔔
              {respaldo > 0 && (
                <span style={{ position: 'absolute', top: -6, right: -6, background: 'var(--red, #dc2626)', color: '#fff', borderRadius: 999, fontSize: 11, fontWeight: 700, minWidth: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' }}>
                  {respaldo > 99 ? '99+' : respaldo}
                </span>
              )}
            </button>
          )}
        </div>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
