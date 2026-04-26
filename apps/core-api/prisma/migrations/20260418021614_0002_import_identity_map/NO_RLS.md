# NO_RLS — 0002_import_identity_map

Migration 0002 introduces `import_identity_map` — a system-scoped
table that maps Snipe-IT legacy ids to Panorama UUIDs during the
import roundtrip. It has no `tenantId` column by design: a single
import run touches multiple tenants, and the mapper is consumed only
by the migrator binary running under a privileged role
(`panorama_super_admin` with `panorama.bypass_rls = 'on'`).

There is no tenant-routed reader path that should see this table.
panorama_app cannot SELECT it — the GRANT in 0001/rls.sql does not
extend to system tables, which is the right shape. RLS would add
ceremony without a security gain because the access surface is
already gated at the role + grant layer.

## Re-evaluate when

- A non-import code path needs to read import_identity_map (very
  unlikely; the table is only referenced by the migrator).
- A tenantId column is added (e.g., per-tenant import audits) — at
  which point this NO_RLS.md must be deleted and a real `rls.sql`
  authored.

## Reviewer

- 2026-04-23 audit Wave 1 (data-architect) — confirmed system-scope
- 2026-04-26 (audit Wave 2d.F closure) — confirmed at NO_RLS.md
  introduction, paired with `scripts/check-migration-conventions.ts`
