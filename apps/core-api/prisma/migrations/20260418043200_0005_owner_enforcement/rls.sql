-- Migration 0005 introduces no new table and no RLS policy change —
-- everything lives inside the trigger function. This empty rls.sql
-- is present so the migration-runner loop (`for rls in .../*/rls.sql`)
-- doesn't need to special-case "migrations without RLS".
SELECT 1;
