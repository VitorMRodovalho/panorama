# Rollback — migration 0016 (per-trigger UNIQUE)

Drops the two per-trigger UNIQUE partial indexes added by 0016.
Safe in either direction. After rollback the auto-suggest retry
race becomes possible again under multi-pod scaling — single-pod
deploys today are unaffected because the dispatcher's claim
mechanism + per-event runInTenant scoping keeps duplicate dispatch
of a single event impossible inside one process.

```sql
BEGIN;

DROP INDEX IF EXISTS "asset_maintenances_open_per_inspection_unique";
DROP INDEX IF EXISTS "asset_maintenances_open_per_reservation_unique";

COMMIT;
```

The `asset_maintenances_open_per_asset_partial` index from
migration 0014 is unaffected — 0016 did not modify it. After
rollback, the close-ticket / stale-sweep queries continue using
that index.

Code rollback (`git revert` of the implementation commit) is not
required for the indexes alone. The `openTicketAuto` 23505 catch
path becomes unreachable but compiles and is dormant — it returns
`status: 'opened'` for new triggers and falls back to compare-
then-act for existence checks, which is the v2 behaviour shipped
in #132.

## Pre-flight check (before re-applying after rollback)

```sql
SELECT "tenantId", "triggeringInspectionId", count(*)
  FROM "asset_maintenances"
 WHERE "triggeringInspectionId" IS NOT NULL
   AND status IN ('OPEN', 'IN_PROGRESS')
 GROUP BY "tenantId", "triggeringInspectionId"
HAVING count(*) > 1;

SELECT "tenantId", "triggeringReservationId", count(*)
  FROM "asset_maintenances"
 WHERE "triggeringReservationId" IS NOT NULL
   AND status IN ('OPEN', 'IN_PROGRESS')
 GROUP BY "tenantId", "triggeringReservationId"
HAVING count(*) > 1;
```

Both empty = safe to re-apply 0016. Non-empty = manually resolve
the duplicate-trigger tickets first (cancel the stale duplicate)
before retrying.
