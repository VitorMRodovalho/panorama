# Self-hosting Panorama

Reference deploy for the AGPL-3.0 community: a single host running
Docker Compose. This is the canonical "deploy on your own VPS"
path — also the fallback target for the canary step 13 of
[ADR-0012](../adr/0012-inspection-photo-pipeline.md), and the
documented escape if the managed staging stack
([ADR-0013](../adr/0013-staging-deploy-architecture.md)) doesn't
fit your needs.

> **Status note**: 0.3 ships the API + admin templates + inspection
> backend feature-complete. The driver-facing web UI is in flight
> (step 11 of ADR-0012); until it lands, self-hosting gives you an
> API-only deploy. Headless deploys are a fully supported use case
> for integration partners.

## Contents

1. [What you need](#what-you-need)
2. [Quick start](#quick-start)
3. [Backups](#backups)
4. [Upgrades + migrations](#upgrades--migrations)
5. [TLS + reverse proxy](#tls--reverse-proxy)
6. [Hardening checklist](#hardening-checklist)
7. [Common operational tasks](#common-operational-tasks)
8. [What this deploy does NOT cover](#what-this-deploy-does-not-cover)

---

## What you need

- A Linux host (Debian 12 / Ubuntu 22.04 / Rocky 9 — anything Docker
  supports). Minimum **2 vCPU + 4 GB RAM + 40 GB disk** for a small
  pilot tenant; double the disk if you expect heavy photo evidence.
- Docker Engine 24+ + Docker Compose v2.
- A domain name with DNS you can configure.
- An SMTP relay for invitation + notification email (Postmark / SES /
  SendGrid / your own Postfix).
- An hour to walk through the steps below.

## Quick start

```bash
# 1. Clone + checkout the most recent tagged release.
git clone https://github.com/VitorMRodovalho/panorama.git
cd panorama
git checkout v0.3.0   # replace with the latest tag

# 2. Configure secrets.
cp .env.example .env
# Edit .env — at minimum set:
#   POSTGRES_PASSWORD     (strong random)
#   DATABASE_URL          (panorama_app role; sslmode=require if pointing off-host)
#   DATABASE_PRIVILEGED_URL (panorama_super_admin role; ADR-0015)
#   S3_ACCESS_KEY / S3_SECRET_KEY (the MinIO sidecar uses these as its root creds)
#   SESSION_SECRET        (generate via `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`)
#   SMTP_*                (your relay)
#   PANORAMA_WEB_BASE_URL (the public URL you'll front the API with)

# 3. Build the API image.
docker compose -f infra/docker/compose.prod.yml build core-api

# 4. Bring up infra services first (postgres, redis, minio, minio-init).
docker compose -f infra/docker/compose.prod.yml up -d postgres redis minio
docker compose -f infra/docker/compose.prod.yml run --rm minio-init

# 5. Apply migrations (Prisma schema + rls.sql).
docker compose -f infra/docker/compose.prod.yml run --rm migrator

# 6. Bring up the API.
docker compose -f infra/docker/compose.prod.yml up -d core-api

# 7. Verify.
curl http://127.0.0.1:4000/health
# Expect: {"ok":true,"db":"up"}
```

The Compose file binds every port to `127.0.0.1` by design — see
[TLS + reverse proxy](#tls--reverse-proxy) for how to expose the API
to the internet.

## Backups

The Compose stack does **not** automate backups. Pick one of:

- **`pg_dump` cron** writing to a directory backed up by your VPS
  provider's snapshot system. Retain ≥ 30 days. Test restoration
  quarterly.
- **WAL-G / pgBackRest** for continuous point-in-time recovery if
  you have a real RPO requirement.
- **Volume snapshots** at the VPS layer (Hetzner, Vultr, DO all
  offer this).

For object storage:

- The **MinIO sidecar's volume** (`panorama_minio`) holds every
  inspection photo. Back it up with the same cadence as Postgres.
- Alternative: point `S3_*` at an external S3 / R2 / Wasabi bucket
  whose own provider handles redundancy. Drop the MinIO service
  from the Compose file.

## Upgrades + migrations

Every release cuts a Git tag. To upgrade:

```bash
git fetch --tags
git checkout v0.4.0   # next release

# Re-build with the new source.
docker compose -f infra/docker/compose.prod.yml build core-api

# Apply any new migrations + rls.sql files.
docker compose -f infra/docker/compose.prod.yml run --rm migrator

# Restart the API (zero-downtime is out of scope here — for that
# use the K8s helm chart in infra/helm/ once it lands).
docker compose -f infra/docker/compose.prod.yml up -d core-api
```

The migrator service is idempotent. Re-running it on an unchanged
DB is a no-op.

## TLS + reverse proxy

Panorama itself does NOT terminate TLS. Put **Caddy / nginx /
Traefik / Cloudflare Tunnel** in front. Caddy is the lowest-effort
option:

```caddyfile
panorama.example.com {
    reverse_proxy 127.0.0.1:4000
    encode gzip
}
```

Requirements the upstream proxy MUST satisfy:

- **HTTPS only** (the session cookie has `Secure` set when
  `NODE_ENV=production`).
- **Forward `X-Forwarded-Proto: https`** so Nest's redirect logic
  picks the right scheme.
- **Body size limit ≥ 11 MB** (the in-process Multer cap is 10 MB
  for inspection photos; the proxy needs headroom).
- **WebSocket upgrade path** — none yet at 0.3, but reserve it.

For Cloudflare Tunnel (no public IP needed, useful for a single-VPS
canary behind NAT):

```bash
cloudflared tunnel create panorama
cloudflared tunnel route dns panorama panorama.example.com
cloudflared tunnel run --url http://127.0.0.1:4000 panorama
```

## Hardening checklist

Per [SECURITY.md](../../SECURITY.md), the AGPL responsibility for
deployment hardening is on you. Minimum checklist:

- [ ] Postgres NOT exposed to the public internet. Compose binds to
      `127.0.0.1` by default — keep it that way unless you front it
      with a private network.
- [ ] **Both `DATABASE_URL` and `DATABASE_PRIVILEGED_URL` configured**
      (ADR-0015 contract). They MUST point at different Postgres
      roles. The runtime aborts at boot if they're equal — by design.
- [ ] `SESSION_SECRET` is 32 random bytes, generated per-environment.
      Never reuse across staging + prod.
- [ ] OS-level updates on a schedule (`unattended-upgrades` on
      Debian/Ubuntu, `dnf-automatic` on Rocky).
- [ ] SSH key-only auth (no passwords); fail2ban or equivalent.
- [ ] Firewall: only 80/443 from public, 22 from a bastion or your
      home IP, everything else internal.
- [ ] Backups documented + tested (see above).
- [ ] Monitoring: at minimum a `curl /health` from outside the host
      every minute, alerting on non-200.
- [ ] Audit log retention: the `audit_events` table grows
      indefinitely. Plan a quarterly export-to-cold-storage job.

## Common operational tasks

### Rotate `SESSION_SECRET`

```bash
NEW_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$NEW_SECRET|" .env
docker compose -f infra/docker/compose.prod.yml up -d core-api
# Every active session is invalidated — users must re-login. Expected.
```

### Apply a new migration after pulling

```bash
docker compose -f infra/docker/compose.prod.yml build core-api
docker compose -f infra/docker/compose.prod.yml run --rm migrator
docker compose -f infra/docker/compose.prod.yml up -d core-api
```

### Trigger the photo retention sweep manually

```bash
# Useful when you want to action a DSAR ahead of the daily cron.
docker compose -f infra/docker/compose.prod.yml exec core-api \
  node -e "process.exit(0)"  # placeholder until ADR-0015 BullMQ migration lands
# After the BullMQ migration: trigger the repeatable-job dispatch with
# `bull-board` or a one-shot `pnpm exec ts-node scripts/sweep-now.ts`.
```

### Take a Postgres snapshot

```bash
docker compose -f infra/docker/compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > "/var/backups/panorama-$(date +%F).sql.gz"
```

### Read the audit log

```bash
docker compose -f infra/docker/compose.prod.yml exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT \"occurredAt\", action, \"tenantId\", \"actorUserId\", metadata
        FROM audit_events
       ORDER BY id DESC
       LIMIT 50;"
```

## What this deploy does NOT cover

Out of scope for this single-host reference; if you need any of these
you're crossing into Enterprise / managed-service territory:

- **High availability** (single host = single point of failure).
- **Zero-downtime upgrades** (the API restarts during `up -d`; brief
  503 window is expected).
- **Multi-region replication.**
- **Hot standby** for Postgres.
- **TLS termination** (you bring your own — see above).
- **Centralised logging / SIEM** (the API logs to stdout; pipe it
  somewhere yourself).
- **Per-tenant resource quotas** at the OS level.
- **WAF / DDoS protection** (front with Cloudflare, AWS WAF, etc.).

For multi-host orchestration, watch the `infra/helm/` directory —
the official Helm chart lands at 0.5 alongside the K8s deploy story.

---

If anything here is unclear or breaks, open a Discussion on
[GitHub](https://github.com/VitorMRodovalho/panorama/discussions). For
security issues see [SECURITY.md](../../SECURITY.md).
