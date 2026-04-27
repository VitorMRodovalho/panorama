import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { loadMessages } from '@/lib/i18n';
import { getCurrentSession } from '@/lib/session';
import {
  resendInvitationAction,
  revokeInvitationAction,
  sendInvitationAction,
} from './actions';

interface InvitationView {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  status: 'open' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  emailSentAt: string | null;
  emailQueuedAt: string | null;
  emailBouncedAt: string | null;
  emailLastError: string | null;
  invitedByUserId: string;
}

interface InvitationListResponse {
  items: InvitationView[];
}

interface InvitationsPageProps {
  searchParams: Promise<{
    status?: string;
    error?: string;
    sent?: string;
    resent?: string;
    revoked?: string;
  }>;
}

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

const STATUS_VALUES = ['open', 'accepted', 'revoked', 'expired', 'all'] as const;
type StatusValue = (typeof STATUS_VALUES)[number];

function isStatusValue(s: string): s is StatusValue {
  return (STATUS_VALUES as readonly string[]).includes(s);
}

// Roles allowed by `InvitationConfigService.allowedRoles` (ADR-0008).
// If the backend bumps this list — e.g. adds a `maintenance_coordinator`
// in 0.4 — update here AND in the service config in the same PR. The
// service-side check is authoritative; this list is just for the UI
// dropdown.
const INVITABLE_ROLES = ['owner', 'fleet_admin', 'fleet_staff', 'driver'] as const;

export default async function InvitationsAdminPage({
  searchParams,
}: InvitationsPageProps): Promise<ReactNode> {
  const sp = await searchParams;
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  if (!ADMIN_ROLES.has(session.currentRole)) {
    redirect(
      '/reservations?error=' + encodeURIComponent('invitation.error.admin_required'),
    );
  }

  const tenantLocale =
    session.memberships.find((m) => m.tenantId === session.currentTenantId)?.tenantLocale ??
    'en';
  const messages = loadMessages(tenantLocale);

  const status: StatusValue = isStatusValue(sp.status ?? '')
    ? (sp.status as StatusValue)
    : 'open';

  const listQuery = new URLSearchParams();
  listQuery.set('tenantId', session.currentTenantId);
  if (status !== 'all') listQuery.set('status', status);
  listQuery.set('limit', '200');

  const listRes = await apiGet<InvitationListResponse>(
    `/invitations?${listQuery.toString()}`,
  );
  const items: InvitationView[] = listRes.ok ? listRes.data.items : [];

  return (
    <>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <h1 style={{ margin: 0 }}>{messages.t('invitation.list.title')}</h1>
      </div>

      {sp.error ? (
        <div className="panorama-banner-warning">{messages.t(sp.error)}</div>
      ) : null}
      {sp.sent ? (
        <div className="panorama-banner-success">
          {messages.t('invitation.banner.sent')}
        </div>
      ) : null}
      {sp.resent ? (
        <div className="panorama-banner-success">
          {messages.t('invitation.banner.resent')}
        </div>
      ) : null}
      {sp.revoked ? (
        <div className="panorama-banner-success">
          {messages.t('invitation.banner.revoked')}
        </div>
      ) : null}

      <div className="panorama-card">
        <h2 style={{ margin: '0 0 12px' }}>
          {messages.t('invitation.send.title')}
        </h2>
        <form action={sendInvitationAction} className="panorama-form-grid">
          <div className="panorama-field">
            <label htmlFor="inv-email">{messages.t('invitation.field.email')}</label>
            <input
              id="inv-email"
              name="email"
              type="email"
              maxLength={254}
              required
              autoComplete="off"
            />
          </div>
          <div className="panorama-field">
            <label htmlFor="inv-role">{messages.t('invitation.field.role')}</label>
            <select id="inv-role" name="role" required defaultValue="driver">
              {INVITABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {messages.t(`invitation.role.${r}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="panorama-field">
            <label htmlFor="inv-ttl">{messages.t('invitation.field.ttl_days')}</label>
            <input
              id="inv-ttl"
              name="ttlDays"
              type="number"
              min={1}
              max={30}
              placeholder={messages.t('invitation.field.ttl_days.placeholder')}
            />
          </div>
          <button
            type="submit"
            className="panorama-button"
            style={{ gridColumn: '1 / -1' }}
          >
            {messages.t('invitation.action.send')}
          </button>
        </form>
        <p
          style={{
            color: 'var(--pan-muted, #94a3b8)',
            fontSize: 13,
            marginTop: 8,
          }}
        >
          {messages.t('invitation.send.help')}
        </p>
      </div>

      <div className="panorama-card" style={{ marginTop: 16 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <h2 style={{ margin: 0 }}>
            {messages.t('invitation.list.title')}{' '}
            <span className="panorama-pill">{items.length}</span>
          </h2>
          <nav style={{ display: 'flex', gap: 10, fontSize: 13 }}>
            {STATUS_VALUES.map((s) => (
              <a
                key={s}
                href={`/admin/invitations?status=${s}`}
                style={{ fontWeight: status === s ? 600 : 400 }}
              >
                {messages.t(`invitation.filter.${s}`)}
              </a>
            ))}
          </nav>
        </div>

        {!listRes.ok ? (
          <p className="panorama-error">
            {messages.t('invitation.list.failed')} (HTTP {listRes.status})
          </p>
        ) : items.length === 0 ? (
          <p className="panorama-empty">{messages.t('invitation.list.empty')}</p>
        ) : (
          <table className="panorama-table">
            <thead>
              <tr>
                <th>{messages.t('invitation.column.email')}</th>
                <th>{messages.t('invitation.column.role')}</th>
                <th>{messages.t('invitation.column.status')}</th>
                <th>{messages.t('invitation.column.expires')}</th>
                <th>{messages.t('invitation.column.email_status')}</th>
                <th>{messages.t('invitation.column.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((inv) => (
                <tr key={inv.id}>
                  <td>{inv.email}</td>
                  <td>{messages.t(`invitation.role.${inv.role}`)}</td>
                  <td>
                    <StatusPill status={inv.status} t={messages.t} />
                  </td>
                  <td>{new Date(inv.expiresAt).toLocaleString()}</td>
                  <td>
                    <EmailStatus inv={inv} t={messages.t} />
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {inv.status === 'open' ? (
                      <>
                        <form
                          action={resendInvitationAction}
                          style={{ display: 'inline' }}
                        >
                          <input type="hidden" name="id" value={inv.id} />
                          <button
                            type="submit"
                            className="panorama-button secondary"
                            style={{ marginRight: 6 }}
                            title={messages.t('invitation.action.resend.help')}
                          >
                            {messages.t('invitation.action.resend')}
                          </button>
                        </form>
                        {/* Forcing function for revoke — required-checkbox
                            confirm panel. Mirrors the maintenance / blackout
                            delete pattern. Revoke flips the row to a terminal
                            state; ops needs to confirm intent. */}
                        <details style={{ display: 'inline-block' }}>
                          <summary
                            className="panorama-button secondary"
                            style={{ cursor: 'pointer' }}
                          >
                            {messages.t('invitation.action.revoke')}
                          </summary>
                          <form
                            action={revokeInvitationAction}
                            className="panorama-inline-form"
                          >
                            <input type="hidden" name="id" value={inv.id} />
                            <p style={{ margin: '0 0 6px', fontSize: 13 }}>
                              {messages.t('invitation.revoke.confirm_title')}
                            </p>
                            <label
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                fontSize: 13,
                                margin: '6px 0',
                              }}
                            >
                              <input type="checkbox" required />
                              {messages.t('invitation.revoke.confirm_checkbox')}
                            </label>
                            <button
                              type="submit"
                              className="panorama-button secondary"
                            >
                              {messages.t('invitation.revoke.confirm_button')}
                            </button>
                          </form>
                        </details>
                      </>
                    ) : (
                      <span style={{ color: 'var(--pan-muted, #94a3b8)' }}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function StatusPill({
  status,
  t,
}: {
  status: 'open' | 'accepted' | 'revoked' | 'expired';
  t: (k: string) => string;
}): ReactNode {
  // Reuses existing color tokens — open = neutral/blue, accepted = green,
  // revoked = neutral, expired = amber. Distinct from the maintenance
  // status palette (red-shaded) so a coordinator scanning between pages
  // can tell at a glance which axis they're on.
  const palette: Record<string, { bg: string; border: string; color: string }> = {
    open: { bg: '#e0eaff', border: '#7a99e0', color: '#1e3a8a' },
    accepted: { bg: '#e1f5e1', border: '#7ac17a', color: '#14532d' },
    revoked: { bg: '#f1f5f9', border: '#94a3b8', color: '#475569' },
    expired: { bg: '#fff4e0', border: '#f0c890', color: '#7a3a00' },
  };
  const p = palette[status] ?? palette['open']!;
  return (
    <span
      className="panorama-pill"
      style={{
        background: p.bg,
        border: `1px solid ${p.border}`,
        color: p.color,
        fontWeight: 600,
      }}
    >
      {t(`invitation.status.${status}`)}
    </span>
  );
}

function EmailStatus({
  inv,
  t,
}: {
  inv: InvitationView;
  t: (k: string) => string;
}): ReactNode {
  if (inv.emailBouncedAt) {
    return (
      <span style={{ color: '#8c2114', fontWeight: 600 }} title={inv.emailLastError ?? undefined}>
        {t('invitation.email.bounced')}
      </span>
    );
  }
  if (inv.emailLastError && !inv.emailSentAt) {
    return (
      <span style={{ color: '#8c2114' }} title={inv.emailLastError}>
        {t('invitation.email.failed')}
      </span>
    );
  }
  if (inv.emailSentAt) {
    return <span>{t('invitation.email.sent')}</span>;
  }
  if (inv.emailQueuedAt) {
    return (
      <span style={{ color: 'var(--pan-muted, #94a3b8)' }}>
        {t('invitation.email.queued')}
      </span>
    );
  }
  return <span style={{ color: 'var(--pan-muted, #94a3b8)' }}>—</span>;
}
