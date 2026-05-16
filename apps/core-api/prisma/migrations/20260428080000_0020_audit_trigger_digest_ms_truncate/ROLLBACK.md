# Rollback — migration 0020 (audit trigger digest ms-truncate)

## Pre-flight (operator MUST verify BEFORE running)

This is a forward-only fix; rollback resurrects the divergent-digest
behaviour documented in `migration.sql`. Only roll back if verifier
tooling regresses against the post-0020 digest format — the pre-#96
behaviour was provably unreproducible (per the 2026-05-16 data-
architect scan).

Confirm the regression is real (not transient) before running.

## SQL revert (privileged role)

Run from a psql session against `$DATABASE_PRIVILEGED_URL`. Two
options depending on your working directory:

**Option 1 — from the repo root:**

```bash
psql "$DATABASE_PRIVILEGED_URL" \
  -f apps/core-api/prisma/migrations/20260426094000_0015_audit_wave1_data_layer_corrections/migration.sql
```

**Option 2 — inside psql (from any CWD):**

```sql
\i apps/core-api/prisma/migrations/20260426094000_0015_audit_wave1_data_layer_corrections/migration.sql
```

(The `\i` directive resolves paths relative to the CWD `psql` was
launched from; if you `cd` into the migration directory first, use
`\i ../20260426094000_0015_audit_wave1_data_layer_corrections/migration.sql`
instead.)

This re-applies the pre-#96 trigger functions (microsecond `now()`
directly, exposing the rounding / truncation mismatch documented in
migration 0020's commentary).

## Data-loss warnings

- The cutover marker emitted at apply time (`panorama.audit.chain_repair`
  with `metadata.migration = '0020'`) is **left in place** on
  rollback — it's an audit event documenting that the fix WAS
  applied and later reverted. Verifier tooling should treat the
  marker as a historical waypoint regardless of whether the fix is
  still in force.
- Audit-event rows written DURING the period 0020 was applied
  retain their ms-truncated `occurredAt` digest. These rows are
  correct as written; the rollback does NOT recompute them.

## When you would actually revert

Only if verifier tooling regresses against the post-0020 digest
format AND the regression cannot be fixed in the verifier itself.
The pre-#96 behaviour re-introduces the original bug — prefer to
patch the verifier first.

## Re-apply pattern

Forward-only by design. If 0020 is rolled back and then re-applied
after new audit-event rows have been written:

1. Rows written DURING the rollback window use the pre-0020 (raw
   microsecond `now()`) digest format
2. Re-applying 0020 emits a NEW `panorama.audit.chain_repair`
   marker AND starts ms-truncating again from that marker forward
3. The verifier MUST understand BOTH chain-repair markers as
   "format change points" and apply the correct rounding rule to
   events on each side of each marker

If the verifier doesn't support multi-marker traversal, expect
digest mismatches on rows from the rollback window. There's no
automated remediation — the rows are correct as written; the
verifier needs the multi-marker handling.
