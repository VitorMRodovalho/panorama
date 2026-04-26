import 'server-only';
import { cookies, headers } from 'next/headers';

/**
 * Thin typed fetch client used by server components + route handlers to
 * talk to `@panorama/core-api`. Hits the Next.js rewrite at `/api/*` so
 * browser-originated cookies stay on the same origin.
 *
 * For SERVER-SIDE rendering, we have to manually forward the user's
 * session cookie — Next doesn't do it automatically across process
 * boundaries. `forwardSessionCookie()` reads the inbound request's
 * cookies and attaches them to the outbound call.
 */
const CORE_API = process.env.CORE_API_URL ?? 'http://localhost:4000';

async function forwardSessionCookie(init?: RequestInit): Promise<RequestInit> {
  const [jar, hdr] = await Promise.all([cookies(), headers()]);
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      cookie: cookieHeader,
      // Traceability across the web → api hop
      'x-forwarded-host': hdr.get('host') ?? '',
      'x-forwarded-proto': hdr.get('x-forwarded-proto') ?? 'http',
    },
    cache: 'no-store',
  };
}

export async function apiGet<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  const res = await fetch(`${CORE_API}${path}`, await forwardSessionCookie({ method: 'GET' }));
  if (!res.ok) return { ok: false, status: res.status };
  const data = (await res.json()) as T;
  return { ok: true, data };
}

export async function apiPost<T>(
  path: string,
  body: unknown,
): Promise<{ ok: true; data: T; setCookie: string[] } | { ok: false; status: number }> {
  const res = await fetch(
    `${CORE_API}${path}`,
    await forwardSessionCookie({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
  );
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (!res.ok) return { ok: false, status: res.status };
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: true, data, setCookie };
}
