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

function fmtErrorKey(raw: string): string {
  const e = raw.toLowerCase();
  if (e.includes('owner_role_required')) return 'settings.error.owner_required';
  if (e.includes('admin_role_required')) return 'settings.error.admin_required';
  if (e.includes('tenant_not_found')) return 'settings.error.tenant_not_found';
  if (e.includes('invalid_body')) return 'settings.error.invalid_body';
  if (e.includes('nothing_to_update')) return 'settings.error.no_change';
  return 'settings.error.generic';
}

/**
 * Save the tenant settings form.
 *
 * Contract for future maintainers (tech-lead PR5 Q4): every checkbox
 * in the settings form maps 1:1 to a boolean tenant setting and is
 * PATCHed unconditionally with its checked-state (true if present,
 * false if absent). Do NOT add half-checkbox controls or "leave
 * unchanged" toggles — they break the absence-means-false contract
 * and there's no machine-readable way to distinguish "user explicitly
 * unchecked" from "form didn't include this field". When adding a
 * second setting, follow the same pattern OR migrate the form to an
 * explicit per-field tristate (recommended only when there's a
 * real third state to model).
 */
export async function updateTenantSettingsAction(formData: FormData): Promise<void> {
  const tenantId = String(formData.get('tenantId') ?? '').trim();
  if (!tenantId) redirect('/admin/settings?error=settings.error.generic');

  // Checkbox semantics: an HTML form posts a checkbox's value only
  // when checked. Coerce presence to true, absence to false so the
  // form is genuinely "set to whatever the checkbox shows now" rather
  // than "toggle if checked, leave alone otherwise" (which would
  // make turning the toggle OFF impossible via this form).
  const autoOpen = formData.has('autoOpenMaintenanceFromInspection');

  const res = await fetch(`${CORE_API}/tenants/${tenantId}/settings`, {
    method: 'PATCH',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ autoOpenMaintenanceFromInspection: autoOpen }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ message: 'error' }))) as {
      message?: string;
    };
    redirect(
      `/admin/settings?error=${encodeURIComponent(fmtErrorKey(body.message ?? 'error'))}`,
    );
  }
  redirect('/admin/settings?saved=1');
}
