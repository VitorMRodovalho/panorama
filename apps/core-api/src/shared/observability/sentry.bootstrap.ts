import * as Sentry from '@sentry/node';

/**
 * Sentry opt-in per ADR-0018 §2.
 *
 * Default: SENTRY_DSN unset → Sentry is a no-op. Self-host operators
 * who opt in set their OWN project DSN; their data never reaches the
 * maintainer's or Anthropic's Sentry project (AGPL right per ADR-0002).
 *
 * Hardening (the AGPL-procurement contract):
 * - `defaultIntegrations: false` — @sentry/node v9's default set
 *   includes `requestDataIntegration` (sends headers + cookies +
 *   body), `httpIntegration` (instruments inbound HTTP with body
 *   capture), `localVariablesIntegration` (captures local vars at
 *   throw site, which can include passwords/tokens in scope), and
 *   `consoleIntegration`. Passing `integrations: []` alone does
 *   NOT disable defaults — only `defaultIntegrations: false` does.
 *   This is the BLOCKER caught by the per-PR security review
 *   (2026-05-17). Without it, self-hosting.md's "never headers,
 *   cookies, or request bodies" promise is a lie.
 * - `skipOpenTelemetrySetup: true` — we don't ship traces (alt A in
 *   ADR-0018). Without this, the SDK installs OTel HTTP
 *   instrumentation even when tracesSampleRate is 0.
 * - `sendDefaultPii: false` — belt-and-suspenders with the
 *   integration list; the AllExceptionsFilter sets only
 *   `setUser({ id: userId })` and tag `tenantId`/`requestId`.
 * - `debug: false` — the SDK never prints config / DSN to stdout
 *   on boot. main.ts logs only `{ sentryEnabled: boolean }`.
 *
 * What we DO enable: nothing today. The empty `integrations` array
 * means error events carry only what AllExceptionsFilter explicitly
 * attaches via `withScope`. A future amendment can opt into
 * `linkedErrorsIntegration` (Error.cause chains) when the trade-off
 * is documented.
 */
export function initSentryIfConfigured(): boolean {
  const dsn = process.env['SENTRY_DSN'];
  if (!dsn) return false;

  const options: Sentry.NodeOptions = {
    dsn,
    debug: false,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    environment: process.env['NODE_ENV'] ?? 'production',
    defaultIntegrations: false,
    integrations: [],
    skipOpenTelemetrySetup: true,
  };
  const release = process.env['SENTRY_RELEASE'];
  if (release) options.release = release;

  Sentry.init(options);

  return true;
}
