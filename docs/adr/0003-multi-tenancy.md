# ADR-0003: Multi-tenancy — row-level with Prisma middleware enforcement

- Status: Accepted
- Date: 2026-04-17
- Deciders: Vitor Rodovalho

## Context

Both Snipe-IT and SnipeScheduler-FleetManager support "companies" — effectively
soft tenants inside a single install. FleetManager has been burned by bugs
where staff in Company A saw Company B's data because a query forgot a
`WHERE company_id = ?` clause (see the 2026-03-12 audit).

We need to make "forgetting the tenant filter" **impossible by construction**.

Three common approaches:

1. **Schema-per-tenant** — one Postgres schema per company. Strong isolation,
   but each schema migration is O(tenants) and Postgres doesn't love thousands
   of schemas.
2. **Database-per-tenant** — strongest isolation; ops nightmare at scale.
3. **Row-level with a `tenant_id` (company_id) column** on every tenant-owned
   table, enforced consistently at the query layer.

## Decision

**Row-level with Prisma middleware**, plus Postgres **Row-Level Security (RLS)**
as a defence-in-depth layer.

### Rules

- Every tenant-owned table has a non-null `company_id uuid NOT NULL`.
- Every request opens a per-request Prisma client with `company_id` in context.
- A Prisma middleware rewrites every `findMany`, `findUnique`, `findFirst`,
  `update`, `delete`, `count`, and `aggregate` to include `company_id =
  ${ctx.company_id}` unless the caller is explicitly
  `requestScope('cross-tenant')` (used only by Super Admin dashboards, the
  migration tool, and backups).
- In parallel, Postgres RLS policies enforce the same predicate at the DB
  layer, keyed off a session variable `app.current_tenant`. This is set via
  `SET LOCAL` at the start of each transaction.
- We run **tests** that try to cross-tenant by bypassing middleware and
  confirm RLS rejects them. If RLS were ever misconfigured, middleware still
  catches it; if middleware were ever bypassed, RLS still catches it.

### Super Admin and cross-tenant flows

- A Super Admin session runs with `app.current_tenant = NULL`; the RLS policy
  permits NULL only for roles granted `panorama_super_admin`.
- Audit log rows for a cross-tenant action include the admin's user_id AND the
  tenant_ids they touched.

### Exceptions

- `users` and `auth_identities` are **global** (a user can belong to more than
  one company). Joining tables carry the `company_id`.
- System-wide settings (feature flags, cluster keys, encryption KMS refs)
  live in an unscoped `panorama_system` schema that middleware never touches.

## Alternatives considered

- **Schema-per-tenant** — rejected: migration tooling and Postgres connection
  pooling become painful beyond ~200 tenants.
- **Rely on middleware only (no RLS)** — rejected: the 2026-03-12 FleetManager
  audit already proved that one careless query ships to prod.
- **Rely on RLS only** — rejected: silent "zero rows" results are confusing to
  application code; middleware surfaces the tenant context explicitly and
  fails loudly if missing.

## Consequences

### Positive
- "Forgetting the filter" is impossible in two independent layers
- Contributors can reason about tenancy locally; they write plain Prisma
  queries and the middleware handles it
- Super Admin flows are explicitly opt-in; they stand out in code review

### Negative
- A small performance cost on every query (1 extra predicate, 1 `SET LOCAL`)
- RLS requires the database user running queries to **not** be a Postgres
  superuser; we need a least-privilege app role in ops docs
- Debugging a "missing" row requires checking the tenant context and the user's
  role — docs must be clear

### Neutral
- This locks us into Postgres. We're fine with that; Prisma portability to
  MySQL is not a goal.
