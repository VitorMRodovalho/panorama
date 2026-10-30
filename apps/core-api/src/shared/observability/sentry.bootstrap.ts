import * as Sentry from '@sentry/node';

/**
 * Sentry opt-in per ADR-0018 §2.
 *
 * Default: SENTRY_DSN unset → Sentry is a no-op. Self-host operators
 * who opt in set their OWN project DSN; their data never reaches the
 * maintainer's or Anthropic's Sentry project (AGPL right per ADR-0002).
 *
 * Hardening (the AGPL-procurement contract):
 * - `defaultIntegrations: false` — @sentry/node's default set
 *   includes `requestDataIntegration` (sends headers + cookies +
 *   body), `httpIntegration` (instruments inbound HTTP with body
 *   capture), `localVariablesIntegration` (captures local vars at
 *   throw site, which can include passwords/tokens in scope), and
 *   `consoleIntegration`. Passing `integrations: []` alone does
 *   NOT disable defaults — only `defaultIntegrations: false` does.
 *   Pinned by test/sentry-bootstrap.test.ts (effect, not literal).
 *   This is the BLOCKER caught by the per-PR security review
 *   (2026-05-17). Without it, self-hosting.md's "never headers,
 *   cookies, or request bodies" promise is a lie.
 * - Tracing off: no `tracesSampleRate` / `tracesSampler` and
 *   `enableOpenTelemetrySetup: false` — we don't ship traces (alt A
 *   in ADR-0018). SDK 11 replaced `skipOpenTelemetrySetup: true` with
 *   `enableOpenTelemetrySetup: false` (its default for @sentry/node,
 *   kept explicit) and emits HTTP spans whenever tracing is enabled,
 *   so the v10 `tracesSampleRate: 0` is dropped per the v10 -> v11
 *   migration guide ("Turning Sentry tracing off").
 * - `dataCollection` with every category off — SDK 11 removed
 *   `sendDefaultPii` and made an UNSET `dataCollection` permissive
 *   (user info, cookies, headers, bodies, query params, DB/queue
 *   payloads, stack-frame variables all collected by default). Each
 *   category is disabled explicitly; belt-and-suspenders with the
 *   integration list. The AllExceptionsFilter sets only
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
    environment: process.env['NODE_ENV'] ?? 'production',
    defaultIntegrations: false,
    integrations: [],
    enableOpenTelemetrySetup: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
  };
  const release = process.env['SENTRY_RELEASE'];
  if (release) options.release = release;

  Sentry.init(options);

  return true;
}
