'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/lib/session';

const CORE_API = process.env['CORE_API_URL'] ?? 'http://localhost:4000';

async function cookieHeader(): Promise<string> {
  const jar = await cookies();
  return jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Map raw API error strings to i18n keys (resolved client-side via
 * `messages.t`). Same pattern as the inspection-templates / blackouts
 * actions.
 */
function fmtErrorKey(raw: string): string {
  const e = raw.toLowerCase();
  if (e.includes('admin_role_required')) return 'invitation.error.admin_required';
  if (e.includes('tenant_mismatch')) return 'invitation.error.tenant_mismatch';
  if (e.includes('role_not_allowed')) return 'invitation.error.role_not_allowed';
  if (e.includes('one_open_per_tenant_email')) return 'invitation.error.duplicate_open';
  if (e.includes('rate_limited:admin')) return 'invitation.error.rate_limit_admin';
  if (e.includes('rate_limited:tenant')) return 'invitation.error.rate_limit_tenant';
  if (e.includes('ttl_out_of_bounds')) return 'invitation.error.ttl_out_of_bounds';
  if (e.includes('invitation_not_found')) return 'invitation.error.not_found';
  if (e.includes('invitation_terminal')) return 'invitation.error.terminal';
  if (e.includes('invitation_expired')) return 'invitation.error.expired';
  if (e.includes('invalid_body') || e.includes('invalid_query'))
    return 'invitation.error.invalid_body';
  return 'invitation.error.generic';
}

// ---------------------------------------------------------------
// send
// ---------------------------------------------------------------

export async function sendInvitationAction(formData: FormData): Promise<void> {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  const tenantId = session.currentTenantId;

  const email = String(formData.get('email') ?? '').trim();
  const role = String(formData.get('role') ?? '').trim();
  const ttlDaysRaw = String(formData.get('ttlDays') ?? '').trim();

  if (!email) {
    redirect('/admin/invitations?error=' + encodeURIComponent('invitation.error.email_required'));
  }
  if (!role) {
    redirect('/admin/invitations?error=' + encodeURIComponent('invitation.error.role_required'));
  }

  const body: Record<string, unknown> = {
    tenantId,
    email,
    role,
  };
  if (ttlDaysRaw) {
    const days = Number(ttlDaysRaw);
    if (Number.isFinite(days) && days > 0) {
      // Server contract is in seconds; convert here so the form can
      // ask for the more ops-friendly "days" unit.
      body['ttlSeconds'] = Math.round(days * 24 * 60 * 60);
    }
  }

  const res = await fetch(`${CORE_API}/invitations`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(body),
  });
  if (res.status === 201) {
    redirect('/admin/invitations?sent=1');
  }
  const payload = (await res.json().catch(() => ({ message: 'error' }))) as {
    message?: string;
  };
  redirect(
    '/admin/invitations?error=' + encodeURIComponent(fmtErrorKey(payload.message ?? 'error')),
  );
}

// ---------------------------------------------------------------
// resend
// ---------------------------------------------------------------

export async function resendInvitationAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  if (!id) redirect('/admin/invitations');

  const res = await fetch(`${CORE_API}/invitations/${id}/resend`, {
    method: 'POST',
    headers: { cookie: await cookieHeader() },
    cache: 'no-store',
  });
  if (res.status === 200) {
    redirect('/admin/invitations?resent=1');
  }
  const payload = (await res.json().catch(() => ({ message: 'error' }))) as {
    message?: string;
  };
  redirect(
    '/admin/invitations?error=' + encodeURIComponent(fmtErrorKey(payload.message ?? 'error')),
  );
}

// ---------------------------------------------------------------
// revoke
// ---------------------------------------------------------------

export async function revokeInvitationAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  if (!id) redirect('/admin/invitations');

  const res = await fetch(`${CORE_API}/invitations/${id}/revoke`, {
    method: 'POST',
    headers: { cookie: await cookieHeader() },
    cache: 'no-store',
  });
  if (res.status === 204) {
    redirect('/admin/invitations?revoked=1');
  }
  const payload = (await res.json().catch(() => ({ message: 'error' }))) as {
    message?: string;
  };
  redirect(
    '/admin/invitations?error=' + encodeURIComponent(fmtErrorKey(payload.message ?? 'error')),
  );
}
