import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { api } from './api';

export interface User { id: number; nombre: string; email: string; rol: string; }

interface AuthCtx {
  user: User | null;
  loading: boolean;
  needsSetup: boolean;
  /** El servidor tiene configurada la lectura de capturas con IA. */
  capturaIA: boolean;
  login: (email: string, password: string) => Promise<void>;
  setupAdmin: (nombre: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [capturaIA, setCapturaIA] = useState(false);

  async function refresh() {
    try {
      const setup = await api.get<{ needsSetup: boolean }>('/setup/status');
      setNeedsSetup(setup.needsSetup);
      if (!setup.needsSetup) {
        const me = await api.get<{ user: User | null; capturaIA?: boolean }>('/auth/me');
        setUser(me.user);
        setCapturaIA(!!me.capturaIA);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  const login = async (email: string, password: string) => {
    const u = await api.post<User>('/auth/login', { email, password });
    setUser(u);
  };
  const setupAdmin = async (nombre: string, email: string, password: string) => {
    const u = await api.post<User>('/setup/admin', { nombre, email, password });
    setNeedsSetup(false);
    setUser(u);
  };
  const logout = async () => {
    await api.post('/auth/logout');
    setUser(null);
  };

  return <Ctx.Provider value={{ user, loading, needsSetup, capturaIA, login, setupAdmin, logout, refresh }}>{children}</Ctx.Provider>;
}
