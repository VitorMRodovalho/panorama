# ADR-0013: Staging deploy architecture — internal canary

- Status: Accepted (2026-04-19) for **internal staging only**.
  Promotion to a customer-facing managed instance is **gated on
  ADR-0014 (Panorama Cloud SKU + edition placement)** landing first.
- Date: 2026-04-19
- Deciders: Vitor Rodovalho
- Reviewers (pre-draft directional pass, 2026-04-19):
  - tech-lead → REQUEST-CHANGES (BYPASSRLS + setInterval blockers)
  - data-architect → BLOCK (privilege model rewrite required first)
  - security-reviewer → REVISE (R2 endpoint quirks, service_role discipline,
    SECURITY.md must-haves — last item closed in this PR)
  - product-lead → BLOCK (positioning: "managed instance" is a 0.4 SKU
    decision, not a 0.3 infra task)
- Related: [ADR-0002 Edition strategy](./0002-licensing-and-edition-strategy.md),
  [ADR-0003 Multi-tenancy](./0003-multi-tenancy.md),
  [ADR-0012 Inspections + photo pipeline](./0012-inspection-photo-pipeline.md),
  [ADR-0015 BYPASSRLS removal refactor](./0015-bypassrls-removal-refactor.md) (hard prerequisite)

## Context

ADR-0012 shipped 0.3's inspection backend feature-complete (steps 5–10
+ docs in step 12). The web UI (step 11) and the canary flag-flip
(step 13) remain. Step 13 explicitly scopes "canary" as
`FEATURE_INSPECTIONS=true` on **one pilot tenant** — a single tenant on
a single instance, not a multi-cloud rollout.

We need somewhere to actually **run** the build for that canary, plus
an artefact loop that proves the deploy mechanics work for the AGPL
self-hosters who are Panorama's primary ICP at 0.3 / 0.4.

The directional review (above) pushed back hard on framing that as a
"managed cloud deploy". Three independent agents flagged the same
risk: standing up a customer-facing hosted instance pre-SKU creates a
third edition (Community + Enterprise + Cloud) by accident, competes
with the AGPL self-hosters, and locks us into platform decisions we
haven't earned customer signal to justify.

This ADR therefore scopes deploy work to:

1. A **self-hosting reference** (Dockerfile + production
   docker-compose + `docs/en/self-hosting.md`) — serves AGPL
   community and the canonical "deploy on your own VPS" path that
   pilot Amtrak would actually use.
2. An **internal staging** (Supabase Free + Cloudflare R2 Free +
   Cloudflare Pages Free + Fly.io Free + Upstash Free) that the
   maintainer uses to validate deploy mechanics and burn-in the
   refactors. **No public customer URL. No customer-bearing
   workload. No DNS record at `panorama.<tld>` pointing at it.**
3. An explicit **non-decision on Panorama Cloud SKU** — deferred to
   ADR-0014 (not in this PR).

## Prior art

- ADR-0002 commits to AGPL Community + strictly-additive Enterprise.
  No third edition.
- ADR-0012 §Execution-order step 13 defines the canary as a
  feature-flag flip on one tenant, not a platform rollout.
- `docs/en/feature-matrix.md` enumerates what stays Community
  forever; "managed hosting" is not in that table.

## Decision

### 1. Two artefacts, one positioning

| Artefact | Audience | Lives at |
|---|---|---|
| Dockerfile + `compose.prod.yml` + `docs/en/self-hosting.md` | AGPL self-hosters (incl. pilot tenants on their own infra) | `apps/core-api/Dockerfile`, `infra/docker/compose.prod.yml`, `docs/en/self-hosting.md` |
| Internal staging on managed providers | Maintainer only | Not customer-facing; URL kept internal |

### 2. Internal staging stack (Free-tier $0)

- **API (NestJS)**: Fly.io us-east, free shared-cpu-1x machine.
- **Postgres**: Supabase, North Virginia region, Free plan. Project
  lives in a separate Supabase account from `ai-pm-hub` because the
  Free-tier 2-projects cap (across all the primary account's Free
  orgs) is already hit by `meridianiq` + `orenu`. The trade is
  acceptable for staging — production never lands here regardless.
- **Object storage**: Cloudflare R2, Free tier (10 GB).
- **Web (Next.js)**: Cloudflare Pages, Free tier.
- **Redis**: Upstash, Free tier (10 k commands / day — enough for
  internal smoke tests; would not survive a real tenant load).
- **DNS**: Cloudflare, custom domain already registered in account.
  Staging URL stays under a non-public subdomain
  (`internal-staging.<tld>` or similar), gated by Cloudflare Access
  if later exposed.

### 3. Hard prerequisite: ADR-0015 BYPASSRLS-removal refactor

The directional review confirmed Supabase's managed Postgres does
**not** allow `CREATE ROLE … BYPASSRLS` for tenant-created roles.
Our `runAsSuperAdmin` mechanism (~25 call-sites across reservation,
tenant-admin, audit, inspection-maintenance, notification dispatcher,
PAT auth) depends on flipping into a `panorama_super_admin` role with
`BYPASSRLS`. On Supabase that flip silently no-ops.

ADR-0015 is the prerequisite refactor. It must land **before**
migrations 0001–0012 are applied to the staging Supabase project,
because:

- Without the refactor, `runAsSuperAdmin` returns rows scoped to the
  current tenant GUC, breaking every cross-tenant audit / sweep /
  reservation flow.
- The GUC namespace (`app.current_tenant`) collides with Supabase's
  own `app.*` reserved namespace. ADR-0012 v3 already established
  the precedent (`panorama.*`); the refactor extends it to
  `panorama.current_tenant` across all RLS policies + all callers.

### 4. Non-decisions

- **Panorama Cloud SKU**: deferred to ADR-0014. Until that lands,
  the staging instance is internal-only and never receives a customer
  workload.
- **All-Cloudflare via Containers**: Cloudflare Containers is in
  beta. Revisit at 0.5+ after GA. Fly.io is the right call for 0.3
  pilot.
- **Production DR posture**: Free-tier Supabase has 7-day backups +
  no PITR. Acceptable for internal staging; **unacceptable for any
  customer-bearing workload**. Promotion to Pro ($25/mo) + PITR
  (~$100/mo) is gated on a real customer contract and is a separate
  decision documented under ADR-0014 once that lands.
- **Cron migration to BullMQ**: the `setInterval`-based maintenance
  in `inspection-maintenance.service.ts` and `notification.dispatcher.ts`
  loses clock on Fly machine restart. For the **photo retention
  sweep** (24 h interval, DOT 49 CFR §396.3 compliance signal) this
  is a real exposure — ADR-0015 also covers migrating that one job
  to a BullMQ repeatable-job pattern (proven at
  `invitation-email.queue.ts:114-117`). The 1 h stale sweep + 2 s
  notification poll stay on `setInterval` for now (acceptable to
  lose a poll-cycle on restart).

### 5. Mitigations for the security-reviewer concerns

| Concern | Mitigation |
|---|---|
| `service_role` Supabase key is account-root | Refactor (ADR-0015) explicitly forbids `service_role` in app code. The privileged Postgres URL for the rewrite is a custom role we own, not `service_role`. Document in `docs/runbooks/setup-supabase-staging.md`. |
| R2 SSRF guard `endsWith('.local')` is too broad | Document `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com` (account endpoint, not custom domain). Custom-domain delivery is a separate `PUBLIC_PHOTO_HOST` concern that doesn't exist yet. |
| R2 + presigner region quirk | `S3_REGION=auto` for R2 staging. `.env.example` carries this default with comment. |
| Cross-platform secret rotation | Runbook documents per-platform rotation steps. SESSION_SECRET rotation forces re-login (expected). R2 keys scoped per-bucket via Cloudflare token API (not the global key). |
| Egress TLS pinning | `sslmode=verify-full` for Postgres + `rediss://` for Redis. Fly.io machine image bundles the Supabase CA. |

## Alternatives considered

### All-Cloudflare via Cloudflare Containers (beta)

Pros: single platform, single billing, single secret store. Cons:
beta = no SLA, no migration path if cut, no GA region pinning. Fly.io
is the right call for 0.3 pilot. Revisit at 0.5+.

### Self-hosted on a single Hetzner / Vultr VPS

Pros: $5/mo, mirrors what real self-hosters do. Cons: doesn't exercise
the managed-Postgres path that we'll need eventually for Cloud SKU.
**Resolution**: do BOTH — the Dockerfile + compose.prod.yml IS the
self-hosted-VPS path; staging on Fly+Supabase is the managed-path
burn-in. Self-hosters never have to use Supabase.

### Fly.io Postgres + Upstash Redis (no Supabase at all)

Pros: avoids the BYPASSRLS refactor (Fly Postgres allows superuser).
Cons: doesn't burn-in the Supabase compatibility, leaves the refactor
debt for later, contradicts the "validate the multi-cloud target
posture" goal of this whole exercise.

### Wait until ADR-0014 (Cloud SKU) lands before any of this

Pros: aligns with product-lead's blocker. Cons: blocks the canary
step 13 entirely. **Resolution**: this ADR's "internal staging" framing
threads the needle — we burn in the platform compatibility (refactor
+ migration apply) without committing to a customer-facing offering.

## Consequences

### Positive

- Canary step 13 (ADR-0012) has a target instance to flip
  `FEATURE_INSPECTIONS=true` on once UI step 11 lands.
- AGPL self-hosters get a canonical Dockerfile + compose.prod.yml
  reference — addresses persona-fleet-ops' likely default ask of
  "we want to run this on our own infra".
- BYPASSRLS-removal refactor (ADR-0015) lands separately, improving
  portability across managed-Postgres providers.
- SECURITY.md gains the must-haves the security-reviewer flagged.

### Negative

- ADR-0015 is a real chunk of work (~25 call-site refactor + GUC
  rename + tests). Staging is blocked on it.
- The "Free-tier internal staging" budget is fragile — Upstash Free
  is 10 k commands/day, Supabase Free is 500 MB, Fly Free is 3
  shared-cpu-1x machines. None of these are production-shaped.

### Neutral

- Panorama Cloud SKU remains an open question. ADR-0014 will land
  when there's customer signal for it (per product-lead's "no
  monetary commitment before validation" rule).

## Rollback plan

This ADR is doc-only — nothing to roll back at the code layer. The
referenced artefacts (Dockerfile, compose.prod.yml, runbook) land in
separate commits; each is independently reversible by `git revert`.

If the BYPASSRLS refactor (ADR-0015) proves more invasive than
expected, the **fallback is single-VPS self-hosted** for the canary —
a Hetzner droplet at $5/mo running `compose.prod.yml`, no Supabase,
no Fly. The Dockerfile + compose work in this PR is reusable
verbatim. The Cloudflare side (R2 + Pages + DNS) is independent of
the Postgres choice and stays useful.

## Execution order

1. **This ADR** + `SECURITY.md` enrichment + ADR-0015 design draft.
   Single commit batch; doc-only.
2. **`apps/core-api/Dockerfile`** + **`infra/docker/compose.prod.yml`**
   + root **`.env.example`** consolidating deploy vars. Self-hosters
   can use immediately; staging waits on (4).
3. **`docs/en/self-hosting.md`** (canonical AGPL deploy guide) +
   **`docs/runbooks/setup-supabase-staging.md`** (manual steps for
   the maintainer's staging-account setup).
4. **ADR-0015 implementation** — `runAsSuperAdmin` refactor + GUC
   rename + `setInterval`→BullMQ migration for the 24h sweep. Its
   own PR; not part of this commit batch.
5. **Apply migrations 0001–0012 to the staging Supabase project**
   via the SQL Editor (MCP isn't authorised on the secondary
   account). Smoke-test core flows. Document gaps.
6. **ADR-0014 (Cloud SKU + edition placement)** — only if customer
   signal justifies opening the staging instance to a real workload.
   Until then, staging stays maintainer-only.
