import type { ReactElement } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './auth';
import { Spinner } from './ui';
import Layout from './components/Layout';
import Login from './pages/Login';
import Setup from './pages/Setup';
import Dashboard from './pages/Dashboard';
import Solicitudes from './pages/Solicitudes';
import SolicitudDetalle from './pages/SolicitudDetalle';
import Personas from './pages/Personas';
import PersonaDetalle from './pages/PersonaDetalle';
import Dentro from './pages/Dentro';
import Reportes from './pages/Reportes';
import Locales from './pages/Locales';
import Usuarios from './pages/Usuarios';
import TiposDocumento from './pages/TiposDocumento';
import Monitor from './pages/Monitor';
import Auditoria from './pages/Auditoria';
import Respaldo from './pages/Respaldo';
import Papelera from './pages/Papelera';
import CorreosEnviados from './pages/CorreosEnviados';

function AdminRoute({ children }: { children: ReactElement }) {
  const { user } = useAuth();
  if (user?.rol !== 'ADMIN') return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const { user, loading, needsSetup } = useAuth();

  if (loading) return <div className="center-screen"><Spinner /></div>;
  if (needsSetup) return <Setup />;
  if (!user) return <Login />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        {/* "Consultar persona" se unificó dentro de Personas. */}
        <Route path="/consulta" element={<Navigate to="/personas" replace />} />
        <Route path="/solicitudes" element={<Solicitudes />} />
        <Route path="/solicitudes/:id" element={<SolicitudDetalle />} />
        <Route path="/personas" element={<Personas />} />
        <Route path="/personas/:id" element={<PersonaDetalle />} />
        <Route path="/dentro" element={<Dentro />} />
        <Route path="/reportes" element={<Reportes />} />
        <Route path="/locales" element={<AdminRoute><Locales /></AdminRoute>} />
        <Route path="/usuarios" element={<AdminRoute><Usuarios /></AdminRoute>} />
        <Route path="/tipos-documento" element={<AdminRoute><TiposDocumento /></AdminRoute>} />
        <Route path="/respaldo" element={<AdminRoute><Respaldo /></AdminRoute>} />
        <Route path="/papelera" element={<AdminRoute><Papelera /></AdminRoute>} />
        <Route path="/correos" element={<AdminRoute><CorreosEnviados /></AdminRoute>} />
        <Route path="/monitor" element={<AdminRoute><Monitor /></AdminRoute>} />
        <Route path="/auditoria" element={<AdminRoute><Auditoria /></AdminRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
