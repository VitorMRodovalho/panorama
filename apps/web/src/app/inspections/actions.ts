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

/**
 * Maps backend error codes to user-facing copy. Missing keys fall
 * back to the raw message so a regression is visible on screen.
 * Mirrors the pattern in reservations/actions.ts.
 */
function fmtError(raw: string): string {
  const e = raw.toLowerCase();
  if (e.includes('asset_not_found')) return 'Asset not found in your tenant.';
  if (e.includes('reservation_not_found')) return 'Reservation not found.';
  if (e.includes('reservation_asset_mismatch')) return 'Reservation belongs to a different asset.';
  if (e.includes('no_template_for_asset')) return 'No inspection template exists for this asset category. Ask an admin to create one.';
  if (e.includes('template_not_found')) return 'Template not found.';
  if (e.includes('template_archived')) return 'This template is archived. Pick another or unarchive it.';
  if (e.includes('inspection_not_found')) return 'Inspection not found.';
  if (e.includes('inspection_not_in_progress')) return 'This inspection has already been completed or cancelled.';
  if (e.includes('inspection_already_reviewed')) return 'This inspection was already reviewed.';
  if (e.includes('inspection_already_completed')) return 'Cannot cancel a completed inspection — review it instead.';
  if (e.includes('inspection_not_completed')) return 'Inspection must be completed before review.';
  if (e.includes('not_inspection_starter')) return 'Only the driver who started this inspection (or an admin) can edit it.';
  if (e.startsWith('required_items_missing:')) {
    const tail = raw.split(':').slice(1).join(':');
    return `Some required items are missing answers: ${tail.split('|').join(', ')}.`;
  }
  if (e.startsWith('snapshot_item_id_not_in_snapshot')) return "Internal error — item id doesn't match the inspection's snapshot.";
  if (e.startsWith('response_missing_booleanvalue')) return 'A yes/no item is missing an answer.';
  if (e.startsWith('response_missing_numbervalue')) return 'A number item is missing a value.';
  if (e.startsWith('response_missing_textvalue')) return 'A required text item is missing a value.';
  if (e.startsWith('response_below_min')) return 'A number value is below the allowed minimum.';
  if (e.startsWith('response_above_max')) return 'A number value is above the allowed maximum.';
  if (e.includes('admin_role_required')) return 'Admin role required for this action.';
  return raw;
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
    redirect('/inspections/new?error=' + encodeURIComponent('Pick an asset.'));
  }

  const res = await fetch(`${CORE_API}/inspections`, {
    method: 'POST',
    headers: { cookie: cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ assetId, ...(reservationId ? { reservationId } : {}) }),
  });

  if (res.status === 201) {
    const body = (await res.json()) as { id: string; resumed: boolean };
    redirect(`/inspections/${body.id}${body.resumed ? '?resumed=1' : ''}`);
  }
  const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
  redirect(`/inspections/new?error=${encodeURIComponent(fmtError(body.message ?? 'error'))}`);
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
    redirect(`/inspections/${inspectionId}?error=${encodeURIComponent('Internal error: missing item id.')}`);
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
    headers: { cookie: cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ responses: [payload] }),
  });

  if (res.status === 200) {
    redirect(`/inspections/${inspectionId}?saved=${encodeURIComponent(snapshotItemId)}`);
  }
  const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
  redirect(`/inspections/${inspectionId}?error=${encodeURIComponent(fmtError(body.message ?? 'error'))}`);
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
    redirect(`/inspections/${inspectionId}?error=missing_outcome`);
  }

  const res = await fetch(`${CORE_API}/inspections/${inspectionId}/complete`, {
    method: 'POST',
    headers: { cookie: cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ outcome, ...(summaryNote ? { summaryNote } : {}) }),
  });

  if (res.status === 200) {
    redirect(`/inspections?completed=${inspectionId}`);
  }
  const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
  redirect(`/inspections/${inspectionId}?error=${encodeURIComponent(fmtError(body.message ?? 'error'))}`);
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
    headers: { cookie: cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(reason ? { reason } : {}),
  });

  if (res.status === 200) {
    redirect(`/inspections?cancelled=${inspectionId}`);
  }
  const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
  redirect(`/inspections/${inspectionId}?error=${encodeURIComponent(fmtError(body.message ?? 'error'))}`);
}

// ---------------------------------------------------------------------
// uploadPhoto — multipart POST to /inspections/:id/photos.
//
// `clientUploadKey` is generated server-side (per-render) by the
// detail page and forwarded as a hidden field. Refreshing the page
// regenerates the key, so the backend treats a refresh-then-resubmit
// as a new upload — that's intentional for the 0.3 web flow
// (mobile-first idempotency comes in 1.1 with direct-to-S3 uploads,
// ADR-0012 §Future-facing commitments).
//
// Note: cannot set `content-type` ourselves — fetch needs to set the
// multipart boundary string. Just forward the cookie + the FormData.
// ---------------------------------------------------------------------

export async function uploadPhotoAction(formData: FormData): Promise<void> {
  const inspectionId = String(formData.get('inspectionId') ?? '').trim();
  const clientUploadKey = String(formData.get('clientUploadKey') ?? '').trim();
  const responseId = String(formData.get('responseId') ?? '').trim() || undefined;
  const file = formData.get('photo');
  if (!inspectionId || !clientUploadKey || !(file instanceof File) || file.size === 0) {
    redirect(`/inspections/${inspectionId}?error=${encodeURIComponent('Pick a photo first.')}`);
  }
  if (file.size > 10 * 1024 * 1024) {
    redirect(`/inspections/${inspectionId}?error=${encodeURIComponent('Photo too large (max 10 MB).')}`);
  }

  // Forward to the API as multipart. Don't set content-type — let
  // fetch derive the multipart boundary from the FormData body.
  const apiForm = new FormData();
  apiForm.append('photo', file as File);
  apiForm.append('clientUploadKey', clientUploadKey);
  if (responseId) apiForm.append('responseId', responseId);

  const res = await fetch(`${CORE_API}/inspections/${inspectionId}/photos`, {
    method: 'POST',
    headers: { cookie: cookieHeader() },
    cache: 'no-store',
    body: apiForm,
  });

  if (res.status === 201) {
    redirect(`/inspections/${inspectionId}?photo=ok`);
  }
  const body = (await res.json().catch(() => ({ message: 'photo_upload_failed' }))) as {
    message?: string;
    retryAfterSeconds?: number;
  };
  let msg = String(body.message ?? 'photo_upload_failed').toLowerCase();
  let pretty = body.message ?? 'photo_upload_failed';
  if (msg.includes('rate_limited')) {
    pretty = `Upload rate-limited. Try again in ${body.retryAfterSeconds ?? '?'}s.`;
  } else if (msg.includes('photo_too_large_pixels')) {
    pretty = 'Photo dimensions exceed the safe limit.';
  } else if (msg.includes('unsupported_media_type')) {
    pretty = 'File type not supported. Use JPEG / PNG / WebP / HEIC.';
  } else if (msg.includes('photo_processing_failed')) {
    pretty = 'Could not process the photo. Try a different file.';
  } else if (msg.includes('inspection_photo_cap_reached')) {
    pretty = 'This inspection has reached its photo limit.';
  } else if (msg.includes('upload_key_collision')) {
    pretty = 'Upload key collision (rare). Refresh the page and try again.';
  } else if (msg.includes('photo_too_large')) {
    pretty = 'Photo too large (max 10 MB).';
  }
  redirect(`/inspections/${inspectionId}?error=${encodeURIComponent(pretty)}`);
}

// ---------------------------------------------------------------------
// review — admin closes out a completed FAIL / NEEDS_MAINTENANCE.
// ---------------------------------------------------------------------

export async function reviewInspectionAction(formData: FormData): Promise<void> {
  const inspectionId = String(formData.get('inspectionId') ?? '').trim();
  const reviewNote = String(formData.get('reviewNote') ?? '').trim() || undefined;
  if (!inspectionId) redirect('/inspections');

  const res = await fetch(`${CORE_API}/inspections/${inspectionId}/review`, {
    method: 'POST',
    headers: { cookie: cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(reviewNote ? { reviewNote } : {}),
  });

  if (res.status === 200) {
    redirect(`/inspections/${inspectionId}?reviewed=1`);
  }
  const body = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
  redirect(`/inspections/${inspectionId}?error=${encodeURIComponent(fmtError(body.message ?? 'error'))}`);
}
