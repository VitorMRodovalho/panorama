import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { loadMessages, resolveRequestLocale } from '@/lib/i18n';
import { loginAction, discoveryAction } from './actions';
import type { DiscoveryResult } from './actions';

interface LoginPageProps {
  // Next 15 — searchParams is a Promise that resolves at use time.
  searchParams: Promise<{ next?: string; email?: string; error?: string; invite_token?: string }>;
}

/**
 * Server-rendered login page. Runs a best-effort discovery lookup on the
 * email in the URL so the provider buttons appear in the right order.
 * Password + OIDC (Google/Microsoft) are all offered — unwired providers
 * simply 400 at /auth/oidc/:provider/start which the UI handles.
 *
 * #44 UX-02: locale resolved via cookie → Accept-Language → en before
 * the session exists.
 */
export default async function LoginPage({ searchParams }: LoginPageProps): Promise<ReactNode> {
  const sp = await searchParams;
  // If already logged in, skip the login form.
  const jar = await cookies();
  const existing = jar.get('panorama_session');
  if (existing) redirect(sp.next ?? '/assets');

  const locale = await resolveRequestLocale();
  const messages = loadMessages(locale);

  const email = (sp.email ?? '').trim();
  const discovery: DiscoveryResult = email
    ? await discoveryAction(email)
    : { providers: ['password'], tenantHint: null };

  const inviteToken = (sp.invite_token ?? '').trim();
  // Default post-login destination: the invite-accept page if we're in
  // the middle of an invitation flow, otherwise the explicit ?next, else
  // /assets. Safe: the accept page itself re-validates the token.
  const nextParam =
    sp.next ??
    (inviteToken ? `/invitations/accept?t=${encodeURIComponent(inviteToken)}` : '');

  const subtitle = inviteToken
    ? messages.t('login.subtitle.invitation')
    : discovery.tenantHint
      ? messages.t('login.subtitle.tenant_hint', {
          tenantName: discovery.tenantHint.displayName,
        })
      : messages.t('login.subtitle.default');

  return (
    <div className="panorama-login">
      <h1>{messages.t('login.title')}</h1>
      <p className="muted">{subtitle}</p>

      <div className="panorama-card">
        {sp.error ? (
          <p className="panorama-error">
            {sp.error === 'invalid_credentials'
              ? messages.t('login.error.invalid_credentials')
              : messages.t('login.error.generic')}
          </p>
        ) : null}

        <form action={loginAction}>
          <input type="hidden" name="next" value={nextParam} />
          <div className="panorama-field">
            <label htmlFor="email">{messages.t('login.field.email')}</label>
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
            <label htmlFor="password">{messages.t('login.field.password')}</label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
          </div>
          <button type="submit" className="panorama-button" style={{ width: '100%' }}>
            {messages.t('login.action.sign_in')}
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
                {messages.t('login.provider.google')}
              </a>
            ) : null}
            {discovery.providers.includes('microsoft') ? (
              <a
                className="panorama-provider-btn"
                href={`/api/auth/oidc/microsoft/start${nextParam ? `?redirect=${encodeURIComponent(nextParam)}` : ''}`}
              >
                {messages.t('login.provider.microsoft')}
              </a>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
