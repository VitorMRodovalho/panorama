# Secrets rotation runbook

> **Status — stub.** Round 5 PR3 lands the rotation primitive for
> `SESSION_SECRET` and this short procedure. The full per-secret
> rotation matrix (OIDC client secrets, S3, SMTP, Sentry DSN,
> Turnstile) lands in Round 6 alongside the incident + restore drill.
> See [`secrets-inventory.md`](./secrets-inventory.md) for the
> authoritative list of secrets in scope.

This page is the runbook a self-hosting operator follows when
rotating `SESSION_SECRET`. Two paths exist; the rest of the document
walks each one.

## Path A — Emergency rotation (suspected key leak)

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

## Path B — Routine zero-downtime rotation

When to use:
- Quarterly hygiene per organisational policy
- Cycling secrets after a planned major upgrade
- Any scheduled rotation where you have no reason to believe the
  current value has leaked

Goal: rotate without forcing users to re-log in.

### Step 1 — flip

Move the current `SESSION_SECRET` to `SESSION_SECRET_PREVIOUS`; set a
fresh primary.

```bash
OLD=$(grep '^SESSION_SECRET=' .env | cut -d= -f2-)
NEW=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$NEW|" .env
sed -i "s|^SESSION_SECRET_PREVIOUS=.*|SESSION_SECRET_PREVIOUS=$OLD|" .env
docker compose -f infra/docker/compose.prod.yml up -d core-api
```

### Step 2 — verify the rotation window

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

### Step 3 — wait

Wait at least `SESSION_MAX_AGE_SECONDS` (default 7 days,
`apps/core-api/src/modules/auth/auth.config.ts:127`). Every cookie
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

### Step 4 — drop

Clear `SESSION_SECRET_PREVIOUS` and redeploy. Single-key steady
state.

```bash
sed -i "s|^SESSION_SECRET_PREVIOUS=.*|SESSION_SECRET_PREVIOUS=|" .env
docker compose -f infra/docker/compose.prod.yml up -d core-api
```

Confirm the rotation-active log line is no longer emitted on boot.

## What this runbook does NOT cover (yet)

Round 6 will expand to include:

- Rotating OIDC client secrets without breaking in-flight logins
- Rotating S3 and SMTP credentials
- Rotating the Sentry DSN (per ADR-0018)
- Rotating the Turnstile secret
- Per-secret blast radius + recovery checklist
- The full incident-response procedure (LGPD 72h ANPD clock)
- The integration with the restore drill

Until that lands, the [`secrets-inventory.md`](./secrets-inventory.md)
table identifies every secret in scope; rotate each one via its
platform's standard procedure (Fly secrets, Doppler, Vault — whatever
your deployment uses).

## Multi-tenant rotation orchestration

Rotating `SESSION_SECRET` across a fleet of hosted-tenant instances
simultaneously — with audit emission per tenant, scheduled rotation
queues, and per-customer rotation reports — is a managed-service
concern and ships in the Enterprise edition. See the
[feature matrix](../en/feature-matrix.md) row 24 (Observability +
managed bundle) for the Community-vs-Enterprise positioning. The
single-tenant procedure above is the Community surface and the
self-hoster contract.
