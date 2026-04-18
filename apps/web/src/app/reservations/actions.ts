'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const CORE_API = process.env.CORE_API_URL ?? 'http://localhost:4000';

function cookieHeader(): string {
  return cookies()
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function fmtError(raw: string): string {
  const e = raw.toLowerCase();
  if (e.includes('reservation_conflict')) return 'This asset is already booked for an overlapping time.';
  if (e.includes('blackout_conflict')) return 'This time falls inside a blackout window.';
  if (e.includes('asset_not_bookable')) return "This asset isn't bookable.";
  if (e.includes('asset_not_available')) return "This asset isn't available (maintenance or retired).";
  if (e.startsWith('min_notice_hours:')) return 'Reservation is too soon — check the notice policy.';
  if (e.startsWith('max_duration_hours:')) return 'Reservation exceeds the maximum allowed duration.';
  if (e.startsWith('max_concurrent_reservations:')) return 'You already have the maximum active reservations.';
  if (e.includes('cannot_reserve_on_behalf')) return 'You cannot reserve on behalf of another user.';
  if (e.includes('start_must_be_before_end')) return 'Start must be before end.';
  return raw;
}

export async function createReservationAction(formData: FormData): Promise<void> {
  const assetId = String(formData.get('assetId') ?? '').trim() || null;
  const startAt = String(formData.get('startAt') ?? '').trim();
  const endAt = String(formData.get('endAt') ?? '').trim();
  const purpose = String(formData.get('purpose') ?? '').trim() || undefined;
  if (!startAt || !endAt) redirect('/reservations?error=missing_datetime');

  const res = await fetch(`${CORE_API}/reservations`, {
    method: 'POST',
    headers: { cookie: cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      assetId,
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(endAt).toISOString(),
      ...(purpose ? { purpose } : {}),
    }),
  });

  if (res.status === 201) {
    redirect('/reservations?created=1');
  }
  const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
  redirect(
    `/reservations?error=${encodeURIComponent(fmtError(body.message ?? 'error'))}`,
  );
}

export async function cancelReservationAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim() || undefined;
  if (!id) redirect('/reservations');

  const res = await fetch(`${CORE_API}/reservations/${id}/cancel`, {
    method: 'POST',
    headers: { cookie: cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(reason ? { reason } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
    redirect(`/reservations?error=${encodeURIComponent(fmtError(body.message ?? 'error'))}`);
  }
  redirect('/reservations?cancelled=1');
}

export async function approveReservationAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim() || undefined;
  if (!id) redirect('/reservations');

  const res = await fetch(`${CORE_API}/reservations/${id}/approve`, {
    method: 'POST',
    headers: { cookie: cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(note ? { note } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
    redirect(`/reservations?error=${encodeURIComponent(fmtError(body.message ?? 'error'))}`);
  }
  redirect('/reservations?approved=1');
}

export async function rejectReservationAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim() || undefined;
  if (!id) redirect('/reservations');

  const res = await fetch(`${CORE_API}/reservations/${id}/reject`, {
    method: 'POST',
    headers: { cookie: cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(note ? { note } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
    redirect(`/reservations?error=${encodeURIComponent(fmtError(body.message ?? 'error'))}`);
  }
  redirect('/reservations?rejected=1');
}
