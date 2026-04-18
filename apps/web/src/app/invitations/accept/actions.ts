'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const CORE_API = process.env.CORE_API_URL ?? 'http://localhost:4000';

/**
 * POSTs to /invitations/accept with the session cookie attached. On
 * success core-api rewrites the session cookie to include the new
 * membership; we copy the Set-Cookie through and redirect to /assets.
 */
export async function finalizeAcceptAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '').trim();
  if (!token) redirect('/invitations/accept');

  const jar = cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const res = await fetch(
    `${CORE_API}/invitations/accept?t=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    },
  );

  // Re-emit any Set-Cookie so the browser persists the rebuilt session.
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
      else if (key === 'samesite' && v) {
        opts.sameSite = v.toLowerCase() as 'lax' | 'strict' | 'none';
      }
    }
    jar.set(name.trim(), value, opts);
  }

  if (!res.ok) {
    redirect(`/invitations/accept?t=${encodeURIComponent(token)}&error=server`);
  }

  const body = (await res.json().catch(() => ({}))) as { state?: string };
  if (body.state === 'accepted') redirect('/assets');
  if (body.state === 'email_mismatch') {
    redirect(`/invitations/accept?t=${encodeURIComponent(token)}&error=email_mismatch`);
  }
  if (body.state === 'invalid') {
    redirect(`/invitations/accept?t=${encodeURIComponent(token)}&error=invalid`);
  }
  if (body.state === 'needs_login') redirect('/login');

  redirect('/invitations/accept');
}
