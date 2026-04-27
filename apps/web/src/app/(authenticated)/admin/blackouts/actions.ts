'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const CORE_API = process.env['CORE_API_URL'] ?? 'http://localhost:4000';

async function cookieHeader(): Promise<string> {
  const jar = await cookies();
  return jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Translate raw API error strings to i18n keys (resolved client-side
 * via `messages.t`). Same pattern as the inspection-templates /
 * maintenance / reservation actions.
 */
function fmtErrorKey(raw: string): string {
  const e = raw.toLowerCase();
  if (e.includes('admin_role_required')) return 'blackout.error.admin_required';
  if (e.includes('start_must_be_before_end')) return 'blackout.error.start_after_end';
  if (e.includes('asset_not_found')) return 'blackout.error.asset_not_found';
  if (e.includes('blackout_not_found')) return 'blackout.error.not_found';
  if (e.includes('invalid_body') || e.includes('invalid_query'))
    return 'blackout.error.invalid_body';
  return 'blackout.error.generic';
}

// ---------------------------------------------------------------
// create
// ---------------------------------------------------------------

export async function createBlackoutAction(formData: FormData): Promise<void> {
  const title = String(formData.get('title') ?? '').trim();
  const assetIdRaw = String(formData.get('assetId') ?? '').trim();
  const startAtRaw = String(formData.get('startAt') ?? '').trim();
  const endAtRaw = String(formData.get('endAt') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();

  if (!title) {
    redirect('/admin/blackouts?error=' + encodeURIComponent('blackout.error.title_required'));
  }
  if (!startAtRaw || !endAtRaw) {
    redirect(
      '/admin/blackouts?error=' + encodeURIComponent('blackout.error.dates_required'),
    );
  }
  // <input type="datetime-local"> emits "YYYY-MM-DDTHH:MM" with no
  // seconds + no timezone — the API expects a Zod-validated
  // ISO-8601 datetime. Normalise here so the user doesn't have to
  // hand-type a Z suffix.
  const startAt = new Date(startAtRaw).toISOString();
  const endAt = new Date(endAtRaw).toISOString();

  const body: Record<string, unknown> = {
    title,
    startAt,
    endAt,
  };
  if (assetIdRaw) body['assetId'] = assetIdRaw;
  if (reason) body['reason'] = reason;

  const res = await fetch(`${CORE_API}/blackouts`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(body),
  });
  if (res.status === 201) {
    redirect('/admin/blackouts?created=1');
  }
  const payload = (await res.json().catch(() => ({ message: 'error' }))) as {
    message?: string;
  };
  redirect(
    '/admin/blackouts?error=' + encodeURIComponent(fmtErrorKey(payload.message ?? 'error')),
  );
}

// ---------------------------------------------------------------
// delete
// ---------------------------------------------------------------

export async function deleteBlackoutAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  if (!id) redirect('/admin/blackouts');

  const res = await fetch(`${CORE_API}/blackouts/${id}`, {
    method: 'DELETE',
    headers: { cookie: await cookieHeader() },
    cache: 'no-store',
  });
  if (res.status === 204) {
    redirect('/admin/blackouts?deleted=1');
  }
  const payload = (await res.json().catch(() => ({ message: 'error' }))) as {
    message?: string;
  };
  redirect(
    '/admin/blackouts?error=' + encodeURIComponent(fmtErrorKey(payload.message ?? 'error')),
  );
}
