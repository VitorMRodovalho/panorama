'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const CORE_API = process.env.CORE_API_URL ?? 'http://localhost:4000';

async function cookieHeader(): Promise<string> {
  const jar = await cookies();
  return jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Map raw API error strings to i18n keys (resolved client-side via
 * `messages.t`). Same pattern as the inspection-templates / blackouts /
 * invitations actions.
 */
function fmtErrorKey(raw: string): string {
  const e = raw.toLowerCase();
  if (e.includes('reservation_conflict')) return 'reservation.error.reservation_conflict';
  if (e.includes('blackout_conflict')) return 'reservation.error.blackout_conflict';
  if (e.includes('asset_not_bookable')) return 'reservation.error.asset_not_bookable';
  if (e.includes('asset_not_available')) return 'reservation.error.asset_not_available';
  if (e.startsWith('min_notice_hours:')) return 'reservation.error.min_notice_hours';
  if (e.startsWith('max_duration_hours:')) return 'reservation.error.max_duration_hours';
  if (e.startsWith('max_concurrent_reservations:')) return 'reservation.error.max_concurrent_reservations';
  if (e.includes('cannot_reserve_on_behalf')) return 'reservation.error.cannot_reserve_on_behalf';
  if (e.includes('start_must_be_before_end')) return 'reservation.error.start_must_be_before_end';
  if (e.includes('cannot_checkout_when_approval')) return 'reservation.error.cannot_checkout_when_approval';
  if (e.includes('cannot_checkout_when_lifecycle')) return 'reservation.error.cannot_checkout_when_lifecycle';
  if (e.includes('asset_not_ready')) return 'reservation.error.asset_not_ready';
  if (e.includes('cannot_checkin_when_lifecycle')) return 'reservation.error.cannot_checkin_when_lifecycle';
  if (e.includes('mileage_required')) return 'reservation.error.mileage_required';
  if (e.includes('mileage_not_monotonic')) return 'reservation.error.mileage_not_monotonic';
  if (e.includes('not_allowed')) return 'reservation.error.not_allowed';
  if (e.includes('basket_not_found')) return 'reservation.error.basket_not_found';
  if (e.includes('basket_batch_disabled')) return 'reservation.error.basket_batch_disabled';
  if (e.includes('admin_role_required')) return 'reservation.error.admin_role_required';
  if (e.includes('note_required')) return 'reservation.error.note_required';
  return 'reservation.error.generic';
}

export async function createReservationAction(formData: FormData): Promise<void> {
  const assetId = String(formData.get('assetId') ?? '').trim() || null;
  const startAt = String(formData.get('startAt') ?? '').trim();
  const endAt = String(formData.get('endAt') ?? '').trim();
  const purpose = String(formData.get('purpose') ?? '').trim() || undefined;
  if (!startAt || !endAt) redirect('/reservations?error=reservation.error.missing_datetime');

  const res = await fetch(`${CORE_API}/reservations`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
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
    `/reservations?error=${encodeURIComponent(fmtErrorKey(body.message ?? 'error'))}`,
  );
}

export async function createBasketAction(formData: FormData): Promise<void> {
  const assetIds = formData
    .getAll('basketAssetIds')
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
  const startAt = String(formData.get('startAt') ?? '').trim();
  const endAt = String(formData.get('endAt') ?? '').trim();
  const purpose = String(formData.get('purpose') ?? '').trim() || undefined;
  if (assetIds.length === 0) {
    redirect('/reservations?error=reservation.error.basket_no_assets');
  }
  if (!startAt || !endAt) redirect('/reservations?error=reservation.error.missing_datetime');

  const res = await fetch(`${CORE_API}/reservations/basket`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      assetIds,
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(endAt).toISOString(),
      ...(purpose ? { purpose } : {}),
    }),
  });

  if (res.status === 201) {
    const body = (await res.json().catch(() => ({}))) as { basketId?: string };
    redirect(
      `/reservations?basket=1${body.basketId ? `&basketId=${encodeURIComponent(body.basketId)}` : ''}`,
    );
  }
  const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
  redirect(
    `/reservations?error=${encodeURIComponent(fmtErrorKey(body.message ?? 'error'))}`,
  );
}

export async function cancelReservationAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim() || undefined;
  if (!id) redirect('/reservations');

  const res = await fetch(`${CORE_API}/reservations/${id}/cancel`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(reason ? { reason } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
    redirect(`/reservations?error=${encodeURIComponent(fmtErrorKey(body.message ?? 'error'))}`);
  }
  redirect('/reservations?cancelled=1');
}

export async function approveReservationAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim() || undefined;
  if (!id) redirect('/reservations');

  const res = await fetch(`${CORE_API}/reservations/${id}/approve`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(note ? { note } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
    redirect(`/reservations?error=${encodeURIComponent(fmtErrorKey(body.message ?? 'error'))}`);
  }
  redirect('/reservations?approved=1');
}

export async function rejectReservationAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim() || undefined;
  if (!id) redirect('/reservations');

  const res = await fetch(`${CORE_API}/reservations/${id}/reject`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(note ? { note } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
    redirect(`/reservations?error=${encodeURIComponent(fmtErrorKey(body.message ?? 'error'))}`);
  }
  redirect('/reservations?rejected=1');
}

async function runBatchAction(
  formData: FormData,
  endpoint: 'approve' | 'reject' | 'cancel',
): Promise<void> {
  const basketId = String(formData.get('basketId') ?? '').trim();
  if (!basketId) redirect('/reservations');

  const payload: Record<string, unknown> = {};
  if (endpoint === 'cancel') {
    const reason = String(formData.get('reason') ?? '').trim();
    if (reason) payload['reason'] = reason;
  } else {
    const note = String(formData.get('note') ?? '').trim();
    if (note) payload['note'] = note;
  }

  const res = await fetch(`${CORE_API}/reservations/basket/${basketId}/${endpoint}`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
    redirect(`/reservations?error=${encodeURIComponent(fmtErrorKey(body.message ?? 'error'))}`);
  }
  const body = (await res.json().catch(() => ({}))) as {
    processed?: unknown[];
    skipped?: Array<{ reservationId?: string; reason?: string }>;
  };
  const processed = Array.isArray(body.processed) ? body.processed.length : 0;
  const skippedArr = Array.isArray(body.skipped) ? body.skipped : [];
  const skipped = skippedArr.length;

  // Group skip reasons so the banner surfaces WHICH preconditions
  // fired, not just a bare count. persona-fleet-ops blocker: "1 skipped"
  // is the scariest banner in fleet ops — was it a benign already-
  // approved sibling, or an In-Service vehicle the driver took on the
  // road? We pass a compact reason:count summary through the URL.
  const reasonCounts = new Map<string, number>();
  for (const s of skippedArr) {
    const key = typeof s.reason === 'string' ? s.reason : 'unknown';
    reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
  }
  const reasonsParam = Array.from(reasonCounts.entries())
    .map(([reason, count]) => `${reason}:${count}`)
    .join('|');

  const params = new URLSearchParams();
  params.set('batch', endpoint);
  params.set('processed', String(processed));
  params.set('skipped', String(skipped));
  if (reasonsParam) params.set('skippedReasons', reasonsParam);
  redirect(`/reservations?${params.toString()}`);
}

export async function approveBasketAction(formData: FormData): Promise<void> {
  return runBatchAction(formData, 'approve');
}

export async function rejectBasketAction(formData: FormData): Promise<void> {
  return runBatchAction(formData, 'reject');
}

export async function cancelBasketAction(formData: FormData): Promise<void> {
  return runBatchAction(formData, 'cancel');
}

export async function checkoutReservationAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  const mileageRaw = String(formData.get('mileage') ?? '').trim();
  const condition = String(formData.get('condition') ?? '').trim() || undefined;
  if (!id) redirect('/reservations');

  const payload: Record<string, unknown> = {};
  if (mileageRaw) {
    const n = Number(mileageRaw);
    if (Number.isFinite(n) && n >= 0) payload['mileage'] = Math.trunc(n);
  }
  if (condition) payload['condition'] = condition;

  const res = await fetch(`${CORE_API}/reservations/${id}/checkout`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
    redirect(`/reservations?error=${encodeURIComponent(fmtErrorKey(body.message ?? 'error'))}`);
  }
  redirect('/reservations?checkedout=1');
}

export async function checkinReservationAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  const mileageRaw = String(formData.get('mileage') ?? '').trim();
  const condition = String(formData.get('condition') ?? '').trim() || undefined;
  const damageFlag = formData.get('damageFlag') === 'on';
  const damageNote = String(formData.get('damageNote') ?? '').trim() || undefined;
  if (!id) redirect('/reservations');

  const payload: Record<string, unknown> = { damageFlag };
  if (mileageRaw) {
    const n = Number(mileageRaw);
    if (Number.isFinite(n) && n >= 0) payload['mileage'] = Math.trunc(n);
  }
  if (condition) payload['condition'] = condition;
  if (damageFlag && damageNote) payload['damageNote'] = damageNote;

  const res = await fetch(`${CORE_API}/reservations/${id}/checkin`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
    redirect(`/reservations?error=${encodeURIComponent(fmtErrorKey(body.message ?? 'error'))}`);
  }
  redirect('/reservations?checkedin=1');
}
