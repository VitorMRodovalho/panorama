# ADR-0015: BYPASSRLS removal refactor + GUC namespace migration

- Status: Accepted (design, 2026-04-19). Implementation in a separate PR.
- Date: 2026-04-19
- Deciders: Vitor Rodovalho
- Reviewers (directional pre-draft pass via ADR-0013):
  - tech-lead — flagged the BYPASSRLS issue as a Supabase blocker
  - data-architect — confirmed BYPASSRLS not allowed on Supabase managed
    Postgres for tenant-created roles; recommended this refactor as a
    prerequisite to any Supabase migration
  - security-reviewer — required `service_role` is forbidden in app code
- Related: [ADR-0003 Multi-tenancy](./0003-multi-tenancy.md),
  [ADR-0013 Staging deploy architecture](./0013-staging-deploy-architecture.md)
  (consumer of this refactor)

## Context

ADR-0003 established the multi-tenancy model:

- **`panorama_app`** — `NOBYPASSRLS`, used by every HTTP request handler.
  RLS policies on every tenant-scoped table check
  `tenantId = panorama_current_tenant()` against the per-transaction
  GUC `app.current_tenant`.
- **`panorama_super_admin`** — `BYPASSRLS`, used for cross-tenant audit
  writes, maintenance sweeps, and a small set of administrative
  operations (membership lookups, last-owner protection, retention
  sweep). Reached via `PrismaService.runAsSuperAdmin`, which inside a
  transaction calls `SET LOCAL ROLE panorama_super_admin`.
- `panorama_app` is granted membership in `panorama_super_admin`
  (via `GRANT panorama_super_admin TO panorama_app`) so the role
  switch works without a reconnect.

This works on self-hosted Postgres because the Postgres superuser
(`panorama` in dev / customer's choice in prod) is allowed to
`CREATE ROLE … BYPASSRLS`.

**It does not work on Supabase managed Postgres.** Supabase's
"superuser-equivalent" role (`postgres`) is in fact restricted —
similar to Cloud SQL's `cloudsqlsuperuser`. It cannot grant
`BYPASSRLS` to a role created by the project owner. Verified across
the data-architect's review and Supabase's own documentation since
the PG15 base image (2024).

The directional review (ADR-0013 §Reviewers) converged on this as a
**hard prerequisite** for any deployment to a managed-Postgres provider
that doesn't ship a customer-controllable superuser. Supabase is the
immediate driver; the same constraint applies to Neon (where `BYPASSRLS`
on user roles is also restricted), AWS RDS Aurora Serverless v2, GCP
Cloud SQL, and Azure Flexible Server.

A second issue surfaced in the same review: the GUC
`app.current_tenant` lives in Postgres' reserved-ish `app.*` namespace,
which Supabase consumes for its own session settings (PostgREST
integration, auth.uid() resolution path). ADR-0012 v3 already
established `panorama.*` as our owned namespace
(`panorama.allow_snapshot_edit`); this refactor extends the precedent
to `panorama.current_tenant` so we own the entire surface and don't
collide with platform reserved keys.

A third issue, unrelated to roles but bundled here because it's also
a Supabase-as-target prerequisite: the photo retention sweep
(`InspectionMaintenanceService.runPhotoRetentionSweep`, 24 h
`setInterval`) loses its clock on Fly.io machine restart. The 24 h
cadence is a DOT 49 CFR §396.3 compliance signal, so a missed sweep
is materially worse than just "delayed by a day". Tech-lead flagged
this as a co-prerequisite for any Fly.io-based deploy — easier to
solve here as part of the same refactor PR than to thread it through
later.

## Prior art

- ADR-0003 §Audit: established `runAsSuperAdmin` as the privileged
  escape hatch.
- ADR-0008 §Rate limits: established the fail-closed pattern for
  Redis-bound services.
- ADR-0012 v3: established `panorama.*` GUC namespace.
- ADR-0011: established BullMQ as the durable-job pattern; the
  invitation-email queue at `apps/core-api/src/modules/invitation/invitation-email.queue.ts:114-117`
  uses a `repeat: { every: 60 * 60 * 1000 }` repeatable job pattern
  that this refactor reuses for the photo retention sweep.

## Decision

### 1. Two Prisma clients, role-separated (path A)

Drop `panorama_super_admin` Postgres role from the contract. Instead,
maintain **two Prisma client instances** in the app process:

```typescript
class PrismaService {
  private readonly appClient: PrismaClient;     // DATABASE_URL
  private readonly privilegedClient: PrismaClient; // DATABASE_PRIVILEGED_URL
}
```

- **`appClient`** — connects as `panorama_app` (NOBYPASSRLS, on
  self-hosted) or `panorama_app`-equivalent custom role we create
  on Supabase. Used by `runInTenant`. Sets
  `panorama.current_tenant` per transaction. **Every HTTP request
  goes through this client.**
- **`privilegedClient`** — connects as the privileged role for the
  target Postgres:
  - **Self-hosted**: as `panorama_super_admin` (existing role,
    BYPASSRLS — the role survives, we just stop *forcing* a runtime
    flip).
  - **Supabase**: as `postgres` (the platform's quasi-superuser,
    which has BYPASSRLS by default on Supabase by virtue of being
    DB owner). **NEVER as `service_role`** — security-reviewer hard
    block; `service_role` is account-root for the whole Supabase
    project and would be visible in Fly secrets, an unacceptable
    blast radius.
  - Used by `runAsSuperAdmin`. Same API surface; different connection.

This preserves the role-based trust boundary (each connection's
identity tells you everything about its capabilities) and avoids the
GUC-based-bypass alternative that data-architect explicitly called
"security-reviewer-hostile."

### 2. GUC namespace migration `app.*` → `panorama.*`

Single namespace for everything we own:

| Before | After |
|---|---|
| `app.current_tenant` | `panorama.current_tenant` |
| `app.bypass_owner_check` (test-helper) | `panorama.bypass_owner_check` |
| `panorama.allow_snapshot_edit` | (already migrated in ADR-0012 v3) |

Migration shape: a single new SQL migration `0013_guc_namespace_panorama`
that:

1. Re-creates `panorama_current_tenant()` to read the new GUC name.
2. `ALTER POLICY ... USING (panorama_current_tenant() = "tenantId")`
   on every existing policy (no logic change; just the helper
   function reads the new GUC).

App-side change: `prisma.service.ts:197` and `:21` switch to
`panorama.current_tenant`. Tests in `_reset-db.ts:21` switch to
`panorama.bypass_owner_check`.

### 3. Photo retention sweep → BullMQ repeatable job

Migrate `InspectionMaintenanceService.runPhotoRetentionSweep` (24 h
`setInterval` at `inspection-maintenance.service.ts:36-37`) to a
BullMQ repeatable job using the same pattern as
`invitation-email.queue.ts:114-117`. Job key
`inspection:photo_retention_sweep` deduplicates on restart so a
machine restart doesn't double-fire or skip-fire.

The hourly stale-IN_PROGRESS sweep + the 2 s notification poll
**stay on `setInterval`** — they're acceptable to lose a poll-cycle
on restart; the photo sweep isn't.

### 4. Boot audit additions

Per security-reviewer's observability ask in the ADR-0013 review,
emit at boot:

- `panorama.boot.db_pool_configured` — payload `{role, host, mode}`
  for each of `appClient` and `privilegedClient`. **NEVER** include
  the URL or password. Defends against a deploy slipping the wrong
  role in.
- `panorama.boot.redis_configured` — payload `{tlsMode}`.

## Refactor scope (file-by-file)

Inventory of the 25 `runAsSuperAdmin` call-sites the refactor must
touch:

- `apps/core-api/src/modules/reservation/reservation.service.ts` — 9 sites
- `apps/core-api/src/modules/tenant/tenant-admin.service.ts` — 5 sites
- `apps/core-api/src/modules/snipeit-compat/pat-auth.guard.ts` — 3 sites
  (verify count at refactor time; tech-lead's review reported 3)
- `apps/core-api/src/modules/reservation/blackout.service.ts` — 3 sites
- `apps/core-api/src/modules/inspection/inspection-maintenance.service.ts` — 2 sites
- `apps/core-api/src/modules/notification/notification.dispatcher.ts` — 4 sites
  (claim, dispatch, mark, rescue; tech-lead reported 4)
- `apps/core-api/src/modules/audit/audit.service.ts` — 1 site
  (`record()` opens own tx — kept; this is the architecturally
  approved escape from the inspection-module forbid-list per
  ADR-0012)

(Counts approximate — `grep` at refactor time will be authoritative.)

The API of `PrismaService.runAsSuperAdmin` does **not** change. It
internally switches from "`SET LOCAL ROLE` on the appClient" to
"call through the privilegedClient". Call sites are unchanged. This
is the entire point of the path-A choice — minimal diff, maximum
preservation of the audit boundary.

## Alternatives considered

### Path B — per-policy GUC carve-out

```sql
ALTER POLICY xxx ON inspections
  USING (
    "tenantId" = panorama_current_tenant()
    OR current_setting('panorama.bypass_rls', true) = 'on'
  );
```

App calls `SET LOCAL panorama.bypass_rls = 'on'` instead of switching
roles. **Rejected** because:

- Trust boundary moves from "Postgres role attribute" (kernel-enforced)
  to "session GUC the app sets" (a SQL-level setting that any
  injection that includes `SET LOCAL …` defeats).
- Easy to forget a policy carve-out — every new RLS policy needs the
  `OR` clause repeated, which is a footgun for the next contributor.
- data-architect explicitly tagged this as "security-reviewer-hostile."

### Path C — Supabase `service_role` JWT for the privileged path

Use Supabase's `service_role` connection (which connects as `postgres`
with a JWT that bypasses RLS via PostgREST's role-claim path).
**Rejected** by security-reviewer hard-block:

- `service_role` is **account-root** for the entire Supabase project.
- It signs JWTs that bypass RLS via PostgREST account-wide.
- Any leak (Fly secret breach, log accident, env-dump bug) compromises
  the whole project — much worse than a `postgres`-user-password leak,
  which only gets you DB access (no JWT signing capability).

### Path D — Don't refactor; stay on self-hosted Postgres only

Keep the `panorama_super_admin` BYPASSRLS role; never deploy to
Supabase. **Rejected** because it forecloses the managed-Postgres path
entirely and locks Panorama into VPS / RDS-with-superuser deployments.
The refactor cost is bounded; the unbounded cost is "we wait until a
customer demands a managed-Postgres deploy and then we're months
behind."

### Path E — Schema-owner pattern (table owner role bypasses RLS unless FORCE'd)

Postgres' default RLS posture lets the table owner read all rows
without policy checks. **Rejected** because we already use FORCE ROW
LEVEL SECURITY on every tenant-scoped table (per ADR-0012 v3
security-reviewer fix). FORCE means even the owner gets RLS-policy'd.
Reverting FORCE re-opens the audit-leak-via-misconfigured-trigger
class of issue that v3 closed.

## Consequences

### Positive

- Supabase migration becomes viable (ADR-0013 staging unblocked).
- `runAsSuperAdmin` API surface unchanged — call sites don't move.
- Trust boundary stays at "which connection are you on?" (kernel-
  enforced via Postgres role attributes).
- Photo retention sweep gains restart-survivability via BullMQ,
  closing the DOT compliance exposure.
- GUC namespace fully consolidated under `panorama.*` — eliminates
  collision risk with any future managed-Postgres provider that
  reserves `app.*`.

### Negative

- Two Prisma clients = two connection pools. Each has its own pool
  size budget; need to size both at deploy time. On Supabase Free
  (60 direct + 200 pooler), this means
  e.g. appClient pool=10 / privilegedClient pool=2.
- Privileged URL (`DATABASE_PRIVILEGED_URL`) is a new env var that
  every deploy needs to set. Must be in Fly secrets, never in the
  Pages env or the web app build.
- `DATABASE_PRIVILEGED_URL` leak is now a single-secret root for the
  DB — **same blast radius as the old superuser password**, but now
  there are TWO connection strings to rotate together.

### Neutral

- The `panorama_super_admin` Postgres role on self-hosted DBs stays
  — the refactor just stops *requiring* a runtime flip. Self-hosters
  set `DATABASE_PRIVILEGED_URL` to connect as that role; on managed
  DBs they connect as the platform's privileged role. Same code
  path on both sides.

## Rollback plan

Pre-implementation: this is a doc-only ADR; revert the file.

Post-implementation rollback: the refactor lands as one PR with two
new SQL migrations (`0013_guc_namespace_panorama` for the GUC rename,
and a follow-up `0014_*` if the BullMQ migration touches schema —
likely no schema touch, since BullMQ stores in Redis). Rollback
sequence:

1. **Code**: `git revert` the refactor PR. App reverts to single-client
   `runAsSuperAdmin` via `SET LOCAL ROLE`.
2. **DB on self-hosted**: revert migration `0013_guc_namespace_panorama`
   — the policies switch back to `app.current_tenant`. Application's
   `prisma.service.ts:197` already uses `app.current_tenant` again
   (came along with the code revert).
3. **DB on Supabase**: ROLLBACK is `app.current_tenant` won't work
   reliably (collides with reserved namespace). The migration is
   one-way for Supabase deployments — rollback means moving Supabase
   data back to self-hosted Postgres. `pg_dump` from Supabase
   to a fresh self-hosted instance, re-apply the original
   `0001_*` migration, restore data. Documented as the cost of
   the path; never apply migration `0013_guc_namespace_panorama` to
   a customer-bearing Supabase instance without a tested rollback
   rehearsal first.

## Execution order (when implementation lands as a separate PR)

1. **Migration `0013_guc_namespace_panorama`** — re-creates
   `panorama_current_tenant()` to read `panorama.current_tenant`,
   `ALTER POLICY` on every existing tenant-scoped table.
2. **`prisma.service.ts` refactor** — add `privilegedClient`,
   rewrite `runAsSuperAdmin` to use it, switch GUC name.
3. **`_reset-db.ts` test helper** — update GUC name.
4. **`InspectionMaintenanceService.runPhotoRetentionSweep` →
   BullMQ repeatable job**. Stale sweep stays on setInterval.
5. **Boot audits** — `panorama.boot.db_pool_configured` × 2,
   `panorama.boot.redis_configured`.
6. **Test suite** — re-run all 280 tests against self-hosted
   Postgres. Add a new test asserting both clients connect under
   the right roles.
7. **Document the env var** in `.env.example` + the deploy runbook.
