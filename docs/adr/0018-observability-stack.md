# ADR-0018: Observability stack (pino + Sentry + request-id ALS)

- Status: Accepted (2026-05-16). Drafted from the Wave 0 6-agent scan
  on the same date; accepted by maintainer in the same session.
- Date: 2026-05-16
- Deciders: Vitor Rodovalho (maintainer)
- Reviewers (Wave 0 scan, 2026-05-16):
  - tech-lead → BLOCK on coding any observability without an ADR
    (B2 in the scan); items 1–4 below are the verbatim contract that
    closes the block
  - security-reviewer → no objection (Sentry opt-in via env preserves
    self-host operator's ability to run Community without telemetry)
  - data-architect → no objection (no schema impact; no new tables)
- Related: [ADR-0011 Notification event bus](./0011-notification-event-bus.md)
  (existing AsyncLocalStorage pattern via `tenant.context.ts`),
  [ADR-0014 Public hosted instance](./0014-public-hosted-instance.md)
  (the surface this ADR makes operable)

## Context

`apps/core-api/src/main.ts` uses default Nest `Logger` — line-formatted
strings to stdout. There is no Sentry integration, no OpenTelemetry,
no request-id propagation, no tenant tagging in log output. The first
production incident on the hosted instance (per ADR-0014) would be
reconstructed from `fly logs | grep` archaeology — i.e., would not be
reconstructed.

Wave 0's tech-lead scan (2026-05-16) blocked on writing any
observability code without an ADR because the choice creates a
cross-cutting contract every domain module will eventually depend on
(audit, queue workers, error filters). The "code-ahead-of-ADR =
ADR-becomes-documentation-theatre" risk is real here: ~40 `new
Logger(...)` call sites exist; if pino doesn't sit behind Nest's
`LoggerService` interface, every one of them is a refactor surface.

## Decision

Panorama ships a minimal observability stack in Wave 0:

### 1. Logger contract: pino behind Nest LoggerService

Replace the default Nest `Logger` with a pino-backed implementation
that **preserves the `LoggerService` interface**. All existing
`new Logger('Foo').log(...)` call sites continue to work without
modification; the wire format flips from line-formatted strings to
JSON.

- Output: JSON to stdout. Aggregation is Fly's responsibility
  (Logtail, Datadog, or whatever the operator wires); this app does
  not run a transport.
- Log levels: pino defaults (`fatal | error | warn | info | debug |
  trace`); map Nest's `log()` to `info`.
- Self-host operators can override `LOG_FORMAT=pretty` in
  `apps/core-api/.env*` to get human-readable output for local
  development (pino-pretty as devDependency only, not bundled in
  production image).

### 2. Sentry opt-in via SENTRY_DSN env

Sentry initialization is gated on `process.env.SENTRY_DSN`:

```ts
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, /* … */ });
}
```

When `SENTRY_DSN` is unset (default for Community self-host), Sentry
is a no-op. The `@sentry/node` package (BSD-3) is a runtime
dependency, but the operator's data is never sent to Anthropic's or
the maintainer's Sentry project unless they explicitly opt in by
setting their own DSN. This preserves the AGPL self-host operator's
right to run Community without telemetry — a non-negotiable per
ADR-0002.

`.env.example` documents `SENTRY_DSN` as commented-out + linked to
the Sentry "create a free project" docs.

### 3. Request-id middleware before SessionMiddleware

Inbound `x-request-id` header is honored if present **and matches the
charset `/^[A-Za-z0-9_-]{1,128}$/`**; otherwise a nanoid is generated
(same alphabet). Invalid values (CRLF, path traversal, oversize) are
silently replaced rather than rejected — keeps the downstream
behaviour stable while denying a log-injection / Sentry-tag spoofing
surface. The middleware is registered FIRST in the middleware order
(before `CsrfOriginMiddleware` and `SessionMiddleware`), so the
request-id is available when those middlewares run and when
`SessionMiddleware`'s nested `runInContext` call inherits the
request-id via spread of the outer context.

Concretely: a new `RequestContextMiddleware` lives in
`apps/core-api/src/shared/observability/request-context.middleware.ts`
and is wired in `apps/core-api/src/app.module.ts` `configure()` (NOT
`auth.module.ts`). Wiring at the root keeps cross-cutting concerns
out of `AuthModule`'s responsibility — a future contributor
reorganizing auth cannot silently break the ordering invariant.
The request-id is attached to the response as `x-request-id`, and
the global `AllExceptionsFilter` adds it as `ref` to every JSON
error body so end users with no log-aggregator access can paste the
value to support.

> Amendment 2026-05-17 (Round 5 PR2 implementation): an earlier
> draft of this ADR said the middleware was wired in
> `auth.module.ts`. Pre-implementation review (tech-lead) blocked on
> the cross-cutting-concern argument; the wiring moved to
> `app.module.ts`. The pre-Csrf placement (vs between Csrf and
> Session) was decided in the same review — every response
> including CSRF rejections must carry `x-request-id` so support
> can correlate. The inbound-header validation regex was added per
> security-reviewer pre-implementation scan.

### 4. Extend TenantContext ALS — do NOT fork

The existing `tenant.context.ts` (`AsyncLocalStorage<TenantContext>` in
`apps/core-api/src/modules/tenant/tenant.context.ts`) is the
authoritative request-scoped context. The observability layer
**extends** this store rather than creating a parallel
`RequestContextStorage`:

```ts
// tenant.context.ts (extended shape)
type TenantContext = {
  tenantId: string | null;
  userId: string | null;
  requestId: string;        // NEW: written by RequestContextMiddleware
  // … existing fields
};
```

The pino logger is configured with a `mixin` function that reads from
this ALS on every log call:

```ts
const logger = pino({
  mixin: () => {
    const ctx = TenantContext.getStore();
    return {
      requestId: ctx?.requestId,
      tenantId: ctx?.tenantId,
      userId: ctx?.userId,
    };
  },
});
```

Two ALS instances racing on the same boundary is fragile and a 3am-
page footgun. Extending TenantContext keeps the shared store as a
single source of truth.

## Alternatives considered

### A) Full OpenTelemetry on day one

Rejected. OTel collector + traces + metrics + logs is a multi-day
integration with its own learning curve, vendor decisions
(Honeycomb vs Tempo vs Jaeger vs SigNoz), and operational complexity.
Pino + Sentry + request-id propagation gives 80% of the
incident-reconstruction value at 20% of the cost. OTel becomes a
later ADR if Wave 0 metrics show the gap.

### B) Separate `RequestContextStorage` ALS

Rejected per §4 above. Two ALS instances racing on the same boundary
introduces synchronization bugs that don't surface under test load
but bite in production.

### C) Replace all `new Logger(...)` call sites with a custom `PanoramaLogger`

Rejected. ~40 call sites; the refactor surface is large, the
behavioral diff is zero (pino-behind-LoggerService is identical at
the call site), and the "while I'm here" creep risk is high. Keep
the Nest LoggerService contract intact.

### D) Don't ship Sentry, only structured logs

Rejected. Structured logs are sufficient for post-mortem
reconstruction but not for proactive alerting. Sentry's
issue-grouping + per-release tracking + breadcrumb context is
load-bearing for "we noticed the error before the user reported it"
— which IS the trust contract of a hosted preview where the user
has no SLA to fall back on.

## Consequences

### Positive

- Incidents on the hosted instance can be reconstructed from
  structured logs (with tenant + request correlation) instead of
  `fly logs | grep`.
- Sentry surfaces unhandled errors proactively; the maintainer learns
  about issues before the user reports them.
- Self-host operators retain full control: `SENTRY_DSN` unset = no
  telemetry; `LOG_FORMAT=pretty` = local-friendly output.
- The shared TenantContext ALS keeps audit, error-filter, and logging
  consistent — one source of truth for "what tenant/user/request is
  this happening in."

### Negative

- pino + @sentry/node + nanoid are net-new runtime dependencies.
  Bundle size grows ~400 KB; acceptable.
- The `RequestContextMiddleware` MUST be registered before
  `SessionMiddleware`; future module reorganization can break this
  invariant. Documented in middleware-order comment + asserted by an
  e2e smoke test.
- Sentry's free tier (5K events/month) is enough for a public preview
  but caps quickly at scale. Future ADR amendment if event volume
  forces a paid tier.

### Neutral / locked-in

- All future modules that need request-scoped context use the existing
  TenantContext ALS — no new ALS instances unless an ADR amendment
  argues for it.
- The pino-behind-LoggerService pattern means future logger swaps
  (e.g., to Bunyan or to OTel logs) only touch the adapter, not the
  call sites.

## Implementation notes

Sequencing within Wave 0:

1. Add deps (`pino`, `@sentry/node`, `nanoid`) + dev dep
   `pino-pretty`
2. Implement `RequestContextMiddleware` + extend `TenantContext`
   shape (one PR; passes existing tests; adds a smoke test for
   middleware order)
3. Wire pino as the Nest `LoggerService`, replacing the default
   Logger init in `main.ts` (one PR; verify all existing log call
   sites still emit)
4. Wire Sentry init in `main.ts` (gated on `SENTRY_DSN`); add the
   default error filter that captures uncaught exceptions
5. Document `LOG_FORMAT` + `SENTRY_DSN` in `.env.example` +
   `docs/en/self-hosting.md`

Per the v2 6-agent scan that gates the URL flip, this ADR's
implementation is part of the Round 5 cluster (CI + observability +
secret rotation). It does NOT block Round 1 (homepage rewrite +
quick wins) or Round 2 (throttler + audit chain) from shipping
first.
