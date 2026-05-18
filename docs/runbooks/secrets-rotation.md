# Secrets rotation runbook

> **Status.** Per-secret rotation matrix landed in Round 6 PR3
> (2026-05-17). Cross-reference
> [`incident.md`](./incident.md) Phase 3 for the in-incident decision
> tree and [`secrets-inventory.md`](./secrets-inventory.md) for the
> authoritative list of secrets in scope.

This page tells the operator how to rotate every secret listed in
[`secrets-inventory.md`](./secrets-inventory.md). Each section follows
the same shape:

- **When to rotate** — emergency (suspected leak) vs routine
  (scheduled hygiene) vs in-incident (driven by
  [`incident.md`](./incident.md)).
- **Procedure** — concrete shell commands; copy-paste safe on a
  standard Fly + Cloudflare + Supabase deploy. Self-hosters running
  Kubernetes / Coolify / bare docker compose substitute the
  platform-equivalent secret-set command.
- **Blast radius** — what breaks during the rotation window and for
  how long. Read this before you click "rotate" on a Saturday night.
- **Verification** — how to confirm the rotation took.
- **Rollback** — how to revert if the new value doesn't work.

The runbook covers the **Community / single-operator** rotation
contract. The fleet-wide managed-service variant (one rotation
across many hosted customer instances at once, with audit emission
per tenant and a per-customer rotation report) ships in the
**Enterprise edition** — see the [§Multi-tenant rotation
orchestration](#multi-tenant-rotation-orchestration) section at the
end.

## Decision tree — which path?

| Trigger | Path |
|---|---|
| Suspected leak (committed `.env` file, departing administrator with shell access, accidental log dump) | **Emergency path** for the leaked secret — invalidates sessions and revokes the leaked credential at the issuer. Skip the wait step. |
| Scheduled rotation (quarterly hygiene per org policy) | **Routine path** for each secret — zero-downtime where the secret supports it (SESSION_SECRET via `_PREVIOUS`), short-window for the rest. |
| Active incident already in [Phase 3 Contain](./incident.md#phase-3--contain) | Follow that phase's decision tree. It dispatches into this runbook per-secret; the entry points there are the section anchors below. |
| New self-host bringing up first deployment | No rotation needed — generate fresh values from scratch per [`secrets-inventory.md`](./secrets-inventory.md). |

## SESSION_SECRET — iron-session cookie encryption key

Iron-session encrypts every session cookie under the value of
`SESSION_SECRET`. A leaked value lets a holder forge or decrypt any
issued cookie until rotation. The rotation primitive (added in PR
#232) supports a single secondary key via `SESSION_SECRET_PREVIOUS`
so a routine rotation does not log users out.

### Path A — Emergency rotation (suspected key leak)

When to use:
- `.env` was accidentally committed to a public repository
- A backup containing `.env` leaked
- A departing administrator had shell access to the production host
- ANY scenario where someone outside the trust boundary may hold
  `SESSION_SECRET`

Goal: invalidate every active session, immediately. Users re-log in.

```bash
NEW=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$NEW|" .env
# The PREVIOUS clear is a no-op if the line isn't present in .env
# (which is the steady-state default). It's still load-bearing
# here — leaving a leaked value as PREVIOUS keeps it valid for
# SESSION_MAX_AGE_SECONDS, which is exactly the wrong outcome
# during a compromise.
sed -i "s|^SESSION_SECRET_PREVIOUS=.*|SESSION_SECRET_PREVIOUS=|" .env
docker compose -f infra/docker/compose.prod.yml up -d core-api
```

After the redeploy, fetch `/health` and confirm a fresh login
works. The boot logs should NOT contain
`session_secret_rotation_active` — a single-key boot does not emit
the rotation flag.

If the deploy fails (boot-throw on the new SESSION_SECRET), check
the deploy log surface (Fly logs / `docker compose logs core-api`)
for one of: `SESSION_SECRET must be at least 32...` (the new value
is too short) or `SESSION_SECRET_PREVIOUS must be a different
value...` (you copy-pasted into both vars).

### Path B — Routine zero-downtime rotation

When to use:
- Quarterly hygiene per organisational policy
- Cycling secrets after a planned major upgrade
- Any scheduled rotation where you have no reason to believe the
  current value has leaked

Goal: rotate without forcing users to re-log in.

#### Step 1 — flip

Move the current `SESSION_SECRET` to `SESSION_SECRET_PREVIOUS`; set a
fresh primary.

```bash
OLD=$(grep '^SESSION_SECRET=' .env | cut -d= -f2-)
NEW=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$NEW|" .env
sed -i "s|^SESSION_SECRET_PREVIOUS=.*|SESSION_SECRET_PREVIOUS=$OLD|" .env
docker compose -f infra/docker/compose.prod.yml up -d core-api
```

#### Step 2 — verify the rotation window

Check the boot logs for the rotation marker:

```bash
docker compose -f infra/docker/compose.prod.yml logs core-api \
  | grep session_secret_rotation_active
```

Expected line:

```
{"level":"info","session_secret_rotation_active":true,"context":"AuthConfig","msg":"auth_config_session_secret_rotation_active"}
```

If the line is absent, the new secondary did not load (most likely
the env var was malformed). Fix and redeploy before continuing.

**Multi-replica deploys:** the command above fetches only the local
container's stream. On Fly or any multi-instance deploy, replace
with `fly logs --app <app> | grep session_secret_rotation_active`
and confirm the line appears once per replica. A partial-rollout
state (some replicas with PREVIOUS, some without) is the worst
failure mode here — it looks fine on one host and silently logs out
users routed to the other.

Also verify a fresh login succeeds AND an existing browser session
(opened before the flip) continues to work without re-login.

#### Step 3 — wait

Wait at least `SESSION_MAX_AGE_SECONDS` (default 7 days,
`apps/core-api/src/modules/auth/auth.config.ts:169`). Every cookie
sealed before the flip will either re-issue under the new key on its
next request, or expire and force a fresh login.

Cookies sealed *during* the rotation window are encrypted with the
new primary; they survive the drop step.

**Set a calendar reminder for `date -d '+7 days'`** with a link
back to Step 4 below. The rotation window is fail-soft (it just
keeps working) so it's easy to forget; an unsupervised `PREVIOUS`
is a leaked key waiting to happen.

> **Do NOT run Step 4 before the wait elapses.** Cookies issued
> during the rotation window are encrypted with the primary at
> id 2; once the primary collapses back to a bare string at id 1
> (post-drop), those cookies fail to decrypt and every logged-in
> user is bounced to the login page. The wait is the entire reason
> this procedure is zero-downtime.

#### Step 4 — drop

Clear `SESSION_SECRET_PREVIOUS` and redeploy. Single-key steady
state.

```bash
sed -i "s|^SESSION_SECRET_PREVIOUS=.*|SESSION_SECRET_PREVIOUS=|" .env
docker compose -f infra/docker/compose.prod.yml up -d core-api
```

Confirm the rotation-active log line is no longer emitted on boot.

### Blast radius reference (SESSION_SECRET)

- **Path A** invalidates every active session. UX impact: every
  user is bounced to the login page on their next request; they
  re-enter credentials and proceed. No data loss. No downtime to
  the API surface itself.
- **Path B** is zero-impact when executed correctly. The only way
  to break users is by skipping Step 3 (the wait) or rolling out
  Step 1 to only some replicas.

## DATABASE_URL / DATABASE_DIRECT_URL / DATABASE_PRIVILEGED_URL — Supabase pooler + direct connections

These three URLs share one **pooler password** (the Postgres role
that all three URLs authenticate as) on managed Supabase. Rotating
the pooler password rotates all three URLs together; you cannot
rotate one without the others. The `panorama_app` role password
(`DATABASE_APP_PASSWORD`) is independent — see the next section.

### When to rotate

| Trigger | Path |
|---|---|
| Suspected leak of `.env` or Fly secrets dump | **Path A — emergency** below |
| Quarterly hygiene | **Path B — routine** below |
| Supabase support rotated it for you (regional incident, account compromise) | The change is already done provider-side; only the Panorama-side `fly secrets set` is left |

### Path A — Emergency rotation

Rotation on Supabase managed Postgres is **not zero-downtime**:
every connection in the pool must reconnect under the new password.
For a single-replica Community deployment this is a 5-10s blip; for
a Fly multi-replica it's a rolling-deploy window.

```bash
# 1. Supabase dashboard → Project Settings → Database → "Reset
#    database password". Capture the new pooler URL (a single string
#    that contains the password and the hostname); the form gives
#    you the pooler URL (port 6543) and the direct URL (port 5432).
#
# 2. Locally regenerate the .env.staging from the new pooler URL:
./scripts/setup-staging-env.sh

# 3. Push to Fly:
fly secrets set --app panorama-staging \
    DATABASE_URL="$NEW_POOLER_URL" \
    DATABASE_DIRECT_URL="$NEW_DIRECT_URL" \
    DATABASE_PRIVILEGED_URL="$NEW_DIRECT_URL"
# `fly secrets set` triggers an automatic redeploy; for rolling
# behavior add `--stage` then `fly deploy --strategy rolling`.

# 4. Watch the rolling deploy until every instance reports healthy.
fly status --app panorama-staging
```

### Path B — Routine rotation

Identical commands to Path A. The difference is **timing**: schedule
during a low-traffic window (UTC weekend graveyard), pre-announce in
the status page (once it exists per Round 7 §9), and have the
Supabase dashboard tab open in a second browser before issuing the
reset.

### Blast radius

- **5-10 second connection-pool blip** as Prisma's pool drops the
  old connections and dials new ones. In-flight requests fail with
  `PrismaClientKnownRequestError: P1017 (Server has closed the
  connection)` and the client retries; the user sees a 503 if the
  retry budget exhausts.
- **BullMQ workers** (invitation email, tenant export, photo
  thumbnailer) reconnect on the next job pick; queued jobs
  back-pressure during the window. No job loss — BullMQ holds the
  job in Redis until a worker acks it.
- **Migration tooling** (`pnpm migrate deploy`) uses
  `DATABASE_DIRECT_URL`; if a migration is mid-flight during
  rotation, the migration may fail mid-statement. **Do not rotate
  during a migration apply.** Cross-reference `apply-migrations.sh`
  output to confirm a clean state before issuing the reset.

### Verification

```bash
# Health endpoint returns 200 + DB-reachable
curl -fsSL https://api.panorama.example/health | jq

# Confirm prisma can read after rotation
fly ssh console --app panorama-staging \
    --command "node -e 'require(\"/app/node_modules/@prisma/client\").PrismaClient().auditEvent.count().then(c => console.log(c))'"
```

### Rollback

If the new pooler password is wrong or Panorama cannot reach the
new pooler URL, restore the previous secrets:

```bash
fly secrets set --app panorama-staging \
    DATABASE_URL="$OLD_POOLER_URL" \
    DATABASE_DIRECT_URL="$OLD_DIRECT_URL" \
    DATABASE_PRIVILEGED_URL="$OLD_DIRECT_URL"
```

…then re-issue the Supabase reset to get back to a state where
Panorama can authenticate. If the OLD value was never captured, the
recovery path is "have Supabase reset the password to a known value
via support ticket".

## DATABASE_APP_PASSWORD — panorama_app role password

The `panorama_app` Postgres role (per ADR-0013) is the role
Panorama's runtime connects as. Its password rotates independently
of the Supabase pooler password — pooler authenticates as the
Supabase-provided role, then Panorama's runtime authenticates as
`panorama_app` via the connection string in `DATABASE_URL` after
the pooler hands off.

### Procedure

```bash
# 1. Generate new app-role password.
NEW=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")

# 2. Connect to the DB as the privileged role (Supabase dashboard
#    SQL editor, or psql on $DATABASE_PRIVILEGED_URL):
psql "$DATABASE_PRIVILEGED_URL" \
    -c "ALTER ROLE panorama_app WITH PASSWORD '$NEW'"

# 3. Update the env on Fly:
fly secrets set --app panorama-staging \
    DATABASE_APP_PASSWORD="$NEW" \
    DATABASE_URL="postgres://panorama_app:$NEW@$POOLER_HOST:6543/postgres?schema=public"
# (DATABASE_URL embeds the password inline; you must update both
# values atomically. DATABASE_DIRECT_URL and DATABASE_PRIVILEGED_URL
# do NOT embed the app-role password — they authenticate as the
# Supabase pooler role and the panorama_super_admin role
# respectively. Don't update them here.)

# 4. Rolling deploy.
fly deploy --strategy rolling --app panorama-staging
```

### Blast radius

- **No connection-pool blip** if you set the secret + redeploy in
  one `fly secrets set` call (the new password takes effect on the
  next pool connect, and the rolling deploy issues fresh
  connections).
- **Pool of in-flight requests** authenticated under the old
  password continue to work until their connection is recycled.
  Prisma's idle-connection recycler closes them within
  `connection_limit` cycles; no manual intervention needed.
- **`bootstrap.sql` and `apply-migrations.sh`** do not use the app
  role, so migration tooling is unaffected.

### Verification

```bash
# 1. New connections authenticate.
fly ssh console --app panorama-staging \
    --command "psql \$DATABASE_URL -c 'SELECT current_user'"
# Expected output: current_user = panorama_app

# 2. RLS still works as expected (panorama_app should NOT bypass).
fly ssh console --app panorama-staging \
    --command "psql \$DATABASE_URL -c 'SHOW row_security'"
# Expected output: row_security = on
```

### Rollback

```bash
psql "$DATABASE_PRIVILEGED_URL" \
    -c "ALTER ROLE panorama_app WITH PASSWORD '$OLD'"
fly secrets set --app panorama-staging \
    DATABASE_APP_PASSWORD="$OLD" \
    DATABASE_URL="postgres://panorama_app:$OLD@$POOLER_HOST:6543/postgres?schema=public"
```

## OIDC_GOOGLE_CLIENT_SECRET / OIDC_MICROSOFT_CLIENT_SECRET — IdP credentials

These secrets authenticate Panorama to the Identity Provider during
the OIDC authorization-code exchange. A leak does NOT give the
attacker direct access to tenant data — they would need a valid
authorization code from a real user's IdP login on the same
deployment's callback URL. The threat is **token forgery against
this Panorama deployment specifically** + the operator's IdP-side
client identity.

### When to rotate

| Trigger | Path |
|---|---|
| Suspected leak | Emergency path; the procedure is the same as routine but the IdP-side revoke step must precede the Panorama-side set step |
| IdP-driven rotation (Google or Microsoft expiring the secret on schedule, common for Microsoft Entra) | Routine path; the IdP gives you a window with both secrets active |
| Quarterly hygiene | Routine path |

### Procedure

```bash
# 1. At the IdP — Google Cloud Console (Google) or Azure portal
#    "App registrations" → "Certificates and secrets" (Microsoft).
#    Issue a new client secret. Both providers let you create the
#    new secret BEFORE revoking the old one (preferred for routine
#    rotation; both secrets are accepted during the window).
#
#    Microsoft displays the secret VALUE only once; capture it
#    immediately into your secret manager before navigating away.
#    Google shows it indefinitely under the OAuth client.

# 2. Push the new secret to Fly:
fly secrets set --app panorama-staging \
    OIDC_GOOGLE_CLIENT_SECRET="$NEW_GOOGLE_SECRET"
# (or OIDC_MICROSOFT_CLIENT_SECRET for the Microsoft side)

# 3. Wait for the rolling deploy to complete:
fly status --app panorama-staging

# 4. At the IdP — revoke the OLD secret. From this point forward,
#    only the new secret is accepted by the IdP for token exchange.
#    Order matters: revoking before Panorama has the new secret in
#    effect breaks every in-flight OIDC dance.
```

### Blast radius

- **In-flight OIDC dances** (a user mid-login) running against the
  old secret fail at the token-exchange step. They retry the login
  and succeed under the new secret. UX: one extra "log in" click,
  no data loss.
- **Active sessions** are unaffected. OIDC client secrets are used
  only at the initial auth code → token exchange; session cookies
  are minted by Panorama from that token, not by the IdP. Existing
  cookies stay valid until `SESSION_MAX_AGE_SECONDS`.
- **Per-tenant trust:** the OIDC client is configured against the
  hosted-instance callback URL (and any sister self-host URLs). A
  rotation does NOT change the client ID, so trust at the IdP-side
  consent screen + admin-side approved-clients list is preserved.

### Verification

```bash
# 1. Trigger a fresh login from a clean browser:
#    Open https://panorama.example/login → click Google → consent →
#    callback should succeed. Confirm a session cookie is issued.
#
# 2. Check that the audit log emitted the login event:
psql "$DATABASE_PRIVILEGED_URL" \
    -c "SELECT id, action, occurredAt FROM audit_events
        WHERE action = 'panorama.auth.session_started'
        ORDER BY id DESC LIMIT 5"
```

### Rollback

Re-set the old secret in Fly + at the IdP (don't revoke the OLD
secret in step 4 above if you're not confident the new one works
end-to-end). Restore the previous active client on Google/Microsoft.

## S3_ACCESS_KEY / S3_SECRET_KEY — object storage credentials

S3-compatible object storage credentials (Cloudflare R2 in
production, MinIO in dev). A leak of these credentials gives the
holder read/write access to the bucket(s) listed in `S3_BUCKET_PHOTOS`
(and any sister buckets the credential was scoped to). The threat
is **bucket-scope confidentiality + integrity**, not session
forgery or DB access.

### When to rotate

| Trigger | Path |
|---|---|
| Suspected leak | Emergency path; provider-side revoke before Panorama-side set |
| Quarterly hygiene | Routine path; both keys active during the rolling deploy |
| Bucket migration (changing buckets / providers) | Routine path for the new credentials; the OLD credentials may be retired immediately after migration is verified |

### Procedure

```bash
# 1. At Cloudflare R2 → API Tokens → "Create R2 API token". Scope
#    the new token to the same buckets and permissions as the
#    current token. Capture the access-key-id + secret pair (the
#    secret is shown ONCE).
#
#    (AWS S3 equivalent: IAM → Users → security credentials →
#    "Create access key". For other providers: their equivalent
#    flow.)

# 2. Push the new credentials to Fly:
fly secrets set --app panorama-staging \
    S3_ACCESS_KEY="$NEW_ACCESS_KEY" \
    S3_SECRET_KEY="$NEW_SECRET_KEY"

# 3. Wait for the rolling deploy:
fly status --app panorama-staging

# 4. At Cloudflare R2 (or your provider) — revoke the OLD token.
```

### Blast radius

- **Existing pre-signed URLs minted under the OLD credential
  continue to work until their TTL expires** — the URL embeds the
  signature, which is bound to the credential that minted it. Photo
  download URLs default to `signedUrlTtlSeconds` (typically 60s) per
  `apps/core-api/src/modules/object-storage/object-storage.service.ts:237-249`;
  tenant-export download URLs run up to 24h per ADR-0020 §8.
  Driver phones with a cached presigned URL keep working until that
  TTL ticks down.
- **NEW pre-signed URLs minted post-rotation** require the new
  credentials to be live; the rolling deploy is the boundary. A
  driver's photo upload in-flight at the moment of rotation fails
  with `SignatureDoesNotMatch` and the client retries — UX: one
  extra "tap to retry" click.
- **No data loss.** The bucket and its contents are unaffected by
  credential rotation. You're rotating *access*, not *data*.

### Verification

```bash
# 1. Upload a test photo via the staging app (driver login → asset
#    detail → camera capture → upload) and confirm it lands in R2.
#
# 2. Fetch a download URL and confirm it serves the bytes:
fly ssh console --app panorama-staging \
    --command "curl -fsSL '$DOWNLOAD_URL' | head -c 16 | xxd"
# Expected: JPEG magic bytes ffd8ffe0
#
# 3. Check the audit chain for any S3-related operational errors
#    emitted during the rotation window:
psql "$DATABASE_PRIVILEGED_URL" \
    -c "SELECT id, action, metadata FROM audit_events
        WHERE action LIKE 'panorama.object_storage.%'
        AND occurredAt >= NOW() - INTERVAL '1 hour'
        ORDER BY id DESC"
```

### Rollback

```bash
fly secrets set --app panorama-staging \
    S3_ACCESS_KEY="$OLD_ACCESS_KEY" \
    S3_SECRET_KEY="$OLD_SECRET_KEY"
```

If the OLD token was already revoked at the provider, you must
issue a third (fresh) token and use that — there is no way to
un-revoke an R2 token. Document the rollback path explicitly in
your incident notes so the next operator knows the original token
is dead.

## SMTP_USER / SMTP_PASSWORD — outbound email credentials

The Panorama runtime sends invitation + notification + tenant-export
completion emails through these credentials. A leak gives the holder
the ability to send email *from* the Panorama deployment's verified
sender domain — a spam / phishing risk to the operator's reputation,
not a data exfiltration risk.

### When to rotate

| Trigger | Path |
|---|---|
| Suspected leak | Emergency path; provider-side revoke before Panorama-side set |
| Quarterly hygiene | Routine path |
| Provider-driven (SendGrid API key expiry, Postmark token reissue) | Routine path; pair both old + new for the cutover window |

### Procedure

```bash
# 1. At the SMTP provider (Mailgun / SendGrid / SES / Postmark /
#    Resend / etc.) — issue a new credential. Naming convention is
#    provider-specific:
#    - SES: IAM access keys → SMTP credentials
#    - SendGrid: API Keys → "Mail Send" scope
#    - Postmark: Server tokens → new server token
#    - Resend: API Keys → "Sending access"
#    Capture the new SMTP_USER + SMTP_PASSWORD values.

# 2. Push to Fly:
fly secrets set --app panorama-staging \
    SMTP_USER="$NEW_SMTP_USER" \
    SMTP_PASSWORD="$NEW_SMTP_PASSWORD"

# 3. Wait for rolling deploy:
fly status --app panorama-staging

# 4. Revoke the OLD credentials at the provider.
```

### Blast radius

- **In-flight email sends fail** during the rolling deploy with a
  provider-specific 535 auth error. The BullMQ retry queue picks
  them up with the new credentials on the next attempt; emails are
  delayed by the retry-backoff (default 2-5 minutes), not lost.
  The `notification_events` table tracks delivery status so the
  operator can see the retry chain.
- **Sender-domain trust** is unaffected — SPF, DKIM, DMARC are
  domain-level records that don't change with SMTP credential
  rotation. Recipients' deliverability is unchanged.

### Verification

```bash
# 1. Trigger a test email via the invitation flow or a staging
#    re-send of the most recent notification:
fly ssh console --app panorama-staging \
    --command "node /app/scripts/smoke-staging-seed.ts --send-test-email"
# (Or trigger a real invitation via the app to a known-good
# recipient.)

# 2. Confirm the notification queue drained any backed-up events:
psql "$DATABASE_PRIVILEGED_URL" \
    -c "SELECT id, status, COUNT(*) FROM notification_events
        WHERE occurredAt >= NOW() - INTERVAL '1 hour'
        GROUP BY id, status"
# Expected: a row for status = DISPATCHED matching the post-rotation
# count; status = DEAD only if a permanent failure (not a transient
# auth error).

# 3. Check MailHog (dev) / inbox (prod) for the test email.
```

### Rollback

```bash
fly secrets set --app panorama-staging \
    SMTP_USER="$OLD_SMTP_USER" \
    SMTP_PASSWORD="$OLD_SMTP_PASSWORD"
```

If the OLD credentials were already revoked at the provider, the
recovery path is "issue a third (fresh) credential at the provider
+ set that one". As with S3, document the dead OLD credentials in
your incident notes.

## REDIS_URL — Upstash connection URL

The Redis connection URL embeds the access token in the userinfo
portion: `rediss://default:<TOKEN>@<endpoint>:6379`. A leak of the
URL leaks the token. The threat is **rate-limiter bypass + BullMQ
job tampering** — both have downstream blast radius (signup-flood
defenses dropped, queued tenant exports inspectable) but neither is
DB-level confidentiality.

### Procedure

```bash
# 1. At Upstash dashboard → REST → reset token. The dashboard
#    issues a new URL; the OLD URL is invalidated server-side at
#    the moment the new one is created (Upstash does NOT support
#    a transition window).

# 2. Push to Fly:
fly secrets set --app panorama-staging \
    REDIS_URL="$NEW_REDIS_URL"
```

### Blast radius

- **Brief auth errors** during the rolling deploy as BullMQ workers
  reconnect and rate-limiter clients re-handshake. Per
  [`secrets-inventory.md`](./secrets-inventory.md) §Redis: "BullMQ
  workers will see auth errors briefly. This is expected; the
  rolling deploy resolves it within the deploy window."
- **Rate-limiter fail-closed:** sliding-window rate-limiters
  configured to fail-closed on Redis outage (per ADR-0020 §4) will
  reject signup attempts during the rotation window. Acceptable
  for a 5-10s blip; not acceptable if the deploy stalls. Watch the
  status surface during rotation.
- **In-flight BullMQ jobs:** held in Redis until a worker acks;
  the new Redis token sees the same Redis instance (Upstash only
  rotates the *token*, not the underlying instance), so the jobs
  are visible to the post-rotation worker.

### Verification

```bash
# 1. Health endpoint reports Redis OK:
curl -fsSL https://api.panorama.example/health | jq .redis
# Expected: { "ok": true }

# 2. A queued background job processes (best path: trigger an
#    invitation send, observe NotificationEvent status flip from
#    PENDING to DISPATCHED within a minute):
psql "$DATABASE_PRIVILEGED_URL" \
    -c "SELECT id, status, occurredAt FROM notification_events
        WHERE occurredAt >= NOW() - INTERVAL '5 minutes'
        ORDER BY id DESC LIMIT 10"
```

### Rollback

```bash
fly secrets set --app panorama-staging \
    REDIS_URL="$OLD_REDIS_URL"
```

The OLD URL is invalid post-rotation; you must issue a third token
at Upstash to recover if the new URL doesn't work. Document the
dead OLD credentials.

## SENTRY_DSN — error reporting endpoint

Per [ADR-0018](../adr/0018-observability-stack.md), Sentry is
**opt-in**: unset → no-op, set → Sentry initializes. The DSN is
**quasi-secret** — a leak does not give the holder access to your
event data, but it does let them spam your project's quota with
fake events (a soft denial-of-quality, not a confidentiality
breach).

### Procedure

```bash
# 1. At sentry.io → Project Settings → Client Keys (DSN) → Create
#    New Key. The new DSN is shown on creation; capture it.

# 2. Push to Fly:
fly secrets set --app panorama-staging \
    SENTRY_DSN="$NEW_SENTRY_DSN"

# 3. Wait for rolling deploy.

# 4. At sentry.io — revoke (delete) the OLD client key.
```

### Blast radius

- **Briefly missed events** during the rolling deploy as the SDK
  re-initializes. Acceptable trade-off; the SDK buffers in-flight
  events for `BUFFER_DEPTH` seconds (default 30s) and flushes them
  on shutdown. The post-rotation worker picks up event reporting
  with the new DSN.
- **No effect on tenants or end users.** Sentry reporting is
  observational; it never gates a request or alters response
  behavior.

### Verification

```bash
# 1. Trigger an intentional error and confirm it lands in Sentry
#    under the NEW key:
fly ssh console --app panorama-staging \
    --command "curl -X POST https://api.panorama.example/_test/sentry"
# (If no test endpoint exists, the next real 5xx will surface in
# Sentry; check the Issues panel.)

# 2. Confirm the OLD key has stopped receiving events: in Sentry,
#    view the deleted-key event history. Should taper to zero
#    within 30s of the rotation window.
```

### Rollback

Restore the old DSN in Fly:

```bash
fly secrets set --app panorama-staging \
    SENTRY_DSN="$OLD_SENTRY_DSN"
```

If the OLD DSN was already deleted at Sentry, re-create it (Sentry
supports up to 5 client keys per project; deleting a key removes
it but a new key can take its place). Note the rotation in Sentry's
audit log if the project has it enabled.

## TURNSTILE_SECRET — Cloudflare Turnstile (self-serve signup CAPTCHA)

Per [ADR-0020 §5](../adr/0020-self-serve-signup.md). Consumed
**only when `FEATURE_SELF_SERVE_SIGNUP=true`**. Self-hosts that
keep the signup flag off can rotate or omit `TURNSTILE_SECRET`
without effect.

A leak of the secret lets the holder verify Turnstile tokens
against Cloudflare's API on the operator's behalf — there is no
data exfiltration risk; the threat is **signup-protection bypass**
(an attacker scripting against the leaked secret can verify their
own captcha tokens locally without ever interacting with the
human-facing CAPTCHA widget).

### Procedure

```bash
# 1. At Cloudflare dashboard → Turnstile → your site → Settings →
#    rotate secret key. Cloudflare keeps the prior secret valid
#    briefly during rotation; the dashboard shows the exact window.

# 2. Push to Fly:
fly secrets set --app panorama-hosted \
    TURNSTILE_SECRET="$NEW_TURNSTILE_SECRET"

# 3. Wait for rolling deploy.

# 4. At Cloudflare — revoke the OLD secret after the rolling deploy
#    completes.
```

### Blast radius

- **In-flight signup attempts** mid-CAPTCHA-verification (between
  the widget completing and Panorama's siteverify POST) fail their
  CAPTCHA verification. UX: the user re-tries from the homepage form;
  Cloudflare issues them a fresh challenge. Per ADR-0020 §5's
  constant-latency 400 envelope, the failure is indistinguishable
  from a normal rate-limit trip.
- **Signup endpoint refuses to start without the secret** when
  `FEATURE_SELF_SERVE_SIGNUP=true` (boot guard in
  `apps/core-api/src/modules/signup/signup.config.ts:44-48`). A
  rolling deploy that pushes the new secret to only some replicas
  results in the secret-missing replicas refusing to boot — an
  obvious failure mode caught by the rolling deploy's health
  checks. Same-secret-on-all-replicas is the only viable steady
  state.

### Verification

```bash
# 1. Submit a real signup from a fresh browser on the homepage
#    form. Confirm Cloudflare's widget renders, the user completes
#    the challenge, and the signup proceeds (or fails for unrelated
#    reasons — e.g., domain restrictions).

# 2. Check the audit log for the signup attempt:
psql "$DATABASE_PRIVILEGED_URL" \
    -c "SELECT id, action, occurredAt FROM audit_events
        WHERE action LIKE 'panorama.signup.%'
        AND occurredAt >= NOW() - INTERVAL '10 minutes'
        ORDER BY id DESC"
```

### Rollback

```bash
fly secrets set --app panorama-hosted \
    TURNSTILE_SECRET="$OLD_TURNSTILE_SECRET"
```

If the OLD secret was already revoked at Cloudflare, signup is
broken until you generate a fresh secret. Self-hosters can
temporarily disable the signup endpoint by setting
`FEATURE_SELF_SERVE_SIGNUP=false` while they work the recovery.

## Cross-cutting concerns

### Integration with the restore drill

Once `docs/runbooks/restore.md` lands in Round 6 PR2, the restore
drill will exercise a full reconstitution from a database backup
into a clean environment. Rotation procedures interact with the
drill in two places:

- **Pre-drill:** the drill scenario assumes the secrets in the
  restore target are *fresh* (rotated at restore time, not copied
  from production). The drill's setup step issues new credentials
  for each secret class, not because production rotation is
  required, but because the restored environment must be sealed
  from production traffic by construction.
- **Post-drill:** the drill's verification step asserts that all
  per-secret rotation procedures still pass. A drift between this
  runbook and the actual platform UIs (Supabase reset password
  moving locations, Cloudflare R2 token form re-shaped) gets caught
  during the quarterly drill.

`restore.md` will cross-reference this runbook for each per-secret
step. Until `restore.md` lands, treat this section as a forward
reference.

### Multi-replica rolling-deploy hazards

Two failure modes recur across the secrets in this runbook:

1. **Partial rollout state.** Some replicas have the new secret;
   some still have the old. Symptoms differ per secret:
   - SESSION_SECRET: silent logout for users routed to old
     replicas.
   - DATABASE_*: connection-pool errors on the old replicas.
   - OIDC: in-flight token exchanges fail on old replicas.
   - Sentry / Turnstile: silent drift (events to the wrong project;
     CAPTCHA tokens reject).
2. **Failed health check on new secret.** The new value is wrong
   (typo, truncated, wrong-secret-paste). The rolling deploy halts
   at the first failing instance and rolls back; the running
   instances stay on the OLD value, so traffic is unaffected. This
   is the *good* failure mode — `fly deploy` makes it the default.

Best practice: every rotation runs through the rolling deploy +
`/health` check. Never `fly secrets set --stage` then forget to
`fly deploy`.

### Rotation hygiene cadence

Until a managed scheduler exists, rotation cadence depends on the
operator's calendar. Recommended baseline:

| Secret class | Cadence |
|---|---|
| SESSION_SECRET (Path B) | Quarterly |
| DATABASE_APP_PASSWORD | Quarterly |
| Pooler password (DATABASE_URL/DIRECT/PRIVILEGED) | Annually |
| OIDC client secrets | When the IdP forces it (Microsoft Entra: 24 months) |
| S3 access/secret key | Annually |
| SMTP credentials | When the provider forces it |
| REDIS_URL token | Annually |
| SENTRY_DSN | Annually (or after a confirmed leak) |
| TURNSTILE_SECRET | Annually |

A GitHub Actions cron-driven `secrets-rotation-due` issue opener is
a Round 7 follow-up to enforce the cadence. Until it lands, the
operator's `.calendar` is the only schedule.

## Multi-tenant rotation orchestration

Rotating any secret across a fleet of hosted-tenant instances
simultaneously — with audit emission per tenant, scheduled rotation
queues, and per-customer rotation reports — is a managed-service
concern and ships in the **Enterprise edition**. See the
[feature matrix](../en/feature-matrix.md) row 24 (Observability +
managed bundle) for the Community-vs-Enterprise positioning. The
single-tenant procedures above are the Community surface and the
self-hoster contract.

## What this runbook does NOT cover

- **Restore drill execution** — `restore.md` ships in Round 6 PR2.
  Once it lands, follow that runbook for the dump → restore →
  verify cycle. Cross-reference this runbook from there for each
  per-secret refresh.
- **LGPD ANPD notification.** The secret-leak threshold and the
  3-business-day clock live in [`incident.md`](./incident.md)
  Phase 4 §"P0 — Critical". This runbook is the *containment*
  primitive; legal notification is incident.md's job.
- **Secret managers (Vault, Doppler, Infisical).** Self-hosters
  using one substitute their manager's set-secret command for the
  `fly secrets set` step in each procedure; the shape of the
  rotation is unchanged. The choice of secret manager is the
  operator's, not Panorama's.
- **Cloud provider account-level credential rotation** (Cloudflare
  account token, Fly token, AWS account root). Those are platform
  ops outside the Panorama deployment's scope. Rotate per the
  provider's IAM documentation.
- **Hardware security modules / KMS-managed signing.** Out of
  scope for the Community edition; an HSM-integrated rotation
  flow lives behind the Enterprise managed-service surface and is
  not documented here.
- **Physical / device security.** Laptops, hardware tokens, YubiKeys
  used to gate the operator's IdP-side access — handled per the
  operator's security baseline, not via this runbook.
