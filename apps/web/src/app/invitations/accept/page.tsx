import { redirect } from 'next/navigation';
import { apiGet } from '../../../lib/api';
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
  searchParams: { t?: string; error?: string };
}

/**
 * Server-rendered invitation acceptance page. Handles the four states
 * the core-api returns from GET /invitations/accept:
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
 */
export default async function InvitationAcceptPage({
  searchParams,
}: AcceptPageProps): Promise<JSX.Element> {
  const token = (searchParams.t ?? '').trim();
  if (!token) {
    return (
      <div className="panorama-login">
        <h1>Invitation token missing</h1>
        <p className="muted">
          The invitation link is incomplete. Ask your admin to resend the invitation.
        </p>
      </div>
    );
  }

  const preview = await apiGet<AcceptancePreview>(
    `/invitations/accept?t=${encodeURIComponent(token)}`,
  );
  if (!preview.ok) {
    return (
      <div className="panorama-login">
        <h1>Invitation could not be verified</h1>
        <p className="muted">Panorama couldn't reach the invitation service. Please retry.</p>
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
        <h1>{labelForInvalid(data.reason)}</h1>
        <p className="muted">
          {data.reason === 'expired' || data.reason === 'not_found'
            ? 'Ask your admin for a new invitation.'
            : data.reason === 'revoked'
              ? 'This invitation was revoked by an admin.'
              : 'This invitation has already been accepted — try signing in instead.'}
        </p>
        <p className="panorama-login-link">
          <a href="/login">Go to sign in</a>
        </p>
      </div>
    );
  }

  if (data.state === 'email_mismatch') {
    return (
      <div className="panorama-login">
        <h1>Wrong account for this invitation</h1>
        <p className="muted">
          This invitation is for <strong>{data.invitationEmail}</strong>. You're signed in
          as <strong>{data.sessionEmail}</strong>. Log out and try again with the invited
          email — Panorama never auto-accepts an invitation for a different address.
        </p>
        <form action="/api/auth/logout" method="post">
          <button type="submit" className="panorama-button" style={{ width: '100%' }}>
            Log out
          </button>
        </form>
      </div>
    );
  }

  // state === 'ready'
  return (
    <div className="panorama-login">
      <h1>Join {data.tenantDisplayName}</h1>
      <p className="muted">
        {data.inviterDisplayName} invited <strong>{data.email}</strong> to join{' '}
        {data.tenantDisplayName} as <strong>{roleLabel(data.role)}</strong>.
      </p>
      <div className="panorama-card">
        {searchParams.error ? (
          <p className="panorama-error">{labelForFinalizeError(searchParams.error)}</p>
        ) : null}
        <form action={finalizeAcceptAction}>
          <input type="hidden" name="token" value={token} />
          <button type="submit" className="panorama-button" style={{ width: '100%' }}>
            Accept invitation
          </button>
        </form>
      </div>
    </div>
  );
}

function labelForInvalid(reason: 'not_found' | 'expired' | 'revoked' | 'already_accepted'): string {
  switch (reason) {
    case 'expired':
      return 'Invitation expired';
    case 'revoked':
      return 'Invitation revoked';
    case 'already_accepted':
      return 'Invitation already used';
    case 'not_found':
      return 'Invitation not found';
  }
}

function labelForFinalizeError(error: string): string {
  switch (error) {
    case 'email_mismatch':
      return 'The invitation email does not match your session.';
    case 'invalid':
      return 'This invitation is no longer valid.';
    default:
      return 'Could not accept the invitation. Please try again.';
  }
}

function roleLabel(role: string): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'fleet_admin':
      return 'Fleet administrator';
    case 'fleet_staff':
      return 'Fleet staff';
    case 'driver':
      return 'Driver';
    default:
      return role;
  }
}
