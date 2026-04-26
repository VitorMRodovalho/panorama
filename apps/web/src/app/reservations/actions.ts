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
  if (e.includes('cannot_checkout_when_approval')) return 'Reservation must be approved before check-out.';
  if (e.includes('cannot_checkout_when_lifecycle')) return 'Reservation is not in a bookable state.';
  if (e.includes('asset_not_ready')) return "Asset isn't ready (in use, maintenance, or retired).";
  if (e.includes('cannot_checkin_when_lifecycle')) return 'Reservation must be checked-out before check-in.';
  if (e.includes('mileage_not_monotonic')) return 'Check-in mileage must be ≥ check-out mileage.';
  if (e.includes('not_allowed')) return "You aren't allowed to perform this action.";
  if (e.includes('basket_not_found')) return 'Basket not found (it may have been fully cancelled or deleted).';
  if (e.includes('basket_batch_disabled')) return 'Basket batch actions are disabled for this tenant.';
  if (e.includes('admin_role_required')) return 'Admin role required for this action.';
  if (e.includes('note_required')) return 'A reason is required when rejecting.';
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
    `/reservations?error=${encodeURIComponent(fmtError(body.message ?? 'error'))}`,
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
    redirect('/reservations?error=' + encodeURIComponent('Select at least one asset.'));
  }
  if (!startAt || !endAt) redirect('/reservations?error=missing_datetime');

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
    `/reservations?error=${encodeURIComponent(fmtError(body.message ?? 'error'))}`,
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
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
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
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(note ? { note } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
    redirect(`/reservations?error=${encodeURIComponent(fmtError(body.message ?? 'error'))}`);
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
    redirect(`/reservations?error=${encodeURIComponent(fmtError(body.message ?? 'error'))}`);
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
    redirect(`/reservations?error=${encodeURIComponent(fmtError(body.message ?? 'error'))}`);
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
    redirect(`/reservations?error=${encodeURIComponent(fmtError(body.message ?? 'error'))}`);
  }
  redirect('/reservations?checkedin=1');
}
