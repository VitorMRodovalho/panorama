# ADR-0008: Invitation flow (email-token, TTL, one-time-use, audit)

- Status: Proposed
- Date: 2026-04-18
- Deciders: Vitor Rodovalho
- Related: [ADR-0007 Tenant Owner role](./0007-tenant-owner-role.md)

## Context

Once Panorama has a web login flow (step 3b), the next natural question
is *"how does a new user land in my tenant"*. Two paths exist:

1. **Pre-seeded users** — the tenant admin creates the `User` +
   `TenantMembership` via CSV import or admin API. User logs in, sees
   their tenant. This is what step 3b assumes.
2. **Invitations** — admin enters an email address; Panorama sends a
   one-time link; target clicks and lands authenticated. This is the
   standard SaaS path and what users expect.

The real-world case the user called out (Amtrak/FDT project) has both
shapes: some drivers are employees of the primary company (pre-seeded
from HR), some are contractors or partners from other companies who
need **guest access**. Both reduce to the same invitation primitive.

## Prior art

| Product | Token TTL | One-time-use | Email-match required | Audit trail | Re-send allowed |
|---------|-----------|--------------|----------------------|-------------|-----------------|
| **Auth0 invitations** | 7 days (configurable, 1h min, 30d max) | Yes | Yes | Yes (API) | Yes |
| **Clerk invitations** | 30 days | Yes | Yes | Yes | Yes |
| **Slack** | Never expires by default; revokable | No (reusable link within TTL) | Optional | Limited | Revoke + new link |
| **GitHub org invite** | 7 days | Yes | Yes | Yes | Yes |
| **Linear** | 30 days | Yes | Yes | Yes | Yes |
| **Microsoft 365 B2B** | 90 days (configurable) | Yes | Yes (verified at IdP) | Yes (very detailed) | Yes |
| **Notion** | 7 days | Yes | Yes | Limited | Yes |

Security patterns universal across all:

1. **Token is opaque** (not a JWT) — random N-byte, URL-safe
2. **Token hash stored**, not plaintext, same as password reset flows
3. **Email verification at acceptance** — the accepting user's verified
   email must match the invitation's target email
4. **Rate limits** on invitation creation per admin per hour
5. **Audit**: created / emailed / bounced / opened / accepted / expired / revoked

## Decision

Panorama ships an **email-token, one-time-use, TTL'd invitation** with
a dedicated `Invitation` table, async delivery via BullMQ, and a
first-class audit trail.

### Data model

New table:

```prisma
model Invitation {
  id                String   @id @default(uuid()) @db.Uuid
  tenantId          String   @db.Uuid
  /// lowercased + trimmed at write time
  email             String
  role              String   // 'owner' | 'fleet_admin' | 'fleet_staff' | 'driver'

  /// SHA-256 of the plaintext token we email. Plaintext exists only in
  /// the email + in the URL the target clicks. Panorama never persists
  /// the plaintext.
  tokenHash         String

  /// Optional: if the admin is re-inviting someone who already has a
  /// Panorama User, link it up-front so acceptance is a no-login-needed
  /// step for the user.
  targetUserId      String?  @db.Uuid

  invitedByUserId   String   @db.Uuid
  expiresAt         DateTime
  acceptedAt        DateTime?
  /// If accepted, which user id actually consumed it.
  acceptedByUserId  String?  @db.Uuid
  revokedAt         DateTime?
  revokedByUserId   String?  @db.Uuid

  /// Email outbox state — populated by the delivery worker.
  emailQueuedAt     DateTime?
  emailSentAt       DateTime?
  emailBouncedAt    DateTime?
  emailLastError    String?

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  tenant            Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  invitedBy         User     @relation("Inviter",   fields: [invitedByUserId], references: [id])
  targetUser        User?    @relation("PreTarget", fields: [targetUserId],    references: [id], onDelete: SetNull)
  acceptedBy        User?    @relation("Acceptor",  fields: [acceptedByUserId], references: [id], onDelete: SetNull)

  /// At most one OPEN (non-accepted, non-revoked, non-expired) invite
  /// per (tenantId, email) at a time. Enforced by a partial unique
  /// index on the `acceptedAt IS NULL AND revokedAt IS NULL` predicate.
  @@index([tenantId, email])
  @@index([expiresAt])
  @@map("invitations")
}
```

The partial unique index is a hand-written SQL migration (Prisma
doesn't model partial indexes yet):

```sql
CREATE UNIQUE INDEX invitations_one_open_per_tenant_email
  ON invitations (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
```

### Token mechanics

- **Format**: 32 random bytes, base64url-encoded (43 chars). Generated
  via `crypto.randomBytes(32)`.
- **Storage**: we store `sha256(token)` base64url-encoded. At acceptance,
  we hash the inbound token and look up by the hash. Constant-time
  comparison unnecessary because lookup is by index, not by string
  comparison against a known value.
- **Transport**: emailed as part of an acceptance URL:
  `https://panorama.vitormr.dev/invitations/accept?t=<token>`
- **Lifetime**: 7 days by default. Configurable per tenant in
  `Tenant.invitationTtlSeconds` (defaults to `604800`). Community
  caps TTL between 1 hour and 30 days. Enterprise unlocks 1 hour to
  365 days.

### Acceptance rules

When a request hits `/invitations/accept?t=<token>`:

1. Compute `sha256(token)` → look up `Invitation` by `tokenHash`.
2. Check `acceptedAt IS NULL`, `revokedAt IS NULL`, `expiresAt > now()`.
   On any fail → 410 Gone, with a response code that tells the UI
   whether to offer "request a new invite".
3. If the target is already logged in:
   a. Verify the current session's email equals the invitation email
      (case-insensitive). Mismatch → 403 with a "log out and retry"
      message. **Never** automatically accept an invite for an email
      that doesn't match the session.
   b. Create the `TenantMembership` with `status='active'`,
      `acceptedAt=now()`. Copy `invitedByUserId` from the invitation.
   c. Mark the invitation `acceptedAt=now()`,
      `acceptedByUserId=currentUser.id`.
4. If not logged in:
   a. Redirect to `/login?invite_token=<token>`. Login UI shows:
      "You're signing in to accept an invite from *{inviter}* to
      join *{tenant}*." with the target email prefilled.
   b. After successful login (password or OIDC), re-enter the
      acceptance path from step 1 with the now-authenticated session.

Edge cases handled:

- **User registers a different email via OIDC** (Google returns
  `alice@personal.com` but invite is for `alice@acme.com`) → email
  mismatch → UI asks them to use the exact email or request a new
  invite.
- **User has multiple Panorama memberships already** — acceptance
  just appends another membership; nothing about other tenants changes.
- **Invitation clicked twice** — second click hits `acceptedAt IS NOT
  NULL`, returns a "this invitation has been used" page that links to
  the user's current session (or login if not authenticated).
- **Timing/race**: two concurrent accepts from the same session. The
  UPDATE on Invitation uses `WHERE acceptedAt IS NULL` as a predicate
  and `RETURNING *` — Postgres serialises; at most one accept wins.

### Email delivery (outbox pattern)

- Invitation creation writes the `Invitation` row AND an `email_outbox`
  row in the same transaction. Controller returns 201 without waiting
  for send.
- A BullMQ worker polls the outbox, renders the trilingual (EN/PT-BR/ES
  matching tenant `locale`) invitation template, sends via the
  configured SMTP or SES/SendGrid provider (enterprise), and writes
  `emailSentAt` back.
- On SMTP failure, the job is retried with exponential backoff, up to
  5 attempts over 24 hours.
- **Bounce handling** (0.3+): inbound webhook from SES/SendGrid
  updates `emailBouncedAt` + surfaces a warning to the inviter.

### Rate limits

- **Community default**: 100 invitations per admin per hour, 1 000 per
  tenant per day. Rejections return 429 with `Retry-After`.
- **Enterprise default**: same, but configurable via Tenant settings
  and overridable by a Super Admin.

Rate limits are enforced using a sliding-window counter in Redis. If
Redis is unavailable, the system fails *closed* (reject invite creation)
rather than open — a temporary outage of the limiter is preferable to
an uncapped invitation blast.

### Resend / revoke

- **Resend**: admin POSTs `/invitations/:id/resend`. Generates a new
  token (invalidates the old), resets `emailQueuedAt/SentAt/BouncedAt`,
  re-queues the email. The old token stops working immediately.
- **Revoke**: admin POSTs `/invitations/:id/revoke`. Sets `revokedAt`,
  `revokedByUserId`. Token stops accepting immediately. Email (if
  already delivered) is not recalled but the link 410s.

### Audit events

Every state change writes an `audit_events` row:

- `panorama.invitation.created`
- `panorama.invitation.email_sent` (or `email_bounced`, `email_failed`)
- `panorama.invitation.accepted` (includes target user id)
- `panorama.invitation.expired` (cron-driven)
- `panorama.invitation.revoked`
- `panorama.invitation.resent`

Tenant admins see a filtered view of these via the admin UI.

### Expiration sweep

A BullMQ cron (every hour) closes out expired invitations:

```sql
UPDATE invitations
   SET updated_at = NOW()
 WHERE accepted_at IS NULL
   AND revoked_at IS NULL
   AND expires_at < NOW();
-- Emits `panorama.invitation.expired` per row via a TRIGGER.
```

The sweep exists so expired invitations appear in the admin UI with the
correct state without requiring an admin to land on them.

### Security properties summary

| Threat | Mitigation |
|--------|-----------|
| Token leakage | Hashed at rest; email uses TLS; token has TTL + one-time-use |
| Email interception → account takeover | Email-match required at acceptance (target email must equal session email) |
| Admin spamming targets | 100/hr/admin rate limit, Redis-backed |
| Bulk enumeration of invite URLs | Token is 32 random bytes (256-bit entropy); brute force infeasible |
| Stolen invite used after the employee leaves | TTL + one-time-use + explicit revoke by admin |
| Timing attack at lookup | Lookup uses SHA-256 hash as an index key; no sensitive comparison |
| Race in double-accept | `WHERE acceptedAt IS NULL` predicate + Postgres serialisation |
| Redis-down → unlimited invites | Limiter fails closed (refuses creation); deliberate |

## Alternatives considered

### Magic link (same token grants direct login, no account required)

What Slack's old invite links did. Tempting but couples
authentication to invitation — we want invitations to layer on top of
the existing auth (password / OIDC). Rejected.

### JWT as the token

Opaque random is better for invitations: no client-side parsing, no
"what if we leak the signing key", and revocation is trivial (flip
`revokedAt`). JWTs would force us to keep a revocation list anyway.
Rejected.

### Embed the invitation in the membership row

What ADR-0007's schema already hints at (`TenantMembership.status =
'invited'`). Rejected for this flow:

- An invite exists **before** a Panorama `User` necessarily exists
  (target has no account yet).
- Invitation needs its own audit + rate-limit + email state that
  doesn't belong on a membership row.
- Embedding complicates the partial unique index ("one open invite per
  (tenant, email)").

Membership's `invitedBy*` columns remain useful — at acceptance, we
COPY the inviter, `invitedAt`, `acceptedAt` from the Invitation row
into the membership. Membership carries the post-facto audit; Invitation
table carries the in-flight state.

### No TTL — admin-managed only

Rejected. Employees leave; emails get forwarded; old tokens become a
liability. Fixed TTL floors the risk window.

## Consequences

### Positive

- First-class invitation UX matches what customers expect.
- Guest-from-other-company scenario (Amtrak/FDT) works out of the
  box — same invite shape, they land as `role='driver'` in the
  inviting tenant.
- Audit trail gives tenant admins the answer to "who added this
  person?" without needing support tickets.
- Outbox pattern means email delivery failures don't block the admin
  UI, and retries are free.

### Negative

- New table + unique partial index + trigger — more schema surface.
- BullMQ + Redis required for email delivery (they're already in the
  stack — just wiring).
- Rate-limit-closed-on-Redis-outage is a deliberate availability
  sacrifice we have to document prominently.

### Neutral

- Enterprise additions (SCIM just-in-time provisioning, policy-based
  auto-approve) layer cleanly on this model without reopening it.

## Execution order

**Not implemented at the moment this ADR is written.** Sequencing to
avoid gaps / duality with ADR-0007 and the ongoing 0.2 work:

1. ✅ 0.2 step 2 (committed) — password + OIDC + session + multi-tenant
   switching. Schema already has `TenantMembership.status` = 'invited'.
2. **▶ 0.2 step 3b (next)** — web login + /assets list. Users are
   seeded by super-admin tooling; no invitation UI yet.
3. 0.2 step 3c — **Invitation flow** lands as a dedicated PR:
   - Migration 0004: `invitations` table + partial unique index +
     expiration trigger.
   - BullMQ worker for email delivery.
   - `/invitations/*` REST endpoints.
   - Acceptance web page on the `apps/web` side.
   - Trilingual email templates.
   - Rate limit + audit wiring.
4. 0.2 step 3d — **Owner enforcement** (ADR-0007) lands in the same
   window: Postgres trigger, service guards, "single Owner" admin UI
   warning, break-glass CLI for super admins.
5. 0.3 — bounce-handling webhook, invitation analytics, enterprise
   SCIM provisioning replacing the invitation flow for IdP-managed
   tenants.

This ADR is the contract. Step 3c's commit message will cite it and
any deviation (e.g. TTL bounds change) will land as an ADR update
first, code second — per the ADR workflow in
[0000-index.md](./0000-index.md).
