# ADR-0010: Snipe-IT compatibility shim — auth model

- Status: Accepted (reviewed 2026-04-18 — tech-lead + security-reviewer APPROVE)
- Date: 2026-04-18
- Deciders: Vitor Rodovalho
- Related: [ADR-0003 Multi-tenancy](./0003-multi-tenancy.md), [ADR-0007 Tenant Owner](./0007-tenant-owner-role.md), [ADR-0008 Invitation flow](./0008-invitation-flow.md)

## Context

Panorama absorbs SnipeScheduler-FleetManager's operational fleet
workflows (reservations, check-outs, calendars — ADR-0009). Existing
deployments of that tool sit in front of a separate Snipe-IT install
and talk to it via `SnipeScheduler-FleetManager/src/snipeit_client.php`
— a Bearer-token HTTP client against `/api/v1/*`. As Panorama takes
over the asset-of-record role, those existing FleetManager clients (and
any third-party scripts built to the same Snipe-IT contract) need a way
to keep working without rewriting against a Panorama-native API they
don't know about yet.

The **compat shim** is a minimal Snipe-IT-shaped surface served by
Panorama that lets a FleetManager-era client hit:

- `GET /api/v1/hardware` (+ `/hardware/:id`) — list / get assets
- `GET /api/v1/users`    (+ `/users/:id`)    — list / get users
- `GET /api/v1/categories`                   — list categories
- `GET /api/v1/models`   (+ `/models/:id`)   — list / get asset models

…and receive responses that match Snipe-IT's JSON shape closely enough
for the existing client to `json_decode` and use unchanged. This ADR
scopes **only** the authentication model the shim accepts. Endpoint
shapes + field mappings land in a follow-up PR; ADR-0009-style
implementation detail belongs in code, not here.

The recurring failure modes we're defending against:

- **Broken drop-in.** A FleetManager operator points `$snipeBaseUrl`
  at their Panorama install, keeps `$snipeApiToken` the same, and
  nothing works because Panorama expected a session cookie.
- **Actor amnesia.** A service-account token flattens every compat
  call to "service@panorama". The audit log then shows nothing
  useful when the regulator asks "who pulled the vehicle list at
  3 a.m. on April 12?"
- **Token leak blast radius.** A tenant-wide token, leaked by one
  user, grants read access to the whole tenant until someone notices.
  We want per-user revocation, not "rotate the shared secret".
- **Token survives role change.** A user who was `fleet_admin` and is
  now `driver` keeps their pre-demotion scope through a cached token.

## Prior art

| Product | Token model | Storage | Attribution |
|---------|-------------|---------|-------------|
| **Snipe-IT** | Personal Access Tokens (Laravel Passport `personal_access_tokens`), per-user | Hashed (SHA-256) | Token owner = actor |
| **GitHub** | PATs (classic + fine-grained), per-user | Hashed | Token owner |
| **Stripe** | Restricted API keys, per-account | Hashed | Key metadata carries intent |
| **GitLab** | PATs + Deploy Tokens (per-project) + Project Access Tokens | Hashed | Token owner |
| **Linear** | Personal API keys | Hashed | Token owner |

The consistent pattern across peers: **per-user PATs, hashed at rest,
Bearer-auth in the Authorization header**. Snipe-IT itself sits in this
pattern, which lowers the drop-in-replacement cost to roughly zero: the
existing `snipeit_client.php` sends
`Authorization: Bearer <token>`; Panorama needs to honour the same
header.

## Decision

**Per-user Personal Access Tokens (PATs), Bearer-auth, sha256-hashed at
rest, tenant-scoped.** Each token belongs to a
`(userId, tenantId)` pair with an explicit scope list; the shim
endpoints require the `snipeit.compat.read` scope.

Schema shape (next migration on disk is
`0009_personal_access_tokens`, landing with the endpoint PR — not
part of this ADR's acceptance):

```prisma
model PersonalAccessToken {
  id              String    @id @default(uuid()) @db.Uuid
  userId          String    @db.Uuid  // token belongs to this user
  tenantId        String    @db.Uuid  // and is scoped to this tenant
  issuerUserId    String    @db.Uuid  // who minted it — usually = userId,
                                      // but super-admin impersonation is
                                      // possible (bulk onboarding)
  name            String    // free text label ("fleet-cluster-prod")
  // Plaintext exists ONLY at creation time — we return it once and
  // never again. Server stores sha256(token) base64url-encoded. Same
  // pattern as invitations (ADR-0008).
  tokenHash       String    @unique
  // Prefix = literal "pnrm_pat_" + first 8 chars of the base64url
  // secret, generated deterministically so the admin UI can render
  // it WITHOUT holding plaintext. 8 chars of a 32-byte (256-bit)
  // secret = 48 bits of prefix disclosure; 208 bits remain after. No
  // weakening of the hash lookup.
  tokenPrefix     String
  scopes          String[]  // e.g. ['snipeit.compat.read'] at 0.2
  expiresAt       DateTime? // null = no expiration; UI defaults to +1y
  lastUsedAt      DateTime?
  revokedAt       DateTime?
  createdAt       DateTime  @default(now())
  // Audit-of-creation context. Not PII — IP + UA are already in the
  // session event metadata, but having them on the PAT row makes the
  // "list my tokens, show where each was minted from" view cheap.
  createdByIp     String?
  createdByUserAgent String?

  user   User   @relation("OwnedTokens",   fields: [userId],       references: [id], onDelete: Cascade)
  issuer User   @relation("IssuedTokens",  fields: [issuerUserId], references: [id])
  tenant Tenant @relation(                fields: [tenantId],     references: [id], onDelete: Cascade)

  @@index([tenantId, userId])
  @@index([tenantId, revokedAt])
  @@index([userId, revokedAt])
  @@index([tokenHash])
}
```

A DB trigger on `UPDATE personal_access_tokens.revokedAt` emits a
`panorama.pat.resurrected` audit row whenever the column transitions
`non-NULL → NULL` (revocation undone). An attacker with DB write
already owns the tenant, but the trigger makes the tamper visible to
the audit chain (hash-linked, ADR-0003 §audit).

**Boundary enforcement — the compat shim is its own Nest module.**
Scope-string checks per-endpoint are a recipe for one forgotten
decorator quietly unlocking a mutation. Instead:

- `SnipeitCompatModule` mounts at path prefix `/api/v1` and its
  controllers run behind a `PatAuthGuard` that ONLY accepts Bearer
  PATs. A session cookie attached to a request reaching this module
  is a configuration error from the caller, not a fallback path —
  the guard returns **401 `pat_required`** in that case. Silent
  cookie-ignore is the footgun this boundary exists to kill.
- Native Panorama controllers (reservations, invitations, auth, etc.)
  live in modules that do NOT import `PatAuthGuard`. Their session
  guard actively rejects requests whose `req.actor.kind === 'pat'`,
  so a PAT replayed against `/reservations` returns 401, not 403.
  This is an **allowlist, not a blocklist** — a new write endpoint
  under a native module is unreachable from a PAT by construction,
  not by convention.
- Scope strings remain as defence-in-depth: inside the compat module,
  each endpoint still asserts its required scope, so a future
  compat-write-surface (not planned for 0.2) can't inherit read-only
  PAT reach for free.
- Negative test — a PAT against `/invitations` MUST 401 — is a
  required integration test in the shim PR.

**Authentication flow (inside the compat module):**

1. Client sends `Authorization: Bearer pnrm_pat_<32-byte-base64url>`.
2. `PatAuthGuard` extracts the token, computes `sha256(token)`,
   looks up a non-revoked non-expired row in `PersonalAccessToken`.
   Bad / stale token → 401 + audit `panorama.pat.rejected`.
3. Re-checks the user's current `TenantMembership.status` on every
   call (cached in Redis 30 s, explicitly invalidated by membership
   mutation writes so staleness can't exceed the refresh window).
   On status ≠ `active` → 401 `user_suspended` / `not_a_member`.
   This closes the "token survives role change" failure mode without
   needing a cascade invalidation on membership edits.
4. Membership lookup failure (Redis + DB both unreachable) **fails
   closed** — inherits the ADR-0008 invariant #4. Return 503; do
   NOT allow the request through on a timeout.
5. Populates `req.actor` with `{ kind: 'pat', userId, tenantId,
   scopes, tokenId }`; the native-module session guard explicitly
   rejects this shape.
6. Endpoint asserts required scope (`snipeit.compat.read`); 403 if
   absent.
7. On FIRST successful use of a token, middleware writes
   `lastUsedAt` synchronously and emits `panorama.pat.used_first` so
   "never used" vs "used once" is trustworthy for admins + audit.
   Subsequent calls update `lastUsedAt` asynchronously (batched
   ~60 s) because audit truth lives in rate-limiter metrics, not in
   that column.
8. If `(now - lastUsedAt) > 30 d` on a successful call, emit
   `panorama.pat.used_after_dormant` — cheap anomaly signal for the
   "token lay dormant, now an attacker is using it" scenario.

**Rate limiting:**

- **Per token:** 300 requests / hour sustained, burst 60 / minute.
  Lower than Snipe-IT's usual "unlimited" cap because the compat
  client already caches (`snipeit_client.php` has a GET cache) and a
  leaked token shouldn't be a viable ~14k-row/day scrape vehicle.
- **Per tenant:** 10 000 PAT requests / hour across all tokens.
  Guards against the "100 users × 600/hr" fan-out (tech-lead catch).
- **Per issuer on `POST /auth/tokens`:** 10 tokens / user / hour —
  rate-limit issuance itself so a compromised session can't mint an
  unbounded fleet of PATs that outlive the session.
- All three are Redis-backed and fail closed.

**Token issuance:** an authenticated session (cookie-based user) can
POST `/auth/tokens` with `{ name, scopes, expiresAt }`. Response
includes the plaintext token exactly once. A matching DELETE revokes
by id. The issuance endpoint explicitly serialises an allowlist of
response fields — `tokenHash` is never returned. The Prisma
middleware registered in the migration PR redacts `tokenHash`,
`password`, `emailHash` from query-log output so operators running
with `log: ['query']` on don't accidentally tee pre-images to
stdout. No UI in 0.2; Enterprise UI lands in 0.3.

**Token rotation UX (0.2 non-commitment):** rotating a PAT is a hard
cutover — issue new, revoke old. No "grace period" is planned. This
is explicit so no one ships a zero-downtime-rotation commitment by
accident. Revisit in 0.3 if customer feedback demands it.

**Audit events:**
- `panorama.pat.created` — token issued (metadata: tokenId,
  tokenPrefix, scopes, expiresAt, issuerUserId)
- `panorama.pat.revoked` — token revoked (explicit)
- `panorama.pat.resurrected` — DB trigger fires on
  `revokedAt non-NULL → NULL`; tamper-visible in the audit chain
- `panorama.pat.used_first` — first successful auth with a token
- `panorama.pat.used_after_dormant` — successful auth after ≥30 d
  idle
- `panorama.pat.expired` — expiration trip
- `panorama.pat.rejected` — bad or stale token encountered at
  middleware. Metadata always includes `tokenId` (if the prefix
  matched a known row) in addition to `tokenPrefix`, so two tokens
  named "test" are distinguishable on a 3 a.m. alert.

Plaintext never appears in logs or audit metadata.

**HIPAA / SOC 2 compliance flag:** a per-tenant
`tenant.auditEveryPatCall` boolean (default `false`) flips the
middleware into "emit `panorama.pat.used` on every call" mode. This
lands in the migration PR so an enterprise compliance review never
has to wait on an ADR change.

## Alternatives considered

### Tenant-wide service tokens

One token per tenant, shared by every client that wants to read. 
Simpler initial setup. Rejected because:

- Audit trail flattens — every call records a synthetic
  "service@panorama" actor; the actor-attribution guarantee we built
  into AuditEvent (ADR-0003 §audit) silently breaks for the compat
  surface.
- Blast radius of a leaked token is the whole tenant read-surface
  until someone rotates the shared secret. Per-user tokens localise
  compromise.
- No natural per-user lastUsed telemetry. "Is anyone still using
  this integration?" is answerable per-user with PATs; unanswerable
  with a shared secret.

Reopen if a concrete M2M integration (e.g. a nightly asset-export
cron) has no natural user identity to attach to. The cron can still
use a PAT issued to a dedicated service user — that's a better fix
than introducing a different auth shape.

### Session-cookie reuse (iron-session)

Caller logs in via `POST /auth/login`, keeps the encrypted
`panorama_session` cookie, attaches it on subsequent calls.

- Mismatch with Snipe-IT's Bearer contract: FleetManager's
  `snipeit_client.php` hardcodes `Authorization: Bearer …` and does
  not manage a cookie jar. Drop-in replacement goal broken.
- iron-session cookies carry full session state encrypted with
  `SESSION_SECRET`. Exposing that blob to API clients couples them to
  Panorama's session rotation cadence — every session-secret rotation
  would silently break every FleetManager client.
- Session cookies have no natural scope (they carry full user powers).
  A read-only FleetManager integration shouldn't carry the ability to
  invite users.

### OAuth2 client credentials / JWT

Issue short-lived JWTs to registered client apps via a
`/oauth2/token` endpoint. Industry-standard M2M.

- Overkill for the compat shim's scope (4 read-only endpoints).
- Requires a client-registration UI we don't have (and don't need
  for 0.2).
- Doesn't match the Snipe-IT contract — FleetManager clients would
  have to be rewritten. The whole point of the shim is the opposite.

Worth revisiting if Enterprise customers ask for federated M2M auth
(partner company talks to our Cloud on behalf of their fleet). Add a
separate `/oauth2/*` surface then; it does not replace PATs.

### Laravel-Passport-shaped endpoint (`/api/v1/personal_access_tokens`)

Mirror Snipe-IT's exact management endpoint so their `/account/api`
UI-generated tokens would work unchanged.

Rejected for 0.2 because it leaks Laravel-isms into Panorama's domain
model for zero current benefit — FleetManager doesn't need a
token-management UI, it just consumes a hardcoded token. If a
customer migration brings a Snipe-IT database full of issued
Passport tokens, we can add an import path in ADR-00NN later;
in-flight tokens don't cross the migration because hashes were
computed against Snipe-IT's salt, not ours.

## Consequences

### Positive

- FleetManager operators point `$snipeBaseUrl` at Panorama, keep
  their existing client code, swap only the token value. Drop-in
  goal met.
- Per-user attribution preserves the audit model end-to-end —
  reservation code's `actorUserId` assumption carries through the
  compat surface unchanged.
- Per-user revocation + per-token scope = a leaked token is a
  bounded incident, not a tenant-wide outage.
- Module-boundary enforcement (PAT auth lives in its own Nest
  module; native modules reject PATs at the session guard) makes it
  structurally impossible to expand the PAT reach by forgetting a
  decorator. A future contributor adding a write endpoint under
  `/api/v1` has to explicitly register it in `SnipeitCompatModule`
  AND widen the scope list — two deliberate acts, not one missing
  check.

### Negative

- Users need to generate and rotate their own tokens. New UX
  friction for teams that never wrote one before.
- Free-text `name` + no rotation grace period means a bad operator
  naming tokens "test" and forgetting about them is a real risk. A
  future UI lint ("this token hasn't been used in 90 days —
  revoke?") and the `used_after_dormant` audit event together
  surface the risk, but don't eliminate it.
- Hashed-at-rest + no plaintext recovery = a user who loses their
  token issues a new one and revokes the old. Same as every other
  PAT system.
- Two Nest modules for one service introduces boundary ceremony
  (which module exports what, which guard is on which route). Worth
  the clarity; the alternative — convention-only scope strings —
  failed the "paged at 3 a.m., is this gate explicit?" test in
  pre-code review.

### Neutral

- The shim is additive to Panorama's native API — not a replacement.
  Native clients keep using session cookies. The two auth surfaces
  stay orthogonal.
- Enterprise can layer SCIM-provisioned tokens on top (IdP
  assertion → token mint flow) without reopening this ADR; SCIM is
  just a different issuer for the same
  `PersonalAccessToken` row.
- A feature flag `FEATURE_SNIPEIT_COMPAT_SHIM` gates
  `SnipeitCompatModule` registration at bootstrap so a bad deploy
  can drop the entire shim surface without a migration rollback.

## Execution order

1. **This ADR** — auth model accepted (or blocked by tech-lead /
   security-reviewer pre-code).
2. **Migration 0009 `personal_access_tokens`** — table + indexes +
   rls.sql (tenant-scoped reads, super-admin writes through the
   issuance endpoint) + revokedAt-resurrection trigger emitting
   `panorama.pat.resurrected` + ROLLBACK.md.
3. **Prisma query-log redaction middleware** — registered globally
   in `PrismaService`, strips `tokenHash`, `password`, `emailHash`
   from the query-log output BEFORE any PAT code lands.
4. **AuthModule extension** — PAT issuance (`POST /auth/tokens`
   under session) + revocation (`DELETE /auth/tokens/:id`) + the
   three rate limiters (per-token, per-tenant, per-issuer) + audit
   events. Session-based, not PAT-accessible — a PAT can't mint
   another PAT.
5. **`SnipeitCompatModule`** — standalone Nest module at path prefix
   `/api/v1`, mounts `PatAuthGuard` + membership-status re-check +
   synchronous-first-use telemetry. Native module session guards
   updated in the same PR to reject `req.actor.kind === 'pat'`.
6. **Compat shim read endpoints** — `/api/v1/{hardware,users,
   categories,models}` shaped to match the Snipe-IT JSON subset
   that `snipeit_client.php` reads (line 255 onward in that file).
7. **Integration test** — replay the FleetManager client's
   `get_requestable_assets()` + `get_snipeit_user()` paths against
   Panorama's shim; assert `json_decode` succeeds without
   client-side changes. Also assert `PAT → /invitations → 401`
   (negative test for the module boundary).

Each step lands as its own commit, gated by the agent review team
(tech-lead for migration + middleware; security-reviewer for auth
surface + rate-limiter + module boundary; persona-fleet-ops once a
FleetManager operator can point at it and exercise the read paths).
