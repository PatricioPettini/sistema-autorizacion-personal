export interface ApiError {
  error: string;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    (opts.headers as Record<string, string>)['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error((data as ApiError)?.error ?? `Error ${res.status}`);
  }
  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>('GET', path),
  post: <T,>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T,>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T,>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T,>(path: string, body?: unknown) => request<T>('DELETE', path, body),
  async upload<T>(path: string, form: FormData): Promise<T> {
    const res = await fetch(`/api${path}`, { method: 'POST', body: form, credentials: 'same-origin' });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error((data as ApiError)?.error ?? `Error ${res.status}`);
    return data as T;
  },
};

// ---------- Formateo ----------
export function fmtFecha(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
export function fmtSoloFecha(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s.length <= 10 ? `${s}T00:00:00` : s);
  if (isNaN(d.getTime())) return String(s);
  return new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}
export function hoy(): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
/** Hora actual HH:MM, para arrancar el reporte "quién estaba a tal hora" en el ahora. */
export function ahoraHora(): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}
/** AAAA-MM-DD -> DD/MM/AAAA, sin pasar por Date (no corre el día por zona horaria). */
export function fmtDia(fecha: string): string {
  const [a, m, d] = fecha.split('-');
  return d && m && a ? `${d}/${m}/${a}` : fecha;
}
export function tipoLabel(t?: string | null): string {
  return t === 'EMPRESA' ? 'Empresa' : t === 'MONOTRIBUTISTA' ? 'Monotributista' : t === 'MIXTO' ? 'Mixto' : '—';
}
