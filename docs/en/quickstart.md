# Quickstart — run Panorama on your laptop in 5 minutes

This is the path for a maintainer, contributor, or someone who just
wants to click around the app. Two seeded tenants ("Alpha" and
"Bravo"), each with an Owner you can log in as, three trucks each,
and you can test cross-tenant isolation by swapping cookies.

For a production deployment (TLS, backups, hardening), read
[self-hosting](./self-hosting.md) instead — it covers a different
audience.

## Prerequisites

- **Node.js 22+** (uses `engines: ">=22"`; older versions break Vitest)
- **pnpm 9+** (`corepack enable && corepack prepare pnpm@latest --activate`)
- **Docker + docker-compose** (the dev stack is 4 containers: Postgres,
  Redis, MinIO, MailHog)

```bash
node --version    # v22+ ?
pnpm --version    # 9+ ?
docker compose version  # any modern version
```

## 1. Clone + install

```bash
git clone https://github.com/VitorMRodovalho/panorama.git
cd panorama
pnpm install
```

`pnpm install` takes ~2 minutes the first time (downloads + builds
sharp's native image bindings).

## 2. Start the dev stack

```bash
docker-compose -f infra/docker/compose.dev.yml up -d
```

Containers come up healthy in ~10s. Check with:

```bash
docker-compose -f infra/docker/compose.dev.yml ps
```

You should see four containers `Up (healthy)`: postgres on `:5432`,
redis on `:6379`, minio on `:9000`, mailhog on `:8025`.

> `docker compose` (with a space) is the v2 plugin syntax; `docker-compose`
> (with a hyphen) is the legacy binary. Either works. The dev-stack
> compose file is plain v3; if `docker compose` fails on your machine,
> fall back to `docker-compose`.

## 3. Copy the env files

```bash
cp apps/core-api/.env.example apps/core-api/.env
cp apps/web/.env.example apps/web/.env.local
```

The defaults in `.env.example` point at the dev-stack containers
(localhost:5432 / 6379 / 9000 etc.) and are safe for local dev. The
`SESSION_SECRET` in `.env.example` is a placeholder — replace it
with 32 random bytes:

```bash
NEW=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$NEW|" apps/core-api/.env
```

## 4. Apply migrations + seed

```bash
pnpm --filter @panorama/core-api prisma:deploy
pnpm --filter @panorama/core-api prisma:seed
```

The seed output ends with:

```
Owner login credentials (DEV ONLY — see docs/en/quickstart.md):
  admin@alpha.example / panorama-dev-2026
  admin@bravo.example / panorama-dev-2026

Web URL: http://localhost:3000
```

Both Owners use the same dev password — never use this value
outside local dev. The seed script refuses to run against any
`DATABASE_URL` that looks like prod.

## 5. Start the API + web in two terminals

Terminal 1 — core-api on `:4000`:

```bash
pnpm --filter @panorama/core-api dev
```

Wait for `Panorama core-api listening on :4000 (sentryEnabled=false)`.

Terminal 2 — web on `:3000`:

```bash
pnpm --filter @panorama/web dev
```

Wait for `Ready in <time>`.

## 6. Log in

Open <http://localhost:3000/login> and use:

- **Email:** `admin@alpha.example`
- **Password:** `panorama-dev-2026`

You should land on the Alpha tenant's `/assets` page with the three
seeded trucks (`ALPHA-001`, `ALPHA-002`, `ALPHA-003`). Click around:

- `/reservations` — empty list; click "New" to request a booking
- `/reservations/calendar` — 14-day timeline view
- `/assets/import` — CSV upload form
- `/admin` — tenant admin surface (Owner-only)

## 7. Test cross-tenant isolation

Log out, then log in as `admin@bravo.example` with the same password.
You should see `BRAVO-001` / `BRAVO-002` / `BRAVO-003` — and the
Alpha trucks must NOT appear. That's row-level security holding the
contract at the database layer
([ADR-0003](../adr/0003-multi-tenancy.md)).

## 8. Other useful local URLs

| URL | What it is |
|---|---|
| <http://localhost:3000> | The web app you log into |
| <http://localhost:4000/health> | API liveness + DB ping |
| <http://localhost:4000/api-docs> | OpenAPI schema (Swagger UI) |
| <http://localhost:8025> | MailHog — captured outgoing emails (invitations, export notifications). NEVER hits a real SMTP server in dev. |
| <http://localhost:9001> | MinIO console; login `minioadmin/minioadmin`. Buckets `panorama-photos` + `panorama-backups` are created automatically. |

## Optional — feature flags

The seeded environment has `FEATURE_INSPECTIONS`, `FEATURE_MAINTENANCE`,
and `FEATURE_SELF_SERVE_SIGNUP` defaulted in `apps/core-api/.env`. To
exercise those flows, set them to `true` and restart core-api:

```bash
# apps/core-api/.env
FEATURE_INSPECTIONS=true
FEATURE_MAINTENANCE=true
FEATURE_SELF_SERVE_SIGNUP=true
```

If you turn `FEATURE_SELF_SERVE_SIGNUP=true`, you also need
`TURNSTILE_SECRET` set (any value is fine for local dev — Turnstile
verification is mocked in tests, and the dev signup flow uses a stub).

## Optional — pretty logs

JSON logs to stdout is the production format. For human-readable
output during dev, set in `apps/core-api/.env`:

```bash
LOG_FORMAT=pretty
```

And restart core-api. Same logs, colorized + line-formatted.

## Re-seeding

```bash
pnpm --filter @panorama/core-api prisma:seed
```

The seed is destructive — it wipes every domain table before
recreating Alpha + Bravo. Safe in local dev (the script refuses to
run if `DATABASE_URL` looks production-like).

## Running the test suite

```bash
pnpm --filter @panorama/core-api test
```

~520 cases; ~70-90s. Tests use the same dev stack (Postgres + Redis +
MinIO) — they reset their own state via `test/_reset-db.ts`. Don't
worry about your seed data; tests run in isolation.

## When things break

| Symptom | Likely cause | Fix |
|---|---|---|
| `runAsSuperAdmin requires DATABASE_PRIVILEGED_URL` | Missing env var | Copy `.env.example` to `.env`; the line is in there |
| `SESSION_SECRET must be at least 32 characters` | Placeholder not replaced | Re-run the `node -e ... | sed` snippet in step 3 |
| `S3_ENDPOINT health check failed` | MinIO not ready | `docker-compose -f infra/docker/compose.dev.yml restart minio` and wait 10s |
| `Cannot connect to Postgres` | Dev stack down | `docker-compose -f infra/docker/compose.dev.yml up -d` |
| Login returns 401 with valid creds | Seed didn't run (or ran before this PR) | `pnpm --filter @panorama/core-api prisma:seed` re-creates the password identity |
| `pnpm install` fails on `sharp` | Native build deps missing | On Linux: `sudo apt install libvips-dev`. On macOS: `brew install vips` |

If the dev stack is genuinely broken (port conflict, weird Docker
state), `docker-compose -f infra/docker/compose.dev.yml down -v &&
docker-compose -f infra/docker/compose.dev.yml up -d` rebuilds from
scratch (`-v` wipes volumes — the seed gets you back to a known
state).

## What this DOES NOT cover

- **Production deployment.** See [self-hosting.md](./self-hosting.md).
- **Hosted preview signup.** That's the public `panorama.vitormr.dev`
  app surface, which is not yet live; see
  [early-access.md](./early-access.md).
- **Real Google / Microsoft OIDC.** The seed sets up email/password
  auth only; configuring OIDC providers needs real client credentials
  at the IdP side. The OIDC bits are wired but unused in this
  quickstart.

For deeper dives into the architecture, see
[architecture.md](./architecture.md) and the
[ADR index](/adr/0000-index).
