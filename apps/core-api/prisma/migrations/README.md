# Prisma migrations

Prisma generates SQL migrations under this directory. Every migration folder
has a `migration.sql` file auto-generated, plus a `ROLLBACK.md` file **you must
write by hand** describing how to undo the migration safely.

## Rollback note template

Copy this into `YYYYMMDD_HHMMSS_<name>/ROLLBACK.md` alongside every migration:

```markdown
# Rollback: <migration name>

Risk class: low | medium | high  (destructive drops are always high)

Manual rollback steps:
1. Restore from the nightly backup taken before the migration window.
2. Replay only non-destructive DML since the backup.

Automated rollback: <not supported | see `down.sql`>

Data loss: <none | columns X, Y | entire table Z>

On-call runbook link: <...>
```

## RLS policies

Prisma doesn't model Row-Level Security. Every migration that creates a
tenant-owned table **must** include a hand-written SQL file:

```
<migration>/rls.sql
```

A typical policy:

```sql
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON assets
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY super_admin_bypass ON assets
  FOR ALL
  TO panorama_super_admin
  USING (true);
```

The `apps/core-api/prisma/rls-check.sql` file runs in CI and asserts that every
`tenant_id`-bearing table has an RLS policy. Contributors that add a new
tenant-owned table without a policy will see CI fail loudly.
