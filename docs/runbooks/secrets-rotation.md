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
per tenant and a per-customer rotation report) **will ship** in the
**Enterprise edition** — see the [§Multi-tenant rotation
orchestration](#multi-tenant-rotation-orchestration) section at the
end. Today, Panorama is pre-revenue and Community-only; the
Enterprise positioning here is forward-looking, not a feature
present in main.

## Quick navigation

Jump directly to the secret you need to rotate:

- [SESSION_SECRET](#session_secret--iron-session-cookie-encryption-key)
- [DATABASE pooler password](#database_url--database_direct_url--database_privileged_url--supabase-pooler--direct-connections)
- [DATABASE_APP_PASSWORD](#database_app_password--panorama_app-role-password)
- [OIDC client secrets](#oidc_google_client_secret--oidc_microsoft_client_secret--idp-credentials)
- [S3 / R2 credentials](#s3_access_key--s3_secret_key--object-storage-credentials)
- [SMTP credentials](#smtp_user--smtp_password--outbound-email-credentials)
- [REDIS_URL](#redis_url--upstash-connection-url)
- [SENTRY_DSN](#sentry_dsn--error-reporting-endpoint)
- [TURNSTILE_SECRET](#turnstile_secret--cloudflare-turnstile-self-serve-signup-captcha)

Cross-cutting topics:

- [Multi-replica rolling-deploy hazards](#multi-replica-rolling-deploy-hazards)
- [Rotation cadence baseline](#rotation-hygiene-cadence)
- [What this runbook does NOT cover](#what-this-runbook-does-not-cover)

## Decision tree — which path?

| Trigger | Path |
|---|---|
| Suspected leak (committed `.env` file, departing administrator with shell access, accidental log dump, **leaked backup** containing the secret) | **Emergency path** for the leaked secret. Every per-secret section below has a "When to rotate" subtable that calls out the emergency-path variant — typically "revoke OLD at the provider FIRST, then push NEW to Panorama". Accept in-flight failure cost in exchange for closing the leak window. |
| Scheduled rotation (quarterly hygiene per org policy) | **Routine path** for each secret — zero-downtime where the secret supports it (SESSION_SECRET via `_PREVIOUS`), short-window for the rest. |
| Active incident already in [Phase 3 Contain](./incident.md#phase-3--contain) | Follow that phase's decision tree. It dispatches into this runbook per-secret; the entry points there are the section anchors above (§Quick navigation). |
| New self-host bringing up first deployment | No rotation needed — generate fresh values from scratch per [`secrets-inventory.md`](./secrets-inventory.md). |

## Before you start any rotation — capture the OLD value

Every section below assumes you have the OLD secret captured in a
shell variable before you overwrite it. The procedure blocks
default to `OLD_<SECRET>` as the variable name. Capture it FIRST so
you have a rollback target if the new value doesn't work:

```bash
# Pattern — adapt per secret.
OLD_SESSION_SECRET=$(grep '^SESSION_SECRET=' .env | cut -d= -f2-)
[[ -n "$OLD_SESSION_SECRET" ]] || { echo "OLD empty; abort" >&2; exit 1; }
```

For credentials that live on Fly secrets (not `.env`), the OLD
value is NOT recoverable from `fly secrets list` (Fly never
re-exposes a set secret). You MUST capture from your secret-manager
of record (1Password, Vault, Doppler) before issuing the new value.
If you cannot capture the OLD value, treat the rotation as a
**one-shot** — failure means re-issuing fresh credentials at the
provider, not rolling back.

## Shell-history hygiene

Several commands below interpolate secret values into argv (`psql
-c "ALTER ROLE … WITH PASSWORD '$NEW'"`, `DATABASE_URL=...$NEW...
fly secrets set`). Bash history (`$HISTFILE`), shell process
listing (`ps`, `/proc/<pid>/cmdline`), and any eBPF or audit
daemon collect these. Two ways to mitigate:

```bash
# 1. Prefix every secret-bearing command with a leading space and
#    set HISTCONTROL=ignorespace at the top of your shell session:
HISTCONTROL=ignorespace
 psql "$URL_WITH_PASSWORD" -c "ALTER ROLE panorama_app WITH PASSWORD '$NEW'"
# The leading space + HISTCONTROL keeps it out of $HISTFILE.

# 2. Preferred for ALTER ROLE: use the `\password` meta-command in
#    an interactive psql session — never echoed to argv or history:
psql "$DATABASE_PRIVILEGED_URL"
# At the psql prompt:
panorama=# \password panorama_app
# Postgres prompts (hidden input) for the new password.
```

The procedures below show the argv form for copy-paste density; the
`\password` alternative is preferred for production. Per-section
notes flag where the argv form has unavoidable exposure (e.g., the
`DATABASE_URL` string embeds the password and there is no `\` shortcut).

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
[[ -n "$OLD" ]] || { echo "OLD SESSION_SECRET empty; aborting rotation" >&2; exit 1; }
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

**Audit-chain alternative (recommended for non-operators).** The stdout
grep above requires log access; tenant admins reviewing the in-app
audit feed can confirm the same state from the audit chain — the
`panorama.auth.session_secret_rotated` row (#234) is emitted at every
boot when `SESSION_SECRET_PREVIOUS` is set:

```sql
SELECT id, occurred_at, metadata
FROM audit_events
WHERE action = 'panorama.auth.session_secret_rotated'
  AND occurred_at >= now() - interval '1 hour'
ORDER BY occurred_at DESC;
```

Expected: at least one row per replica in the window since the
post-flip restart, each with `metadata = {"rotationActive": true}`.
The row carries `tenantId = NULL` (cluster-wide event) and no secret
values or lengths — only the boolean signal.

Dedup: a restart-heavy day will emit one row per replica per boot, so
the same logical "rotation window active" fact produces N rows in the
operator's window. Filter to the most recent boot fingerprint (or
collapse rows within the deploy's restart-spread window) when
quoting the count to stakeholders. The boot INFO log above is the
operationally cheaper signal when log access exists; this audit row
is for the in-app review path.

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

### Pre-flight — capture OLD

The Supabase pooler password is **NOT recoverable** post-reset
(Supabase replaces it; it never re-exposes the previous value).
Capture the current state into your secret-manager-of-record BEFORE
clicking "Reset" in the Supabase dashboard:

```bash
# Fetch current Fly secrets digest (Fly returns the SHA, never the value):
fly secrets list --app panorama-staging | grep DATABASE_

# The values themselves must come from your secret manager; if not
# stored anywhere, the rotation is one-shot (no rollback). Document
# the rotation in your runbook log so future ops know the previous
# state is gone.

# Capture the local .env.staging if you have one:
OLD_POOLER_URL=$(grep '^DATABASE_URL=' apps/core-api/.env.staging | cut -d= -f2-)
OLD_DIRECT_URL=$(grep '^DATABASE_DIRECT_URL=' apps/core-api/.env.staging | cut -d= -f2-)
: "${OLD_POOLER_URL:?capture OLD before proceeding — no rollback otherwise}"
```

### Path A — Emergency rotation

Rotation on Supabase managed Postgres is **not zero-downtime**:
every connection in the pool must reconnect under the new password.
For a single-replica Community deployment this is a 5-10s blip; for
a Fly multi-replica it's a rolling-deploy window (single-minutes per
replica × replica count).

```bash
# 1. Supabase dashboard → Project Settings → Database → "Reset
#    database password". Capture the new pooler URL (a single string
#    that contains the password and the hostname); the form gives
#    you the pooler URL (port 6543) and the direct URL (port 5432).

# 2. Verify NEW_POOLER_URL + NEW_DIRECT_URL are set in your shell
#    before pushing — `fly secrets set` with an unset variable
#    blanks the secret silently.
: "${NEW_POOLER_URL:?set this from Supabase Reset dialog}"
: "${NEW_DIRECT_URL:?set this from Supabase Reset dialog}"

# 3. Locally regenerate the .env.staging from the new pooler URL:
./scripts/setup-staging-env.sh
# `setup-staging-env.sh` reads NEW_POOLER_URL + NEW_DIRECT_URL from
# your shell and writes apps/core-api/.env.staging. See
# scripts/setup-staging-env.sh for the exact shape.

# 4. Push to Fly:
fly secrets set --app panorama-staging \
    DATABASE_URL="$NEW_POOLER_URL" \
    DATABASE_DIRECT_URL="$NEW_DIRECT_URL" \
    DATABASE_PRIVILEGED_URL="$NEW_DIRECT_URL"
# `fly secrets set` triggers an automatic redeploy; for rolling
# behavior add `--stage` then `fly deploy --strategy rolling`.

# 5. Watch the rolling deploy until every instance reports healthy.
#    "Healthy" = `State` column reads `started` AND `Health Check`
#    column reads `[1/1 passing]` (or higher passing/total ratio
#    for multi-check apps). The `fly status` output shape varies
#    by CLI version; if uncertain, follow with `fly checks list
#    --app panorama-staging` for the explicit per-check view.
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

### Pre-flight — capture OLD

```bash
OLD_APP_PASSWORD=$(grep '^DATABASE_APP_PASSWORD=' apps/core-api/.env.staging | cut -d= -f2-)
: "${OLD_APP_PASSWORD:?capture OLD before proceeding — no rollback otherwise}"
```

### Procedure

> **Shell-history hygiene.** The `psql -c "ALTER ROLE … '$NEW'"`
> form below interpolates the new password into argv. Either
> (a) prefix every line with a leading space + set
> `HISTCONTROL=ignorespace` at session start, OR (b) issue the
> ALTER inside an interactive `psql` session via `\password
> panorama_app` (preferred — no echo, no argv exposure). See the
> §Shell-history hygiene section at the top of this runbook.

```bash
# 1. Generate new app-role password.
NEW=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
: "${NEW:?random generation failed — abort}"

# 2. Connect to the DB as the privileged role and rotate.
#    Preferred: interactive \password (no argv echo).
#    Fallback: -c form, requires HISTCONTROL=ignorespace + leading space.
 psql "$DATABASE_PRIVILEGED_URL" -c "ALTER ROLE panorama_app WITH PASSWORD '$NEW'"

# 3. Update the env on Fly.
#    : "${POOLER_HOST:?set to your Supabase pooler hostname}" — the host
#    portion comes from the Supabase dashboard's Connection Pooler
#    section. Treat this command as the bottleneck: both lines must
#    succeed atomically or the next deploy boots with a stale
#    DATABASE_URL embedding the OLD password.
: "${POOLER_HOST:?set POOLER_HOST first}"
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

- **Single-replica Community deploy:** "No connection-pool blip" if
  you set the secret + redeploy in one `fly secrets set` call. The
  new password takes effect on the next pool connect; the rolling
  deploy issues fresh connections.
- **Multi-replica Fly deploys:** `ALTER ROLE` is immediate at the
  DB. Replicas not yet redeployed during the rolling deploy will
  exhaust their pool with auth failures within `connection_limit`
  cycles (default 10 connections; Prisma recycles on auth-failure).
  Use `fly deploy --strategy rolling` and accept the same per-replica
  blip as the §DATABASE pooler section above (single-minutes per
  replica × replica count).
- **In-flight requests** authenticated under the old password
  continue to work until their connection is recycled. No manual
  intervention needed.
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

# 3. Confirm the rotation landed in the audit trail.
psql "$DATABASE_PRIVILEGED_URL" -c \
  "SELECT id, action, \"occurredAt\" FROM audit_events
   WHERE action LIKE 'panorama.role.%'
   AND \"occurredAt\" >= NOW() - INTERVAL '15 minutes'
   ORDER BY id DESC LIMIT 10"
# Note: there is no audit-action emitted for ALTER ROLE today —
# rotation events at the DB role layer are not yet wired into the
# audit chain. The query above will return zero rows; the empty
# result IS the current expected output. Track the gap in
# panorama-issues #235 follow-up.
```

### Rollback

```bash
: "${OLD_APP_PASSWORD:?cannot rollback — OLD was not captured pre-flight}"
 psql "$DATABASE_PRIVILEGED_URL" -c "ALTER ROLE panorama_app WITH PASSWORD '$OLD_APP_PASSWORD'"
fly secrets set --app panorama-staging \
    DATABASE_APP_PASSWORD="$OLD_APP_PASSWORD" \
    DATABASE_URL="postgres://panorama_app:$OLD_APP_PASSWORD@$POOLER_HOST:6543/postgres?schema=public"
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

| Trigger | Path A or B |
|---|---|
| Suspected leak | **Path A — emergency**: revoke the OLD secret at the IdP FIRST (accept the in-flight-failure cost), THEN set NEW + deploy. The leak window closes immediately at revoke. |
| IdP-driven rotation (Google or Microsoft expiring the secret on schedule, common for Microsoft Entra) | **Path B — routine**: create NEW at IdP first (both secrets active per provider), set NEW on Fly + deploy, then revoke OLD at the IdP. |
| Quarterly hygiene | **Path B — routine** |

### Procedure (Path B — routine, both-secrets-active window)

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

# 2. Verify NEW_*_SECRET is set in your shell before pushing.
:  "${NEW_GOOGLE_SECRET:?capture from Google Cloud Console first}"
# (or NEW_MICROSOFT_SECRET for the Microsoft side)

# 3. Push the new secret to Fly:
fly secrets set --app panorama-staging \
    OIDC_GOOGLE_CLIENT_SECRET="$NEW_GOOGLE_SECRET"

# 4. Wait for the rolling deploy to complete:
fly status --app panorama-staging
# Wait for `State = started` + `Health Check = [N/N passing]` on
# every instance before continuing.

# 5. At the IdP — revoke the OLD secret. From this point forward,
#    only the new secret is accepted by the IdP for token exchange.
#    Order matters: revoking before Panorama has the new secret in
#    effect breaks every in-flight OIDC dance.
```

### Procedure (Path A — emergency, leak-closing variant)

```bash
# 1. At the IdP — revoke the OLD client secret IMMEDIATELY. From
#    this moment, in-flight OIDC dances (users mid-login) fail at
#    the token-exchange step.
# 2. Generate a new secret at the same IdP.
# 3. Push to Fly (steps 2-4 of Path B above).
```

### Blast radius

- **Path B in-flight OIDC dances** (a user mid-login) running
  against the old secret fail at the token-exchange step ONLY in
  the gap between the IdP revoking OLD and the rolling deploy
  reaching the user's replica. Typical window: seconds. The user
  retries the login and succeeds under the new secret. UX: one
  extra "log in" click, no data loss.
- **Path A** widens that window to the rolling-deploy window
  (single-minutes per replica). Every in-flight login during the
  window fails; the user retries once the new secret is live.
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
# 2. Check that the audit log emitted the login event.
#    NOTE: do NOT expand the SELECT with `*` or `metadata` — the
#    audit `metadata` JSONB on session-started rows holds IP and
#    user-agent (per AuditEventInput); pulling it into operator
#    scrollback exposes PII unnecessarily.
psql "$DATABASE_PRIVILEGED_URL" \
    -c "SELECT id, action, \"occurredAt\" FROM audit_events
        WHERE action = 'panorama.auth.session_started'
        ORDER BY id DESC LIMIT 5"
```

### Rollback

Re-set the old secret in Fly + at the IdP (don't revoke the OLD
secret in step 5 above if you're not confident the new one works
end-to-end). Restore the previous active client on Google/Microsoft.

## S3_ACCESS_KEY / S3_SECRET_KEY — object storage credentials

S3-compatible object storage credentials (Cloudflare R2 in
production, MinIO in dev). A leak of these credentials gives the
holder read/write access to the bucket(s) listed in `S3_BUCKET_PHOTOS`
(and any sister buckets the credential was scoped to). The threat
is **bucket-scope confidentiality + integrity**, not session
forgery or DB access.

### When to rotate

| Trigger | Path A or B |
|---|---|
| Suspected leak | **Path A — emergency**: revoke OLD at the provider FIRST. The provider invalidates every signature bound to the OLD credential immediately on revoke — in-flight photo downloads/uploads on driver phones fail. Accept this; the OLD credential is in attacker hands. |
| Quarterly hygiene | **Path B — routine**: create NEW, push to Fly, deploy, then revoke OLD. Both credentials active during the rolling deploy. |
| Bucket migration (changing buckets / providers) | Path B for the new credentials; the OLD credentials may be retired immediately after migration is verified |

### Procedure (Path B — routine)

```bash
# 1. At Cloudflare R2 → API Tokens → "Create R2 API token". Scope
#    the new token to the same buckets and permissions as the
#    current token. Capture the access-key-id + secret pair (the
#    secret is shown ONCE).
#
#    (AWS S3 equivalent: IAM → Users → security credentials →
#    "Create access key". For other providers: their equivalent
#    flow.)

# 2. Verify NEW vars are set in your shell.
: "${NEW_ACCESS_KEY:?capture from R2 dashboard first}"
: "${NEW_SECRET_KEY:?capture from R2 dashboard first}"

# 3. Push the new credentials to Fly:
fly secrets set --app panorama-staging \
    S3_ACCESS_KEY="$NEW_ACCESS_KEY" \
    S3_SECRET_KEY="$NEW_SECRET_KEY"

# 4. Wait for the rolling deploy:
fly status --app panorama-staging

# 5. At Cloudflare R2 (or your provider) — revoke the OLD token.
#    From this moment, every signature bound to OLD is rejected
#    (see Blast radius below).
```

### Procedure (Path A — emergency)

```bash
# 1. At Cloudflare R2 — revoke the OLD token IMMEDIATELY.
#    Every signed URL minted under OLD is now invalid; in-flight
#    photo upload + download requests fail with SignatureDoesNotMatch.
# 2. Create a NEW token (steps 1-4 of Path B above).
# 3. Push to Fly + deploy.
```

### Blast radius

- **Existing pre-signed URLs are invalidated immediately when the
  OLD credential is revoked at the provider.** R2 / S3 reject any
  SigV4 signature bound to a revoked access-key regardless of the
  URL's `X-Amz-Expires` TTL. During Path B's "both-credentials-active"
  window (step 3 deploy → step 5 revoke), URLs minted under OLD
  continue to work. After step 5 revoke, they are dead. This
  differs from the SESSION_SECRET model, where the cookie payload
  carries its own state and the SECRET only matters at decode time.
- **Pre-signed URL TTLs in Panorama today:**
  - Photo download URLs default to `signedUrlTtlSeconds` (typically
    60s) per `apps/core-api/src/modules/object-storage/object-storage.service.ts:237-249`
    (thumbnails 60s; full-size per config).
  - Tenant-export download URLs are **60s** per
    `apps/core-api/src/modules/tenant-export/tenant-export.config.ts:35`
    (`downloadUrlTtlSeconds`). The 24h figure in ADR-0020 §8 is the
    **job download window** (the period during which the Owner can
    request a fresh 60s URL via `/exports/:jobId/download`),
    NOT the URL TTL. The runbook previously conflated the two; do
    not rely on a 24h-presigned-URL claim.
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
#    : "${DOWNLOAD_URL:?obtain from staging app photo viewer first}"
fly ssh console --app panorama-staging \
    --command "curl -fsSL '$DOWNLOAD_URL' | head -c 16 | xxd"
# Expected: JPEG magic bytes ffd8ffe0
#
# 3. Confirm no S3-presigned-failure errors emitted during rotation.
#    There is no `panorama.object_storage.*` audit-action namespace
#    in the codebase as of 2026-05-17; the verification surface is
#    Sentry-side (per ADR-0018) — confirm via the Sentry dashboard
#    that no `object_storage_presign_failed` events arrived during
#    the rotation window.
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

| Trigger | Path A or B |
|---|---|
| Suspected leak (provider credential confirmed compromised) | **Path A — emergency**: revoke OLD at the provider FIRST. In-flight email sends fail until the rolling deploy completes; BullMQ holds the failed jobs in Redis and retries them under the new credentials. |
| Quarterly hygiene | **Path B — routine**: create NEW at provider, push to Fly + deploy, then revoke OLD. Both credentials active during the rolling deploy. |
| Provider-driven (SendGrid API key expiry, Postmark token reissue) | Path B — routine; pair both old + new for the cutover window |

### Procedure (Path B — routine)

```bash
# 1. At the SMTP provider (Mailgun / SendGrid / SES / Postmark /
#    Resend / etc.) — issue a new credential. Naming convention is
#    provider-specific:
#    - SES: IAM access keys → SMTP credentials
#    - SendGrid: API Keys → "Mail Send" scope
#    - Postmark: Server tokens → new server token
#    - Resend: API Keys → "Sending access"
#    Capture the new SMTP_USER + SMTP_PASSWORD values.

# 2. Verify NEW vars are set in your shell.
: "${NEW_SMTP_USER:?capture from provider first}"
: "${NEW_SMTP_PASSWORD:?capture from provider first}"

# 3. Push to Fly:
fly secrets set --app panorama-staging \
    SMTP_USER="$NEW_SMTP_USER" \
    SMTP_PASSWORD="$NEW_SMTP_PASSWORD"

# 4. Wait for rolling deploy:
fly status --app panorama-staging

# 5. Revoke the OLD credentials at the provider.
```

### Procedure (Path A — emergency)

```bash
# 1. At the provider — revoke the OLD credentials IMMEDIATELY.
#    In-flight email sends fail; BullMQ queues the failures.
# 2. Create NEW credentials at the same provider.
# 3. Push to Fly + deploy (steps 2-4 of Path B above).
#    Once the deploy completes, BullMQ retries the queued failures
#    under the new credentials.
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

# 2. Confirm the notification queue drained any backed-up events.
#    The notification_events table uses createdAt (not occurredAt);
#    aggregate by status only — grouping by id would count one per
#    row.
psql "$DATABASE_PRIVILEGED_URL" \
    -c "SELECT status, COUNT(*) FROM notification_events
        WHERE \"createdAt\" >= NOW() - INTERVAL '1 hour'
        GROUP BY status"
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

### When to rotate

| Trigger | Notes |
|---|---|
| Suspected leak | Treat as emergency — Upstash gives no choice; resetting the token invalidates OLD immediately (see Blast radius below). |
| Annual hygiene | Same procedure; schedule during a low-traffic window with pre-announce on the status page. |

> **Upstash has no two-secret window.** Unlike SESSION_SECRET, OIDC,
> S3, or SMTP, you cannot have both OLD and NEW credentials
> simultaneously active. Reset = immediate invalidation. Read the
> Blast radius before scheduling.

### Procedure

```bash
# 1. At Upstash dashboard → REST → reset token. The dashboard
#    issues a new URL; the OLD URL is invalidated server-side at
#    the moment the new one is created. Capture the new URL into
#    your shell immediately — Upstash shows it once.

# 2. Verify the new URL is set.
: "${NEW_REDIS_URL:?capture from Upstash dashboard first}"

# 3. Push to Fly:
fly secrets set --app panorama-staging \
    REDIS_URL="$NEW_REDIS_URL"
# fly deploy --strategy rolling --app panorama-staging is implicit
# in fly secrets set; check `fly status` afterward.
```

### Blast radius

- **Rate-limiter fail-closed window** = the whole rolling-deploy
  window, **not** "5-10s". Per ADR-0020 §4 contract:
  sliding-window rate-limiters fail-closed on Redis outage. From
  the moment Upstash issues the new token (which invalidates OLD)
  until the LAST Fly replica has redeployed with the new URL, any
  replica still on the OLD URL fails its Redis handshake →
  rate-limiter trips → signup attempts + rate-limited paths
  (`/auth/signup`, photo upload throttle, invitation send) reject
  with the standard rate-limit response.
- **Window duration on Fly:** single-minutes per replica × replica
  count. For a 1-replica community deploy: ~30-60s. For a
  3-replica Fly deploy: 2-3 minutes. **Do NOT rotate during a
  marketing push, known traffic spike, or any business-critical
  window.** Pre-announce on the status page (once the page exists
  per Round 7 §9) and target the lowest-traffic window per your
  analytics.
- **In-flight BullMQ jobs:** held in Redis server-side until a
  worker acks. The new Redis token sees the same Redis instance
  (Upstash only rotates the *token*, not the underlying instance),
  so queued jobs are visible to the post-rotation worker once it
  comes up. No job loss.
- **Brief auth errors** during the deploy — expected, per the
  contract above.

### Verification

```bash
# 1. Health endpoint reports Redis OK:
curl -fsSL https://api.panorama.example/health | jq .redis
# Expected: { "ok": true }

# 2. A queued background job processes (best path: trigger an
#    invitation send, observe NotificationEvent status flip from
#    PENDING to DISPATCHED within a minute):
psql "$DATABASE_PRIVILEGED_URL" \
    -c "SELECT id, status, \"createdAt\" FROM notification_events
        WHERE \"createdAt\" >= NOW() - INTERVAL '5 minutes'
        ORDER BY id DESC LIMIT 10"
# Note: notification_events uses createdAt (the row write time),
# not occurredAt — there is no occurredAt column on this table.

# 3. Verify the rate-limiter is back to allow-state:
curl -fsSL -X POST https://api.panorama.example/auth/signup \
     -H "Content-Type: application/json" \
     -d '{"email":"smoke@example.invalid"}' \
     -w "%{http_code}\n" -o /dev/null
# Expected: 400 (invalid email — the request hit the handler, not
# the rate-limiter); a 503 means the rate-limiter is still
# fail-closed.
```

### Rollback

```bash
fly secrets set --app panorama-staging \
    REDIS_URL="$OLD_REDIS_URL"
```

The OLD URL is invalid post-rotation (Upstash invalidated it at
the moment the new one was created); this rollback only works as
a "set the same URL again" if you discover NEW was wrong. If the
NEW URL is genuinely broken (Upstash misconfiguration, network
unreachable), you must issue a third token at Upstash and use that.
Document the dead OLD credentials.

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

# 2. Verify NEW DSN is set.
: "${NEW_SENTRY_DSN:?capture from Sentry dashboard first}"

# 3. Push to Fly:
fly secrets set --app panorama-staging \
    SENTRY_DSN="$NEW_SENTRY_DSN"

# 4. Wait for rolling deploy.

# 5. At sentry.io — revoke (delete) the OLD client key.
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

# 2. Verify NEW secret is set.
: "${NEW_TURNSTILE_SECRET:?capture from Cloudflare dashboard first}"

# 3. Push to Fly:
fly secrets set --app panorama-hosted \
    TURNSTILE_SECRET="$NEW_TURNSTILE_SECRET"

# 4. Wait for rolling deploy.

# 5. At Cloudflare — revoke the OLD secret after the rolling deploy
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
    -c "SELECT id, action, \"occurredAt\" FROM audit_events
        WHERE action LIKE 'panorama.signup.%'
        AND \"occurredAt\" >= NOW() - INTERVAL '10 minutes'
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

| Secret class | Cadence | Why |
|---|---|---|
| SESSION_SECRET (Path B) | Quarterly | Cheapest secret to rotate (zero-downtime via PREVIOUS); high-value target if leaked (every session forge-able); quarterly hygiene is the default for any session-encryption key. |
| DATABASE_APP_PASSWORD | Quarterly | Single-statement DB-side change + rolling deploy; medium-cost rotation. Role-level password compromise blast radius is high (whole runtime auth path); quarterly tracks the SESSION_SECRET cadence by analogy. |
| Pooler password (DATABASE_URL/DIRECT/PRIVILEGED) | Annually | Full connection-pool reset → 5-10s blip on single-replica, single-minutes per replica on Fly. Highest-cost rotation in this runbook. Annual is the right trade-off given the cost: Supabase manages the pooler endpoint; the password is the second factor on top of the pooler ACL. |
| OIDC client secrets | When the IdP forces it (Microsoft Entra: 24 months) | IdP-driven schedule; the IdP itself is the source of truth for expiry. Rotating early gains nothing — the OIDC consent + audit trail is at the IdP. |
| S3 access/secret key | Annually | Bucket-scope blast radius; provider-side revoke is the leak-closing primitive. Annual is conservative; tighten to quarterly if a self-host operator's environment includes other reasons to rotate (PCI/SOC-2 expectations, customer-mandated cadence). |
| SMTP credentials | When the provider forces it | Provider-driven; rotation is operationally expensive (in-flight email-send failures) for low marginal security gain. |
| REDIS_URL token | Annually | Full rate-limiter fail-closed window per rotation (see Blast radius §REDIS); annual is the cost-vs-risk balance. |
| SENTRY_DSN | Annually (or after a confirmed leak) | Quasi-secret; leak threat is event-injection quota spam, not confidentiality. Annual is conservative. |
| TURNSTILE_SECRET | Annually | Same model as Sentry — leak threat is signup-protection bypass, not data exfiltration. Annual is the baseline; tighten on confirmed leak. |

**Why the SESSION_SECRET vs Pooler password asymmetry.** Both
are high-value if leaked, but SESSION_SECRET rotation is
zero-downtime (Path B via `_PREVIOUS`) while Pooler password
rotation is single-minutes of measurable user-visible impact. The
cadence reflects rotation *cost*, not blast radius. If you'd
genuinely rotate Pooler quarterly without measurable cost, do so;
the recommendation is conservative.

**Tracking gap.** A GitHub Actions cron-driven
`secrets-rotation-due` issue opener is a Round 7 follow-up to
enforce the cadence ([panorama-issues#250 — proposed, not yet
filed at session of writing]). Until it lands, the operator's
`.calendar` is the only schedule, and "we forgot to rotate" is a
foreseeable failure mode. Pre-rotation tracking belongs in your
secret manager (1Password / Vault items have rotation-reminder
fields).

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
