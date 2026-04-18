import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { loginAction, discoveryAction } from './actions';
import type { DiscoveryResult } from './actions';

interface LoginPageProps {
  searchParams: { next?: string; email?: string; error?: string; invite_token?: string };
}

/**
 * Server-rendered login page. Runs a best-effort discovery lookup on the
 * email in the URL so the provider buttons appear in the right order.
 * Password + OIDC (Google/Microsoft) are all offered — unwired providers
 * simply 400 at /auth/oidc/:provider/start which the UI handles.
 */
export default async function LoginPage({ searchParams }: LoginPageProps): Promise<JSX.Element> {
  // If already logged in, skip the login form.
  const existing = cookies().get('panorama_session');
  if (existing) redirect(searchParams.next ?? '/assets');

  const email = (searchParams.email ?? '').trim();
  const discovery: DiscoveryResult = email
    ? await discoveryAction(email)
    : { providers: ['password'], tenantHint: null };

  const inviteToken = (searchParams.invite_token ?? '').trim();
  // Default post-login destination: the invite-accept page if we're in
  // the middle of an invitation flow, otherwise the explicit ?next, else
  // /assets. Safe: the accept page itself re-validates the token.
  const nextParam =
    searchParams.next ??
    (inviteToken ? `/invitations/accept?t=${encodeURIComponent(inviteToken)}` : '');

  return (
    <div className="panorama-login">
      <h1>Sign in to Panorama</h1>
      <p className="muted">
        {inviteToken
          ? 'Sign in to accept your invitation.'
          : discovery.tenantHint
            ? `You'll sign in to ${discovery.tenantHint.displayName}.`
            : 'Trilingual fleet + IT asset management.'}
      </p>

      <div className="panorama-card">
        {searchParams.error ? (
          <p className="panorama-error">
            {searchParams.error === 'invalid_credentials'
              ? 'Email or password is incorrect.'
              : 'Sign-in failed. Please try again.'}
          </p>
        ) : null}

        <form action={loginAction}>
          <input type="hidden" name="next" value={nextParam} />
          <div className="panorama-field">
            <label htmlFor="email">Work email</label>
            <input
              id="email"
              name="email"
              type="email"
              defaultValue={email}
              required
              autoComplete="username"
              autoFocus
            />
          </div>
          <div className="panorama-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
          </div>
          <button type="submit" className="panorama-button" style={{ width: '100%' }}>
            Sign in
          </button>
        </form>

        {discovery.providers.filter((p) => p !== 'password').length > 0 ? (
          <>
            <hr style={{ margin: '20px 0', borderColor: 'var(--pan-border)' }} />
            {discovery.providers.includes('google') ? (
              <a
                className="panorama-provider-btn"
                href={`/api/auth/oidc/google/start${nextParam ? `?redirect=${encodeURIComponent(nextParam)}` : ''}`}
              >
                Continue with Google
              </a>
            ) : null}
            {discovery.providers.includes('microsoft') ? (
              <a
                className="panorama-provider-btn"
                href={`/api/auth/oidc/microsoft/start${nextParam ? `?redirect=${encodeURIComponent(nextParam)}` : ''}`}
              >
                Continue with Microsoft
              </a>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
