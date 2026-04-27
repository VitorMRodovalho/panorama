# Rollback — migration 0018 (reservation overdue flag)

Drops the `isOverdue` column + the supporting partial index. Safe
to revert as long as `ReservationSweepService` has been redeployed
without code that references the column (or revert the
implementation commit first).

```sql
BEGIN;

DROP INDEX IF EXISTS "reservations_overdue_partial";

ALTER TABLE "reservations"
    DROP COLUMN IF EXISTS "isOverdue";

COMMIT;
```

Historical audit rows
(`panorama.reservation.flagged_overdue` /
`panorama.reservation.no_show`) emitted before rollback stay in
`audit_events` — they don't reference the column directly, so
rollback is clean.

Code rollback path: `git revert <implementation commit>` removes
the sweep service + the controller / list-page references. The
sweep stops firing on FEATURE flag flip-off OR on service
unwiring; reverting alone (without code revert) leaves the column
gone but the service compiles + crashes at runtime. Roll BOTH or
NEITHER.
