'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const CORE_API = process.env.CORE_API_URL ?? 'http://localhost:4000';

export interface DiscoveryResult {
  providers: Array<'password' | 'google' | 'microsoft'>;
  tenantHint: { id: string; slug: string; displayName: string } | null;
}

export async function discoveryAction(email: string): Promise<DiscoveryResult> {
  try {
    const res = await fetch(`${CORE_API}/auth/discovery?email=${encodeURIComponent(email)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return { providers: ['password'], tenantHint: null };
    return (await res.json()) as DiscoveryResult;
  } catch {
    return { providers: ['password'], tenantHint: null };
  }
}

/**
 * Server action for the password login form. On success, copies the
 * Set-Cookie from core-api onto the Next.js response so the browser
 * stores it on the same origin as the web app.
 */
export async function loginAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').toLowerCase().trim();
  const password = String(formData.get('password') ?? '');
  const nextRaw = String(formData.get('next') ?? '');
  const next = nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '/assets';

  const res = await fetch(`${CORE_API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
    cache: 'no-store',
  });

  if (res.status !== 200) {
    redirect(
      `/login?error=invalid_credentials&email=${encodeURIComponent(email)}${
        nextRaw ? `&next=${encodeURIComponent(nextRaw)}` : ''
      }`,
    );
  }

  // Copy Set-Cookie from core-api → our response.
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const jar = cookies();
  for (const raw of setCookies) {
    const [first = '', ...rest] = raw.split(';');
    const [name = '', ...valueParts] = first.split('=');
    const value = valueParts.join('=');
    if (!name) continue;
    const opts: Parameters<typeof jar.set>[2] = { path: '/' };
    for (const attr of rest) {
      const [k, v] = attr.trim().split('=');
      const key = (k ?? '').toLowerCase();
      if (key === 'max-age' && v) opts.maxAge = parseInt(v, 10);
      else if (key === 'path' && v) opts.path = v;
      else if (key === 'httponly') opts.httpOnly = true;
      else if (key === 'secure') opts.secure = true;
      else if (key === 'samesite' && v) opts.sameSite = v.toLowerCase() as 'lax' | 'strict' | 'none';
    }
    jar.set(name.trim(), value, opts);
  }

  redirect(next);
}

export async function logoutAction(): Promise<void> {
  const jar = cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  await fetch(`${CORE_API}/auth/logout`, {
    method: 'POST',
    headers: { cookie: cookieHeader },
    cache: 'no-store',
  }).catch(() => undefined);

  jar.delete('panorama_session');
  redirect('/login');
}

export async function switchTenantAction(formData: FormData): Promise<void> {
  const tenantId = String(formData.get('tenantId') ?? '');
  const jar = cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const res = await fetch(`${CORE_API}/auth/tenants/switch`, {
    method: 'POST',
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId }),
    cache: 'no-store',
  });

  if (res.status !== 200) redirect('/assets?switchError=1');

  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const raw of setCookies) {
    const [first = '', ...rest] = raw.split(';');
    const [name = '', ...valueParts] = first.split('=');
    const value = valueParts.join('=');
    if (!name) continue;
    const opts: Parameters<typeof jar.set>[2] = { path: '/' };
    for (const attr of rest) {
      const [k, v] = attr.trim().split('=');
      const key = (k ?? '').toLowerCase();
      if (key === 'max-age' && v) opts.maxAge = parseInt(v, 10);
      else if (key === 'path' && v) opts.path = v;
      else if (key === 'httponly') opts.httpOnly = true;
      else if (key === 'secure') opts.secure = true;
      else if (key === 'samesite' && v) opts.sameSite = v.toLowerCase() as 'lax' | 'strict' | 'none';
    }
    jar.set(name.trim(), value, opts);
  }

  redirect('/assets');
}
