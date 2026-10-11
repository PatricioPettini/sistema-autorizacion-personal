import { useState } from 'react';
import { useAuth } from '../auth';

export default function Setup() {
  const { setupAdmin } = useAuth();
  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await setupAdmin(nombre, email, password);
    } catch (err: any) {
      setError(err.message ?? 'No se pudo crear el administrador.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="card auth-card">
        <div className="card-body">
          <div className="auth-logo">🛡️</div>
          <h1 style={{ textAlign: 'center' }}>Bienvenido</h1>
          <p className="muted" style={{ textAlign: 'center', marginTop: -4, marginBottom: 20 }}>
            Vamos a crear el usuario administrador para empezar a usar el sistema.
          </p>
          {error && <div className="alert error">{error}</div>}
          <form onSubmit={submit}>
            <div className="field">
              <label>Nombre y apellido</label>
              <input value={nombre} onChange={(e) => setNombre(e.target.value)} autoFocus required />
            </div>
            <div className="field">
              <label>Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label>Contraseña</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
              <div className="hint">Mínimo 8 caracteres.</div>
            </div>
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={loading}>
              {loading ? 'Creando…' : 'Crear administrador y comenzar'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
