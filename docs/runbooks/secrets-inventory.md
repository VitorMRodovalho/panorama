# Secrets inventory

Authoritative list of every secret (credential, key, password, or
URL containing one) Panorama depends on, grouped by rotation
procedure. The actual rotation runbook is at
[`./secrets-rotation.md`](./secrets-rotation.md) (TBD as part of
Wave 0 Round 6); this file is the source-of-truth of what exists,
where it lives, and who can rotate it.

**Updated 2026-05-16** as part of Wave 0 Round 1 (per tech-lead's C1
scan finding: 35+ `process.env.*` accesses in core-api + ~8
duplicates in apps/web). Cross-reference to
[`HANDOFF-2026-05-16-wave0-scan.md`](../audits/HANDOFF-2026-05-16-wave0-scan.md).

## Database credentials (Supabase managed Postgres)

| Variable | Where | Sensitivity | Notes |
|---|---|---|---|
| `DATABASE_URL` | `apps/core-api/.env*`, Fly secrets | **Secret** — contains role + password | Pooler (port 6543); runtime app traffic |
| `DATABASE_DIRECT_URL` | same | **Secret** | Direct (port 5432); `prisma migrate deploy` |
| `DATABASE_PRIVILEGED_URL` | same | **Secret** | Direct (port 5432); rls.sql + bootstrap |
| `DATABASE_APP_ROLE` | bootstrap, `apply-migrations.sh` env | Non-secret (role name) | Default `panorama_app` |
| `DATABASE_APP_PASSWORD` | bootstrap, env | **Secret** — raw password | Set by `setup-staging-env.sh`; rotated independently of pooler password |

**Rotation procedure (per ADR-0015 + 0013 architecture):**

1. Rotate Supabase pooler password via Supabase dashboard → Project
   Settings → Database
2. Re-run `scripts/setup-staging-env.sh` locally to regenerate
   `apps/core-api/.env.staging` with the new pooler URL
3. `fly secrets set --app panorama-staging DATABASE_URL=...
   DATABASE_DIRECT_URL=... DATABASE_PRIVILEGED_URL=...`
4. Rolling deploy: `fly deploy --strategy rolling`
5. Verify `/health` returns OK after each instance comes up
6. The `panorama_app` role password rotates separately via
   `ALTER ROLE panorama_app WITH PASSWORD 'new'` from a privileged
   psql session; `DATABASE_APP_PASSWORD` env var updated to match
7. **Rollback**: revert the `fly secrets set` to the previous values

## Session crypto

| Variable | Where | Sensitivity | Notes |
|---|---|---|---|
| `SESSION_SECRET` | `apps/core-api/.env*`, Fly secrets | **Secret** — 32+ byte random | Iron-session encryption key (primary; used to encrypt new cookies) |
| `SESSION_SECRET_PREVIOUS` | `apps/core-api/.env*`, Fly secrets | **Secret** — 32+ byte random | Optional; set only during a rotation window so iron-session can decrypt cookies sealed under the previous primary |

**Rotation procedure:** see [`secrets-rotation.md`](./secrets-rotation.md).
Two paths supported: emergency (invalidates all sessions; for
suspected leaks) and routine zero-downtime (flip → wait
`SESSION_MAX_AGE_SECONDS` → drop). `SESSION_MAX_AGE_SECONDS`
defaults to 7 days (`apps/core-api/src/modules/auth/auth.config.ts:127`).

## OIDC client secrets

| Variable | Where | Sensitivity | Notes |
|---|---|---|---|
| `OIDC_GOOGLE_CLIENT_ID` | env, Fly secrets | Non-secret (public ID) | |
| `OIDC_GOOGLE_CLIENT_SECRET` | env, Fly secrets | **Secret** | |
| `OIDC_MICROSOFT_CLIENT_ID` | env, Fly secrets | Non-secret | |
| `OIDC_MICROSOFT_CLIENT_SECRET` | env, Fly secrets | **Secret** | |

**Rotation procedure (per provider):**

Rotation is **IdP-driven** — Google or Microsoft generates a new
secret in their respective consoles. Our procedure:

1. In Google Cloud Console → OAuth 2.0 → rotate client secret (or
   Azure → App registrations → certificates and secrets → new
   secret)
2. IdP provides the new secret (visible once; capture immediately)
3. `fly secrets set --app panorama-staging OIDC_GOOGLE_CLIENT_SECRET=...`
4. Rolling deploy
5. In the IdP console, revoke the old secret after the rolling
   deploy completes (both secrets may be active during the window
   if the IdP supports it; check provider docs)
6. **Rollback**: re-set the prior secret in fly + IdP

## Cloudflare Turnstile (self-serve signup CAPTCHA)

Per ADR-0020 §5. Only consumed when `FEATURE_SELF_SERVE_SIGNUP=true`;
self-hosts that keep signup off can leave this unset.

| Variable | Where | Sensitivity | Notes |
|---|---|---|---|
| `TURNSTILE_SECRET` | env, Fly secrets | **Secret** — server-side siteverify token | Paired with a public site key embedded in the homepage form |
| `TURNSTILE_SITE_VERIFY_URL` | env (optional) | Non-secret (URL) | Defaults to Cloudflare's prod endpoint; overridden in e2e tests via a stub server |
| `SIGNUP_FAILURE_LATENCY_FLOOR_MS` | env (optional) | Non-secret (integer) | Defaults to `600`. ADR-0020 §5 timing floor for the constant-latency 400 envelope; only override below `600` in tests |

**Rotation procedure:**

1. Cloudflare dashboard → Turnstile → site → rotate secret key
2. `fly secrets set --app panorama-hosted TURNSTILE_SECRET=...`
3. Rolling deploy
4. In the Cloudflare dashboard, revoke the prior secret after the
   rolling deploy completes (Cloudflare keeps the prior key valid
   briefly during rotation; check dashboard for the exact window)
5. **Validation**: submit a real signup from a fresh browser; the
   server-side siteverify call must succeed
6. **Rollback**: re-set the prior secret in fly + Cloudflare

**Boot guard**: `SignupConfigService` throws
`TURNSTILE_SECRET must be set when FEATURE_SELF_SERVE_SIGNUP=true`
if the flag is on and the secret is missing. The flag is gated in
`app.module.ts`; self-hosters who leave it off (the default) won't
hit this guard.

## S3-compatible object storage (Cloudflare R2 in staging)

| Variable | Where | Sensitivity | Notes |
|---|---|---|---|
| `S3_ENDPOINT` | env, Fly secrets | Non-secret (URL) | |
| `S3_REGION` | env, Fly secrets | Non-secret | |
| `S3_BUCKET_PHOTOS` | env, Fly secrets | Non-secret | |
| `S3_ACCESS_KEY` | env, Fly secrets | **Secret** | |
| `S3_SECRET_KEY` | env, Fly secrets | **Secret** | |
| `S3_FORCE_PATH_STYLE` | env, Fly secrets | Non-secret (boolean) | |
| `S3_ALLOW_PRIVATE_ENDPOINT` | env, Fly secrets | Non-secret (boolean) | |

**Rotation procedure:**

1. In Cloudflare R2 dashboard → API Tokens → create new R2 token →
   capture new access + secret pair
2. `fly secrets set --app panorama-staging S3_ACCESS_KEY=... S3_SECRET_KEY=...`
3. Rolling deploy
4. Revoke the old token in the R2 dashboard after rolling deploy
5. **Validation**: upload a test photo via the staging app; check
   it lands in R2 + can be served back

## SMTP

| Variable | Where | Sensitivity | Notes |
|---|---|---|---|
| `SMTP_HOST` | env, Fly secrets | Non-secret | |
| `SMTP_PORT` | env, Fly secrets | Non-secret | |
| `SMTP_SECURE` | env, Fly secrets | Non-secret (boolean) | |
| `SMTP_USER` | env, Fly secrets | **Secret-ish** — may be a real email or API key on managed services | |
| `SMTP_PASSWORD` | env, Fly secrets | **Secret** | |
| `MAIL_FROM` | env, Fly secrets | Non-secret | |
| `MAIL_FROM_NAME` | env, Fly secrets | Non-secret | |

**Rotation procedure (depends on provider):**

For SES / SendGrid / Postmark / etc.: rotate via the provider's API
token rotation UI; capture new credentials. Then:

1. `fly secrets set --app panorama-staging SMTP_USER=... SMTP_PASSWORD=...`
2. Rolling deploy
3. Revoke old credentials in provider console
4. **Validation**: trigger a test invitation email; verify SPF /
   DKIM still pass

## Redis (Upstash in staging)

| Variable | Where | Sensitivity | Notes |
|---|---|---|---|
| `REDIS_URL` | env, Fly secrets | **Secret** — `rediss://default:password@endpoint:6379` | Token embedded in URL |

**Rotation procedure:**

1. In Upstash dashboard → reset token (generates new connection URL)
2. `fly secrets set --app panorama-staging REDIS_URL=...`
3. Rolling deploy
4. Old token is automatically invalidated when the new one is
   created

**Note:** During the rotation window, BullMQ workers will see auth
errors briefly. This is expected; the rolling deploy resolves it
within the deploy window.

## Sentry (future — per ADR-0018)

| Variable | Where | Sensitivity | Notes |
|---|---|---|---|
| `SENTRY_DSN` | env, Fly secrets | **Quasi-secret** — exposes Sentry project | Unset = Sentry no-op (per ADR-0018) |

**Rotation procedure:**

DSN rotation is tied to Sentry project recreation. If the DSN
leaks, the threat is event-injection (someone sending fake errors
to your project), not data exfiltration. Procedure:

1. In Sentry → Project Settings → Client Keys → create new DSN
2. `fly secrets set --app panorama-staging SENTRY_DSN=...`
3. Rolling deploy
4. Revoke old DSN in Sentry

## CAPTCHA (future — per ADR-0020)

| Variable | Where | Sensitivity | Notes |
|---|---|---|---|
| `CAPTCHA_SITE_KEY` | env, web build | Non-secret (public) | hCaptcha or Turnstile |
| `CAPTCHA_SECRET` | env, Fly secrets | **Secret** — server-side verification | |

Rotation procedure TBD when ADR-0020's signup endpoint lands in
Round 3.

## Seed credentials (devops only)

| Variable | Where | Sensitivity | Notes |
|---|---|---|---|
| `SEED_OWNER_PASSWORD` | local env only | **Secret** | Used by `smoke-staging-seed.ts` for fixture provisioning; never set in production |
| `SEED_OWNER_PASSWORD_FILE` | local env only | Path to file | Alternative to inline password |

These are dev-only and never live on Fly. Rotation = "regenerate
the smoke tenant when you need to."

## Non-secret config (documented for completeness)

These are environment variables that affect behavior but are not
credentials. Listed so the inventory is complete + future ops can
quickly identify what's safe to log.

- `APP_BASE_URL`, `APP_VERSION`, `CORE_API_URL`, `WEB_ORIGIN`
- `NODE_ENV`, `PORT`
- `ALLOW_STAGING_SEED`, `FEATURE_INSPECTIONS`, `FEATURE_MAINTENANCE`,
  `FEATURE_SELF_SERVE_SIGNUP` (per ADR-0020 — gates Turnstile + signup endpoints)
- `OIDC_GOOGLE_HOSTED_DOMAIN`, `OIDC_GOOGLE_ISSUER`,
  `OIDC_GOOGLE_TRUSTED_HD_DOMAINS`, `OIDC_MICROSOFT_TENANT`,
  `OIDC_ALLOW_INSECURE_ISSUER`
- `OAUTH_STATE_COOKIE_NAME`, `SESSION_COOKIE_NAME`,
  `SESSION_MAX_AGE_SECONDS`
- `INVITE_RATE_ADMIN_HOUR`, `INVITE_RATE_TENANT_DAY`
- `TRUST_PROXY_HOPS` — see dedicated subsection below
- `THROTTLER_ENABLED` — **REQUIRED in production**; see dedicated
  subsection below

### `TRUST_PROXY_HOPS` — load-bearing for signup rate-limit (ADR-0020 §4)

Not a secret, but **load-bearing for the §4 per-IP throttler bucket
on `/auth/signup`** and named here so self-hosters cannot miss it.

Express's `app.set('trust proxy', n)` reads the Nth-from-the-right
value in `X-Forwarded-For` as `req.ip`. Set wrong:

- **Too low** → `req.ip` resolves to an internal proxy; every
  signup attempt buckets to one IP (fail-united, the entire IP
  bucket is one shared slot for the whole internet).
- **Too high** → `req.ip` resolves to whatever the upstream client
  sent in `X-Forwarded-For`, which a remote attacker controls (the
  attacker mints arbitrary identities).

| Topology | TRUST_PROXY_HOPS |
|---|---|
| Local dev, no proxy | `0` |
| Fly hosted instance (Fly edge → app) | `1` (default) |
| Self-host: nginx → app | `1` |
| Self-host: Cloudflare → nginx → app | `2` |
| Self-host: Cloudflare → Fly edge → app | `2` |
| Self-host: ALB → nginx → app | `2` |

Bootstrap validates the value: must be a non-negative integer or
`app.listen` is preceded by `Error: TRUST_PROXY_HOPS must be a
non-negative integer; got "loopback"` (or similar). Unset → default
`1`.

When `FEATURE_SELF_SERVE_SIGNUP=true` (the hosted instance and any
self-host that opens self-serve signup), this variable becomes
SECURITY-CRITICAL — the §4 anti-spoof flood test in
`apps/core-api/test/abuse/signup-flood.e2e.test.ts` asserts the
bucket behavior assuming a correctly-configured value.

### `THROTTLER_ENABLED` — REQUIRED in production (security-reviewer v2 §3-2)

Not a secret, but **fail-OPEN unless explicitly enabled**. Default
behaviour of `app.module.ts:143-145` is to register
`PerTenantThrottlerGuard` as `APP_GUARD` only when the throttler
module is wired into the configure() chain; the module itself
checks `THROTTLER_ENABLED` for the test-skip path. A production
deployment that NEVER sets `THROTTLER_ENABLED=1` runs with the
guard registered but the per-tenant tracker effectively no-op'd
under specific test-only env conditions.

**Operator action in production:**

```bash
fly secrets set --app panorama-hosted THROTTLER_ENABLED=1
```

A production boot WITHOUT `THROTTLER_ENABLED=1` should be treated
as a **misconfiguration**. The boot-audit module (per ADR-0019)
logs the value at startup; check the boot log for
`throttler_enabled` = true after any deploy.

Future hardening: the boot-audit module should emit a structured
warning (and on the hosted instance, refuse to start) if
`THROTTLER_ENABLED` is unset/false AND `NODE_ENV=production`.
Filed as a Wave-0+ follow-up; until it lands, the operator
discipline above is the contract.

| Topology | THROTTLER_ENABLED |
|---|---|
| Local dev (vitest, no abuse-test) | unset (defaults to off) |
| Local dev (signup-flood.e2e.test.ts) | `1` (the test sets it) |
| Hosted preview / staging | **`1` (REQUIRED)** |
| Self-host with `FEATURE_SELF_SERVE_SIGNUP=true` | **`1` (REQUIRED)** |
| Self-host with FEATURE_SELF_SERVE_SIGNUP off | `1` recommended (cheap defense-in-depth on login + invitation paths) |

## Total count

- **Secrets requiring rotation procedure:** 15 (Database ×5,
  Session ×1, OIDC ×2, Turnstile ×1, S3 ×2, SMTP ×2, Redis ×1,
  SEED ×1)
- **Future secrets pending ADR implementation:** 1 (Sentry DSN)
- **Non-secret env vars:** ~19 (listed above, including the new
  `TRUST_PROXY_HOPS` load-bearing config)

## Maintainer accountability

Today, the maintainer is the sole rotater for all of the above
(bus factor of 1 per [issue #50](https://github.com/VitorMRodovalho/panorama/issues/50)).
This runbook is the foundation of "documentation for the second
maintainer who doesn't exist yet" (per
[HANDOFF-2026-05-16-wave0-scan.md](../audits/HANDOFF-2026-05-16-wave0-scan.md)
§"Open risks").

Update this file when:
- New secret added (e.g., a new IdP, a new managed service)
- Rotation procedure changes (e.g., provider UI redesign)
- Sensitivity classification changes
