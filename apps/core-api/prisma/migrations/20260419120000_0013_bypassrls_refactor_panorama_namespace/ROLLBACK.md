# Rollback: 0013 BYPASSRLS refactor + GUC namespace migration

> **Read first**: rolling this back without rolling back the
> `prisma.service.ts` refactor (same commit) leaves the application
> trying to call `panorama_enable_bypass_rls()` against a function
> that no longer exists. Code + DB rollback MUST land together.

## Sequence (run as the privileged Postgres role)

```sql
BEGIN;

-- 1. Restore the v1 panorama_current_tenant() to read the old GUC.
CREATE OR REPLACE FUNCTION panorama_current_tenant() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE raw text;
BEGIN
    raw := current_setting('app.current_tenant', true);
    IF raw IS NULL OR raw = '' THEN RETURN NULL; END IF;
    RETURN raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END $$;

-- 2. Drop the privileged-bypass policies on every tenant-scoped table.
DO $$
DECLARE tbl record; pname text;
BEGIN
    FOR tbl IN SELECT tablename FROM pg_tables
               WHERE schemaname = 'public' AND rowsecurity = true LOOP
        pname := tbl.tablename || '_super_admin_bypass';
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pname, tbl.tablename);
    END LOOP;
END $$;

-- 3. Drop the SECURITY DEFINER bypass function.
DROP FUNCTION IF EXISTS panorama_enable_bypass_rls();

-- 4. Restore the v1 GRANT (the migration revoked it; rollback re-grants).
GRANT panorama_super_admin TO panorama_app;

-- (The migration does NOT drop BYPASSRLS from the role on self-hosted,
-- so rollback doesn't need to restore that attribute.)

-- 5. Manually delete the migration record so a future re-deploy
--    re-applies cleanly. (Prisma's `_prisma_migrations` table.)
DELETE FROM _prisma_migrations
 WHERE migration_name = '20260419120000_0013_bypassrls_refactor_panorama_namespace';

COMMIT;
```

## App-side rollback

```bash
git revert <the v2 implementation commit>
git revert <the ADR-0015 v2 doc commit>
docker compose build core-api
docker compose run --rm migrator   # would be a no-op; the SQL above
                                    # already removed the migration row
```

## Why this is safe to roll back

- The v1 GUC `app.current_tenant` is set by the rolled-back
  `prisma.service.ts:197`. Both old + new code coexist for 1 deploy
  if you stagger code + DB rollback (avoid this).
- No schema changes to user data — only function/role/policy DDL.
- No data migration — `inspection_photos`, `audit_events`, etc. are
  untouched.

## When you can NOT roll back cleanly

- After a customer workload runs against the new (post-0013) DB and
  app, the audit_events chain has rows where the privileged path was
  used via the new bypass function. Rolling back the DB doesn't roll
  back those rows; the audit chain stays intact (no integrity break).
- After the optional migration `0014_*` (BullMQ photo retention) lands
  on top, you must roll back 0014 first.
