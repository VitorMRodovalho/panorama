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
 * Map a server error message to an i18n KEY. The page receives this via
 * `?error=<key>` and resolves with `messages.t(key)`. Unknown / unmapped
 * codes pass through; the i18n loader falls back to the raw string when
 * a key isn't registered, so a stray server error renders as itself
 * (visible bug, not silent empty).
 */
function fmtErrorKey(raw: string): string {
  const e = raw.toLowerCase();
  if (e.includes('admin_role_required_for_assignee'))
    return 'maintenance.error.admin_required_for_assignee';
  if (e.includes('admin_role_required')) return 'maintenance.error.admin_required';
  if (e.includes('admin_or_assignee_required'))
    return 'maintenance.error.admin_or_assignee_required';
  if (e.includes('asset_not_found')) return 'maintenance.error.asset_not_found';
  if (e.includes('asset_archived')) return 'maintenance.error.asset_archived';
  if (e.includes('asset_retired')) return 'maintenance.error.asset_retired';
  if (e.includes('reservation_not_found')) return 'maintenance.error.reservation_not_found';
  if (e.includes('inspection_not_found')) return 'maintenance.error.inspection_not_found';
  if (e.includes('reservation_asset_mismatch'))
    return 'maintenance.error.reservation_asset_mismatch';
  if (e.includes('not_reservation_owner'))
    return 'maintenance.error.not_reservation_owner';
  if (e.includes('completion_fields_only_on_completed'))
    return 'maintenance.error.completion_fields_only';
  if (e.startsWith('invalid_transition:')) return 'maintenance.error.invalid_transition';
  if (e.includes('title_too_short')) return 'maintenance.error.title_too_short';
  if (e.includes('maintenance_not_found')) return 'maintenance.error.not_found';
  if (e.includes('assignee_not_in_tenant'))
    return 'maintenance.error.assignee_not_in_tenant';
  return raw;
}

interface ApiErrorBody {
  message?: string;
}

export async function openMaintenanceAction(formData: FormData): Promise<void> {
  const assetId = String(formData.get('assetId') ?? '').trim();
  const maintenanceType = String(formData.get('maintenanceType') ?? '').trim();
  const title = String(formData.get('title') ?? '').trim();
  const severity = String(formData.get('severity') ?? '').trim() || undefined;
  const triggeringReservationId =
    String(formData.get('triggeringReservationId') ?? '').trim() || undefined;
  const triggeringInspectionId =
    String(formData.get('triggeringInspectionId') ?? '').trim() || undefined;
  const supplierName = String(formData.get('supplierName') ?? '').trim() || undefined;
  const notes = String(formData.get('notes') ?? '').trim() || undefined;
  const isWarranty = formData.get('isWarranty') === 'on';
  const mileageAtServiceRaw = String(formData.get('mileageAtService') ?? '').trim();
  const costRaw = String(formData.get('cost') ?? '').trim();

  if (!assetId || !maintenanceType || !title) {
    redirect('/maintenance?error=errors.missing_required_fields');
  }

  const payload: Record<string, unknown> = {
    assetId,
    maintenanceType,
    title,
  };
  if (severity) payload['severity'] = severity;
  if (triggeringReservationId) payload['triggeringReservationId'] = triggeringReservationId;
  if (triggeringInspectionId) payload['triggeringInspectionId'] = triggeringInspectionId;
  if (supplierName) payload['supplierName'] = supplierName;
  if (notes) payload['notes'] = notes;
  if (isWarranty) payload['isWarranty'] = true;
  if (mileageAtServiceRaw) {
    const n = Number(mileageAtServiceRaw);
    if (Number.isFinite(n) && n >= 0) payload['mileageAtService'] = Math.trunc(n);
  }
  if (costRaw) {
    const n = Number(costRaw);
    if (Number.isFinite(n) && n >= 0) payload['cost'] = n;
  }

  const res = await fetch(`${CORE_API}/maintenances`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(payload),
  });
  if (res.status === 201) {
    const created = (await res.json()) as { id: string };
    redirect(`/maintenance/${created.id}?opened=1`);
  }
  const body = (await res.json().catch(() => ({ message: 'error' }))) as ApiErrorBody;
  redirect(
    `/maintenance?error=${encodeURIComponent(fmtErrorKey(body.message ?? 'error'))}`,
  );
}

async function transitionStatus(
  id: string,
  payload: Record<string, unknown>,
  redirectQuery: string,
): Promise<void> {
  const res = await fetch(`${CORE_API}/maintenances/${id}/status`, {
    method: 'PATCH',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    redirect(`/maintenance/${id}?${redirectQuery}=1`);
  }
  const body = (await res.json().catch(() => ({ message: 'error' }))) as ApiErrorBody;
  redirect(
    `/maintenance/${id}?error=${encodeURIComponent(fmtErrorKey(body.message ?? 'error'))}`,
  );
}

export async function startWorkAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  if (!id) redirect('/maintenance');
  await transitionStatus(id, { status: 'IN_PROGRESS' }, 'started');
}

export async function completeMaintenanceAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  if (!id) redirect('/maintenance');
  const completionNote = String(formData.get('completionNote') ?? '').trim() || undefined;
  const nextServiceMileageRaw = String(formData.get('nextServiceMileage') ?? '').trim();
  const nextServiceDateRaw = String(formData.get('nextServiceDate') ?? '').trim();
  const costRaw = String(formData.get('cost') ?? '').trim();
  const payload: Record<string, unknown> = { status: 'COMPLETED' };
  if (completionNote) payload['completionNote'] = completionNote;
  if (nextServiceMileageRaw) {
    const n = Number(nextServiceMileageRaw);
    if (Number.isFinite(n) && n >= 0) payload['nextServiceMileage'] = Math.trunc(n);
  }
  if (nextServiceDateRaw) {
    payload['nextServiceDate'] = new Date(nextServiceDateRaw).toISOString();
  }
  if (costRaw) {
    const n = Number(costRaw);
    if (Number.isFinite(n) && n >= 0) payload['cost'] = n;
  }
  await transitionStatus(id, payload, 'completed');
}

export async function cancelMaintenanceAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  if (!id) redirect('/maintenance');
  await transitionStatus(id, { status: 'CANCELLED' }, 'cancelled');
}
