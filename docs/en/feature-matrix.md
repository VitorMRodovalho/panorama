# Feature matrix — Community vs Enterprise

**Principle:** everything needed to run a real deployment lives in Community.
Enterprise is strictly **additive** — enterprise-class controls, niche IdPs,
compliance packs, branded support.

| Area | Community (AGPL-3.0) | Enterprise (commercial) |
|------|----------------------|-------------------------|
| **Assets** | Hardware, Licences, Accessories, Consumables, Components, Predefined Kits, bookable Vehicles, custom asset types via plugin SDK | Per-type depreciation rules, bulk-edit asset graph, lot/serial genealogy |
| **Custom fields** | Text, number, date, boolean, listbox, textarea, file; regex validation; per-model fieldsets | Cross-field validation rules, conditional visibility, referenced fields |
| **Reservations** | Advance booking, approval workflow, recurring reservations, blackouts, basket/multi-asset, VIP auto-approval, training-gating | Matrix approvals (n-of-m + tiers), delegated approvals, workflow-as-code |
| **Inspections** | Configurable checklists, photo evidence with server-side EXIF strip, pre/post comparison, signature capture, default 425-day photo retention with 30-day floor (per [ADR-0012](../adr/0012-inspection-photo-pipeline.md)) | Per-tenant photo retention override UI (column ships in Community; only the admin UI is Enterprise), offline-first mobile, voice-to-text notes, on-device OCR of dashboards |
| **Maintenance** | Manual flagging, mileage + time alerts, vendor link, history | Predictive alerts from telematics, Fleetio/Samsara/GeoTab connectors |
| **Multi-tenancy**| Row-level tenancy (Prisma middleware + Postgres RLS), per-company RBAC, **Tenant Owner role** with last-owner protection ([ADR-0007](../adr/0007-tenant-owner-role.md)) | Cross-tenant service-account tokens, tenant-to-tenant asset transfer, data-residency pinning, **verified domain claims** (DNS TXT) |
| **Invitations**| Email-token with TTL, one-time-use, email-match required, revokable, rate-limited, audit trail ([ADR-0008](../adr/0008-invitation-flow.md)) | Bounce webhooks + retry policy, SCIM push replaces invite flow for IdP-managed tenants, custom email templates |
| **Authentication**| Email/password, Google OIDC, Microsoft OIDC, SAML (generic), LDAP, TOTP 2FA, WebAuthn passkeys | Okta advanced, PingFederate, JumpCloud SCIM push, ADFS, FIDO2 AAL-2 attestation |
| **Authorisation**| CASL-based RBAC, per-tenant group→role mapping, custom roles | ABAC / policy-as-code (Rego), time-windowed grants, break-glass audit |
| **API** | REST + OpenAPI 3.1, GraphQL optional, personal access tokens, OAuth2 client credentials, Snipe-IT compat shim | Signed HMAC webhooks at tenant level, customer-managed encryption keys for API tokens |
| **Notifications**| Email, Microsoft Teams, Slack, Google Chat, webhooks (HMAC) | PagerDuty, ServiceNow, per-tenant SMTP relay, dynamic routing rules |
| **Reports** | Built-ins + custom-SQL view builder, CSV export | Scheduled delivery, Looker/Metabase/Superset connector packs, XLSX & PDF |
| **Barcodes/Labels**| QR, Code-128, 128-auto, PDF/SVG templates, per-tenant defaults | Designer UI, Zebra label-printer direct print (ZPL), PrintNode bridge |
| **Importers** | CSV (idempotent, dry-run), Snipe-IT API migrator, FleetManager MySQL dump migrator | SAP Ariba, Oracle Fusion, Coupa, ServiceNow CMDB bi-directional sync |
| **Audit log** | Per-action immutable append, hash chain, export CSV; incident-response procedure documented in [`docs/runbooks/incident.md`](../runbooks/incident.md) (severity taxonomy + LGPD ANPD timing + tenant-notification templates + post-mortem template + quarterly drill cadence) | SIEM streaming (Splunk, Datadog, Elastic), SOC-2 evidence pack |
| **Observability**| Structured JSON logs (pino) with request-id + tenant + user correlation; Sentry opt-in via `SENTRY_DSN` (operator's own project); request-id surfaced in every response (`x-request-id` header + `ref` field on error bodies) ([ADR-0018](../adr/0018-observability-stack.md)) | Managed observability bundle: Prometheus metrics, OpenTelemetry traces, per-tenant log routing, dashboards + alerts |
| **Backups** | Spatie-style app-level backups + DB dump + object-store copy | Point-in-time recovery via WAL shipping, cross-region DR, restore drills |
| **White-label** | — (brand is "Panorama") | Per-tenant logo, colour, email templates, login page, custom domain |
| **Support** | Community (GitHub Discussions, Matrix/Discord); self-host operators run their own incident response per [`docs/runbooks/incident.md`](../runbooks/incident.md) | 24×7 pager, 4-hour response SLA, named CSM, managed incident response with orchestrated tenant notification across the hosted fleet |
| **Price** | Free | Per-seat, bands published on panorama.vitormr.dev |

## What Community will never hold back

These flows are **always complete** in Community:

- Check out, check in, scan QR
- Book a vehicle, approve/reject, ride it, return it
- Flag for maintenance, assign to a technician, track the repair
- Export any entity list to CSV
- View the audit log
- Migrate from Snipe-IT

If any of those depended on Enterprise code to be end-to-end usable,
the split has broken.

### How CI proves this

Two complementary gates guard the always-complete promise. Today the
repo is community-only by construction — the `panorama-enterprise`
private repo is gated on day-60 metrics per [ADR-0002](../adr/0002-oss-commercial-split.md)
and does not exist yet — so the static gate has nothing to find by
design. It runs in well under a second on every PR and exists today
as a tripwire for the additive-only contract that activates when the
enterprise repo lands; don't delete it as dead weight before then.
The functional gate is the load-bearing assertion that the flows
above keep working as the codebase evolves; when the enterprise repo
lands, the static gate begins enforcing the additive-only contract
(no `@panorama/enterprise-*` references slipping into the community
sources) and the functional gate continues to prove the flows still
work without enterprise code installed.

| Flow (matrix promise) | Functional test | Static gate |
|---|---|---|
| Check out / check in | [`reservation-basket.e2e.test.ts`](../../apps/core-api/test/reservation-basket.e2e.test.ts), [`community-smoke.e2e.test.ts`](../../apps/core-api/test/community-smoke.e2e.test.ts) `essentials:reservation-lifecycle` | n/a (no enterprise surface) |
| Book a vehicle, approve, return | [`reservation-basket.e2e.test.ts`](../../apps/core-api/test/reservation-basket.e2e.test.ts), `community-smoke.e2e.test.ts` `essentials:reservation-lifecycle` | n/a |
| Blackout windows enforced | `community-smoke.e2e.test.ts` `essentials:blackout-rejection` | n/a |
| Flag for maintenance, assign, track repair | [`maintenance.e2e.test.ts`](../../apps/core-api/test/maintenance.e2e.test.ts), [`inspection-maintenance.e2e.test.ts`](../../apps/core-api/test/inspection-maintenance.e2e.test.ts), `community-smoke.e2e.test.ts` `essentials:maintenance-track-repair` | n/a |
| Cross-tenant isolation (RLS) | `community-smoke.e2e.test.ts` `essentials:cross-tenant-isolation`, every other `*.e2e.test.ts` per ADR-0006 | n/a |
| Export any entity list to CSV | [`tenant-export.e2e.test.ts`](../../apps/core-api/test/tenant-export.e2e.test.ts), `community-smoke.e2e.test.ts` `essentials:csv-export-end-to-end` | n/a |
| View the audit log | [`audit-chain-integrity.e2e.test.ts`](../../apps/core-api/test/audit-chain-integrity.e2e.test.ts), `community-smoke.e2e.test.ts` `essentials:audit-log-chain` | n/a |
| Migrate from Snipe-IT | [`snipeit-compat-read.e2e.test.ts`](../../apps/core-api/test/snipeit-compat-read.e2e.test.ts), [`snipeit-compat-auth.e2e.test.ts`](../../apps/core-api/test/snipeit-compat-auth.e2e.test.ts) | n/a |
| (Future) no `@panorama/enterprise-*` reference leaks in | n/a (no surface yet) | `no-enterprise-imports` CI job (`scripts/no-enterprise-imports.ts`) — scans `apps/` + `packages/` + `.github/` + repo-root `package.json`/`pnpm-lock.yaml` across `.ts/.tsx/.js/.mjs/.cjs/.json/.yml/.yaml` |

Add a row to this table when a new always-complete flow lands;
remove a row only if the flow is genuinely no longer a Community
guarantee (a process change that should also update the matrix
above). The `community-smoke.e2e.test.ts` file is the canonical
composition test that walks the flows as one user story — it catches
regressions in the seams between flows that per-flow tests cannot.

### How observability is proven

The Observability row's "always-complete in Community" promise is the
JSON structured-log surface plus an opt-in Sentry hook — *not* full
OTel/Prom on day one (those are Enterprise per the row above, and
[ADR-0018](../adr/0018-observability-stack.md) §"Alternatives A"
rejects them for Wave 0 with a future-amendment escape hatch).

What gets shipped here, and how Panorama proves the wiring holds:

| Promise | Functional assertion |
|---|---|
| Every response carries `x-request-id` | [`observability-smoke.e2e.test.ts`](../../apps/core-api/test/observability-smoke.e2e.test.ts) cases 1 + 3 |
| Inbound `x-request-id` is validated (log-injection guard) | [`request-context.middleware.test.ts`](../../apps/core-api/test/request-context.middleware.test.ts) + `observability-smoke.e2e.test.ts` case 2 |
| `RequestContextMiddleware` runs BEFORE `SessionMiddleware` (ALS continuity) | `observability-smoke.e2e.test.ts` case 4 — the `ref` field in a 400 body matches the response header, which is only true if the ALS frame survives the full middleware pipeline |
| Boot/cron/worker code paths outside any HTTP request do NOT throw on the pino mixin | `request-context.middleware.test.ts` "ALS empty-frame default" |
| Sentry stays off unless the operator opts in via their own `SENTRY_DSN` | code review of `sentry.bootstrap.ts`; `SENTRY_DSN` unset → `initSentryIfConfigured` returns false; no events leave the host |

Operators reading this row at a procurement table should expect:

- JSON to stdout on every log line, with `requestId`, `tenantId`,
  `userId` fields populated from the request ALS — pipe the stream
  to whatever aggregator you use (Logtail, Datadog, Loki, plain
  files); Panorama does not run a transport.
- Errors include a `ref:` field in the JSON body that end-users
  can paste to support — one filter on the log aggregator
  reconstructs the request.
- `SENTRY_DSN` is opt-in, your own project, your own data. The
  maintainer never receives it. AGPL right per
  [ADR-0002](../adr/0002-oss-commercial-split.md).
