# Rollback — migration 0020 (audit trigger digest ms-truncate)

```sql
-- Restore the pre-#96 functions (microsecond `now()` directly,
-- exposing the rounding/truncation mismatch documented in
-- migration.sql).
\\i ../20260426094000_0015_audit_wave1_data_layer_corrections/migration.sql
```

Rollback restores the divergent-digest behaviour. Don't roll back
unless verifier tooling regresses — the fix is forward-compatible
with all prior fires (verifiers that handle the rounding ambiguity
keep working) and uniquely deterministic from this point on.

The cutover marker emitted at apply time (`panorama.audit.chain_repair`
with `metadata.migration = '0020'`) is left in place on rollback
— it's an audit event documenting that the fix WAS applied and
later reverted. Verifier tooling should treat the marker as a
historical waypoint regardless of whether it's still in force.
