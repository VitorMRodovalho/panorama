# Rollback: 0002_import_identity_map

Risk class: **low** — additive, single new table, no FKs from other tables
pointing into it.

## What this migration creates

- Table `import_identity_map` with index on `(source, entity, source_id)`
  (unique) and on `(source, entity, panorama_id)`

## Manual rollback

```sql
DROP TABLE IF EXISTS import_identity_map;
```

No data loss beyond the import audit trail (the mapping between legacy IDs
and Panorama UUIDs). If rolled back, a subsequent re-import cannot be
idempotent: running the importer again would create duplicate rows. Only
roll back if the table is empty or if you intend to start importing from
scratch.

## RLS

None. `import_identity_map` is NOT tenant-scoped — migrations are
super-admin operations and the mapping spans tenants. The app role
(`panorama_app`) does not need access; only `panorama_super_admin`
reads/writes this table.
