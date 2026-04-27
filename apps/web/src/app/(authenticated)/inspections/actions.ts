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
 * `messages.t`). Same pattern as reservations / blackouts /
 * invitations actions. The `required_items_missing:<labels>` path
 * carries item labels through a sibling `errorItems` URL param —
 * see `maybeErrorItemsParam` below.
 */
function fmtErrorKey(raw: string): string {
  const e = raw.toLowerCase();
  if (e.includes('asset_not_found')) return 'inspection.error.asset_not_found';
  if (e.includes('reservation_not_found')) return 'inspection.error.reservation_not_found';
  if (e.includes('reservation_asset_mismatch')) return 'inspection.error.reservation_asset_mismatch';
  if (e.includes('no_template_for_asset')) return 'inspection.error.no_template_for_asset';
  if (e.includes('template_not_found')) return 'inspection.error.template_not_found';
  if (e.includes('template_archived')) return 'inspection.error.template_archived';
  if (e.includes('inspection_not_found')) return 'inspection.error.inspection_not_found';
  if (e.includes('inspection_not_in_progress')) return 'inspection.error.inspection_not_in_progress';
  if (e.includes('inspection_already_reviewed')) return 'inspection.error.inspection_already_reviewed';
  if (e.includes('inspection_already_completed')) return 'inspection.error.inspection_already_completed';
  if (e.includes('inspection_not_completed')) return 'inspection.error.inspection_not_completed';
  if (e.includes('not_inspection_starter')) return 'inspection.error.not_inspection_starter';
  if (e.startsWith('required_items_missing:')) return 'inspection.error.required_items_missing_named';
  if (e.startsWith('snapshot_item_id_not_in_snapshot')) return 'inspection.error.snapshot_item_id_not_in_snapshot';
  if (e.startsWith('response_missing_booleanvalue')) return 'inspection.error.response_missing_boolean';
  if (e.startsWith('response_missing_numbervalue')) return 'inspection.error.response_missing_number';
  if (e.startsWith('response_missing_textvalue')) return 'inspection.error.response_missing_text';
  if (e.startsWith('response_below_min')) return 'inspection.error.response_below_min';
  if (e.startsWith('response_above_max')) return 'inspection.error.response_above_max';
  if (e.includes('admin_role_required')) return 'inspection.error.admin_role_required';
  return 'inspection.error.generic';
}

/**
 * For `required_items_missing:<labels>` the backend ships pipe-joined
 * item labels in the message body. We carry them through a sibling
 * `errorItems` URL param so the page-side `messages.t(...)` can
 * substitute `{{items}}` at render time. Empty string for any other
 * error path.
 */
function maybeErrorItemsParam(raw: string): string {
  if (!raw.toLowerCase().startsWith('required_items_missing:')) return '';
  const tail = raw.split(':').slice(1).join(':');
  return '&errorItems=' + encodeURIComponent(tail.split('|').join(', '));
}

// ---------------------------------------------------------------------
// start — driver picks an asset and (optionally) a reservation; server
// either resumes an in-progress inspection on that asset or starts a
// fresh one. Either way, redirect to /inspections/:id.
// ---------------------------------------------------------------------

export async function startInspectionAction(formData: FormData): Promise<void> {
  const assetId = String(formData.get('assetId') ?? '').trim();
  const reservationId = String(formData.get('reservationId') ?? '').trim() || undefined;
  if (!assetId) {
    redirect('/inspections/new?error=inspection.error.pick_asset');
  }

  const res = await fetch(`${CORE_API}/inspections`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ assetId, ...(reservationId ? { reservationId } : {}) }),
  });

  if (res.status === 201) {
    const body = (await res.json()) as { id: string; resumed: boolean };
    redirect(`/inspections/${body.id}${body.resumed ? '?resumed=1' : ''}`);
  }
  const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
  const msg = body.message ?? 'error';
  redirect(
    `/inspections/new?error=${encodeURIComponent(fmtErrorKey(msg))}${maybeErrorItemsParam(msg)}`,
  );
}

// ---------------------------------------------------------------------
// respond — saves a single response (per-item form submit). The form
// renders one HTML <form> per item so a partial save survives a
// reload; bulk-submit-everything-on-complete trades simplicity for
// data loss when the driver mistypes an unrelated number.
// ---------------------------------------------------------------------

export async function respondInspectionAction(formData: FormData): Promise<void> {
  const inspectionId = String(formData.get('inspectionId') ?? '').trim();
  const snapshotItemId = String(formData.get('snapshotItemId') ?? '').trim();
  const itemType = String(formData.get('itemType') ?? '').trim();
  if (!inspectionId || !snapshotItemId) {
    redirect(`/inspections/${inspectionId}?error=inspection.error.missing_item_id`);
  }

  const payload: Record<string, unknown> = { snapshotItemId };
  if (itemType === 'BOOLEAN') {
    const raw = String(formData.get('booleanValue') ?? '').trim();
    payload.booleanValue = raw === 'true';
  } else if (itemType === 'TEXT') {
    const raw = String(formData.get('textValue') ?? '').trim();
    if (raw) payload.textValue = raw;
  } else if (itemType === 'NUMBER') {
    const raw = String(formData.get('numberValue') ?? '').trim();
    if (raw) payload.numberValue = Number(raw);
  }
  const note = String(formData.get('note') ?? '').trim();
  if (note) payload.note = note;

  const res = await fetch(`${CORE_API}/inspections/${inspectionId}/responses`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ responses: [payload] }),
  });

  if (res.status === 200) {
    redirect(`/inspections/${inspectionId}?saved=${encodeURIComponent(snapshotItemId)}`);
  }
  const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
  const msg = body.message ?? 'error';
  redirect(
    `/inspections/${inspectionId}?error=${encodeURIComponent(fmtErrorKey(msg))}${maybeErrorItemsParam(msg)}`,
  );
}

// ---------------------------------------------------------------------
// complete — flips IN_PROGRESS → COMPLETED with chosen outcome.
// Backend rejects if any required item is missing.
// ---------------------------------------------------------------------

export async function completeInspectionAction(formData: FormData): Promise<void> {
  const inspectionId = String(formData.get('inspectionId') ?? '').trim();
  const outcome = String(formData.get('outcome') ?? '').trim();
  const summaryNote = String(formData.get('summaryNote') ?? '').trim() || undefined;
  if (!inspectionId || !outcome) {
    redirect(`/inspections/${inspectionId}?error=inspection.error.missing_outcome`);
  }

  const res = await fetch(`${CORE_API}/inspections/${inspectionId}/complete`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ outcome, ...(summaryNote ? { summaryNote } : {}) }),
  });

  if (res.status === 200) {
    redirect(`/inspections?completed=${inspectionId}`);
  }
  const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
  const msg = body.message ?? 'error';
  redirect(
    `/inspections/${inspectionId}?error=${encodeURIComponent(fmtErrorKey(msg))}${maybeErrorItemsParam(msg)}`,
  );
}

// ---------------------------------------------------------------------
// cancel — driver-or-admin cancels an in-progress inspection.
// ---------------------------------------------------------------------

export async function cancelInspectionAction(formData: FormData): Promise<void> {
  const inspectionId = String(formData.get('inspectionId') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim() || undefined;
  if (!inspectionId) redirect('/inspections');

  const res = await fetch(`${CORE_API}/inspections/${inspectionId}/cancel`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(reason ? { reason } : {}),
  });

  if (res.status === 200) {
    redirect(`/inspections?cancelled=${inspectionId}`);
  }
  const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
  const msg = body.message ?? 'error';
  redirect(
    `/inspections/${inspectionId}?error=${encodeURIComponent(fmtErrorKey(msg))}${maybeErrorItemsParam(msg)}`,
  );
}

// ---------------------------------------------------------------------
// Photo upload moved to a same-origin Next.js route handler
// (apps/web/src/app/api/inspections/[id]/photos/route.ts) so the client
// uploader (apps/web/src/app/inspections/[id]/photo-uploader.tsx) can
// drive XHR with progress, cancel, and retry. UX-22 / #46.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// review — admin closes out a completed FAIL / NEEDS_MAINTENANCE.
// ---------------------------------------------------------------------

export async function reviewInspectionAction(formData: FormData): Promise<void> {
  const inspectionId = String(formData.get('inspectionId') ?? '').trim();
  const reviewNote = String(formData.get('reviewNote') ?? '').trim() || undefined;
  if (!inspectionId) redirect('/inspections');

  const res = await fetch(`${CORE_API}/inspections/${inspectionId}/review`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(reviewNote ? { reviewNote } : {}),
  });

  if (res.status === 200) {
    redirect(`/inspections/${inspectionId}?reviewed=1`);
  }
  const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
  const msg = body.message ?? 'error';
  redirect(
    `/inspections/${inspectionId}?error=${encodeURIComponent(fmtErrorKey(msg))}${maybeErrorItemsParam(msg)}`,
  );
}
