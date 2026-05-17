# Rollback — 0023 email_verifications

## Pre-flight (operator MUST verify BEFORE running)

This migration creates ONE table (`email_verifications`) used by the
ADR-0020 §3 self-serve signup verify-endpoint pair. Rollback drops
the table.

Only roll back if PR 2's verify endpoint + signup-callback
mint-dispatch hook are also reverted — the EmailVerificationService
references `prisma.emailVerification` and a missing table would crash
every signup callback while leaving Prisma's typed client in a drift
state.

## SQL revert (privileged role)

Run from a psql session against `$DATABASE_PRIVILEGED_URL`.

```sql
DROP TABLE "email_verifications";
```

The FKs ON DELETE CASCADE keep the table self-contained — dropping
the table does not affect `users` or `tenants`.

## Data-loss warnings

- **All pending verification tokens are dropped.** Tenants that signed
  up via PR 1 + PR 2 but did not yet consume their verification token
  lose the token row entirely. Without the table, those tenants
  cannot be verified through the standard flow.
- **`Tenant.pendingVerification` flag stays in place** (migration
  0022). Pending tenants remain in `pendingVerification=true`
  state, which means `buildSessionForUser` (PR 1) refuses sessions on
  them. Operator-driven workaround: super-admin can UPDATE
  `tenants.pendingVerification = false` directly.

## When you would actually revert

- PR 2 (verify endpoint + signup-callback mint-dispatch hook) is
  being rolled back as part of a broader Wave 0.5 revert and the
  table is now dead schema.
- The `email_verifications` shape turns out to be unworkable for the
  verify flow (extremely unlikely — the field set is the minimal
  viable surface for a token + TTL + one-time-use pattern).

## Re-apply pattern

Forward-only by design. Re-applying after a rollback is a clean
additive operation; no data backfill needed.

## Schema implications

`schema.prisma` was updated to add the `EmailVerification` model +
back-relations on `User` and `Tenant`. A revert of THIS migration
must also revert those edits — otherwise `prisma migrate status`
will diff against the rolled-back DB.

## Production migration timing

- `CREATE TABLE` is fast; on Postgres it takes ACCESS EXCLUSIVE on
  the new relation only (which doesn't exist yet, so no contention).
- The FK references `users(id)` + `tenants(id)` validate the FK
  constraint against existing rows — instantaneous on a new empty
  table.
- No trigger, function, or RLS policy changes.
