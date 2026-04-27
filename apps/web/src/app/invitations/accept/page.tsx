import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { loadMessages, resolveRequestLocale } from '@/lib/i18n';
import { finalizeAcceptAction } from './actions';

type AcceptancePreview =
  | {
      state: 'ready';
      invitationId: string;
      tenantId: string;
      tenantDisplayName: string;
      email: string;
      role: string;
      inviterDisplayName: string;
      expiresAt: string;
    }
  | { state: 'needs_login'; email: string; tenantDisplayName: string; inviterDisplayName: string }
  | {
      state: 'email_mismatch';
      invitationEmail: string;
      sessionEmail: string;
      tenantDisplayName: string;
    }
  | { state: 'invalid'; reason: 'not_found' | 'expired' | 'revoked' | 'already_accepted' };

interface AcceptPageProps {
  searchParams: Promise<{ t?: string; error?: string }>;
}

/**
 * Server-rendered invitation acceptance page (#44 UX-03 — locale-aware).
 * Handles the four states the core-api returns from
 * GET /invitations/accept:
 *
 *   ready           → render a confirm button that POSTs the token
 *   needs_login     → redirect to /login?invite_token=... with the email
 *                     prefilled
 *   email_mismatch  → render "log out and retry" — NEVER auto-accept
 *   invalid         → render "request a new invitation" with the reason
 *
 * The state machine lives on the server; the browser only sees the
 * rendered HTML + a single form POST for the ready → accepted
 * transition.
 *
 * Locale resolves from cookie → Accept-Language since the user may not
 * be signed in yet (the `needs_login` branch redirects them through
 * /login first).
 */
export default async function InvitationAcceptPage({
  searchParams,
}: AcceptPageProps): Promise<ReactNode> {
  const sp = await searchParams;
  const locale = await resolveRequestLocale();
  const messages = loadMessages(locale);

  const token = (sp.t ?? '').trim();
  if (!token) {
    return (
      <div className="panorama-login">
        <h1>{messages.t('invitation.accept.token_missing.title')}</h1>
        <p className="muted">{messages.t('invitation.accept.token_missing.body')}</p>
      </div>
    );
  }

  const preview = await apiGet<AcceptancePreview>(
    `/invitations/accept?t=${encodeURIComponent(token)}`,
  );
  if (!preview.ok) {
    return (
      <div className="panorama-login">
        <h1>{messages.t('invitation.accept.unverified.title')}</h1>
        <p className="muted">{messages.t('invitation.accept.unverified.body')}</p>
      </div>
    );
  }

  const data = preview.data;
  if (data.state === 'needs_login') {
    const nextPath = `/invitations/accept?t=${encodeURIComponent(token)}`;
    redirect(
      `/login?invite_token=${encodeURIComponent(token)}&email=${encodeURIComponent(data.email)}&next=${encodeURIComponent(nextPath)}`,
    );
  }

  if (data.state === 'invalid') {
    return (
      <div className="panorama-login">
        <h1>{messages.t(`invitation.accept.invalid.${data.reason}.title`)}</h1>
        <p className="muted">{messages.t(`invitation.accept.invalid.${data.reason}.body`)}</p>
        <p className="panorama-login-link">
          <a href="/login">{messages.t('invitation.accept.go_to_signin')}</a>
        </p>
      </div>
    );
  }

  if (data.state === 'email_mismatch') {
    return (
      <div className="panorama-login">
        <h1>{messages.t('invitation.accept.email_mismatch.title')}</h1>
        <p className="muted">
          {messages.t('invitation.accept.email_mismatch.body.prefix')}{' '}
          <strong>{data.invitationEmail}</strong>
          {messages.t('invitation.accept.email_mismatch.body.middle')}{' '}
          <strong>{data.sessionEmail}</strong>
          {messages.t('invitation.accept.email_mismatch.body.suffix')}
        </p>
        <form action="/api/auth/logout" method="post">
          <button type="submit" className="panorama-button" style={{ width: '100%' }}>
            {messages.t('invitation.accept.email_mismatch.logout')}
          </button>
        </form>
      </div>
    );
  }

  // state === 'ready'
  const roleLabel = messages.t(`invitation.role.${data.role}`);
  return (
    <div className="panorama-login">
      <h1>
        {messages.t('invitation.accept.ready.title', {
          tenantName: data.tenantDisplayName,
        })}
      </h1>
      <p className="muted">
        {messages.t('invitation.accept.ready.body.prefix', {
          inviter: data.inviterDisplayName,
        })}{' '}
        <strong>{data.email}</strong>{' '}
        {messages.t('invitation.accept.ready.body.middle', {
          tenantName: data.tenantDisplayName,
        })}{' '}
        <strong>{roleLabel}</strong>.
      </p>
      <div className="panorama-card">
        {sp.error ? (
          <p className="panorama-error">
            {messages.t(
              sp.error === 'email_mismatch'
                ? 'invitation.accept.error.email_mismatch'
                : sp.error === 'invalid'
                  ? 'invitation.accept.error.invalid'
                  : 'invitation.accept.error.generic',
            )}
          </p>
        ) : null}
        <form action={finalizeAcceptAction}>
          <input type="hidden" name="token" value={token} />
          <button type="submit" className="panorama-button" style={{ width: '100%' }}>
            {messages.t('invitation.accept.ready.button')}
          </button>
        </form>
      </div>
    </div>
  );
}
