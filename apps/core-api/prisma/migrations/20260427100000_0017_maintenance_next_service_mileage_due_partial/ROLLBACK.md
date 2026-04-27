# Rollback — migration 0017 (mileage-arm partial index)

Drops the partial index added by 0017. Safe in either direction.

```sql
DROP INDEX IF EXISTS "asset_maintenances_next_service_mileage_due_partial";
```

After rollback, the PM-due sweep's mileage arm falls back to a
heap scan filtered by tenantId/status. Single-tenant deploys with
modest historical-ticket counts will still complete the daily
sweep in seconds; large fleets (>10k completed tickets per
tenant) will see the cron run-time degrade.

No code rollback required — the sweep query references the index
implicitly via the planner's choice, not by name.
