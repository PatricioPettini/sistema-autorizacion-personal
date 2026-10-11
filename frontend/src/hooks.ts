import { useState, useEffect, useCallback } from 'react';
import { api } from './api';

export function useFetch<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (path === null) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<T>(path));
    } catch (e: any) {
      setError(e.message ?? 'Error');
    } finally {
      setLoading(false);
    }
     
  }, [path]);

  useEffect(() => { reload();   }, deps);

  return { data, loading, error, reload, setData };
}
