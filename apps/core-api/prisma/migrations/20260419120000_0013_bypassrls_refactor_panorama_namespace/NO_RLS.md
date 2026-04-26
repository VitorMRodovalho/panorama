# NO_RLS — 0013_bypassrls_refactor_panorama_namespace

Migration 0013 IS the RLS infrastructure refactor (ADR-0015 v2).
It defines the `panorama_current_tenant()` helper, the
`panorama_enable_bypass_rls()` SECURITY DEFINER wrapper, the GUC
namespace migration from `app.*` to `panorama.*`, and the
DO-block sweep that re-applies tenant-isolation + super-admin-bypass
policies across every existing tenant-scoped table.

It does not introduce a new tenant-scoped table that would need its
own `rls.sql`. Its work is to FIX the RLS surface globally — every
prior table's policies are rewritten in-place.

## Re-evaluate when

- The next BYPASSRLS-style refactor lands. By design those become
  their own migrations with the same NO_RLS posture.
- A future audit identifies that the sweep missed a table (none
  found in the 2026-04-23 Wave 1 review, but the audit explicitly
  flagged this as a one-shot sweep that won't auto-fire on tables
  landing post-0013 — see migration 0014 §4 cross-tenant FK
  trigger discussion + data-architect blocker B3 from Wave 1).

## Reviewer

- 2026-04-23 audit Wave 1 (data-architect blocker B3) — confirmed
  one-shot sweep is correct for this migration's intent; flagged
  separately that post-0013 tables must each ship their own
  `rls.sql` (followed up in 0014 + 0015)
- 2026-04-26 (audit Wave 2d.F closure) — confirmed at NO_RLS.md
  introduction, paired with `scripts/check-migration-conventions.ts`
