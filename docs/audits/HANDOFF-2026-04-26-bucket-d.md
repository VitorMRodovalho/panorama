# Audit Resolution Handoff — 2026-04-26 (Bucket D in progress)

Continuation of `HANDOFF-2026-04-23.md`. Documents what landed in
session 2026-04-26 and what's queued next.

## Session 2026-04-26 — what landed (19 issues, 14 merged PRs)

### Bucket A (security + correctness)
| PR | Issues | Note |
|----|--------|------|
| #88 | #28 OIDC email_verified | Workspace `hd` override + audit event |
| #94 | #35 SESSION_SECRET fallback | Throw at boot in every env |
| #95 | #30 #41 #42 #43 #65 (migration 0015) | RLS GUC, prevHash chain, FK, dedup, index — bundled |
| #99 | #71 migration convention checker | scripts/check-migration-conventions.ts + 3 NO_RLS |

### Bucket G (CI hardening)
| PR | Issues | Note |
|----|--------|------|
| #100 | #69 #72 | community-complete TS + drop e2e + pin gitleaks |
| #102 | #66 | ESLint flat-config core-api |
| #103 | #67 | ESLint via next lint web |
| #105 | #70 | Coverage 80/70/80/80 baseline |

### Bucket C (supply-chain)
| PR | Issues | Note |
|----|--------|------|
| #106 | #81 | pnpm.overrides multer >=2.1.1 |
| #107 | #80 | nodemailer 6→8 + recipient gate |
| #108 | #82 | file-type 19→22 + transitive override |
| #110 | #79 | Next 14→15 + React 19 + async dynamic APIs |
| #111 | #83 #68 | .trivyignore + flip Trivy gate |

### Follow-ups opened (11 issues)

#89 parseDomainList syntax validation, #90 panorama.auth.* namespace
registry, #91 panorama.auth.oidc_login success event, #92 OIDC
integration test, #93 CI MinIO+MailHog services, #96 chain_repair
metadata.fixed_functions, #97 audit-trigger digest test, #98
audit_events tail SELECT contention canary, #101 typescript-eslint
no-unsafe-* ratchet, #109 web ESLint flat-config when next ships
flat, #93 CI services (already listed).

### Tags

- `pre-next15` (origin) — rollback target for #110.

## Bucket D — RLS migration (in progress / next session)

Goal: migrate ~25 `runAsSuperAdmin` call-sites to `runInTenant`
where the operation is tenant-scoped. Defense-in-depth: RLS is a
safety net even if the application logic has a tenant-scoping bug.

### State

- ADR-0015 v2 implementation IS done (migration 0013 +
  PrismaService two-client pattern + `panorama_enable_bypass_rls()`
  SECURITY DEFINER function). The "BYPASSRLS refactor" referenced
  in older memory is the SQL+PrismaService side, already shipped.
- What remains is purely call-site migration on the application
  layer.

### Issue map

| Issue | Severity | Sites | Service |
|---|---|---|---|
| **#55** RLS-01 | critical/sec | 9 | reservation.service.ts |
| **#37** ARCH-02 | high/sec | (≈ same as #55) | Wave 1 rollup of #55 |
| **#56** RLS-02/03/05/06 | high/sec | 11 | blackout, PAT, invitation, PAT-guard |
| **#57** RLS-04 | medium/sec | 5 | tenant-admin.service.ts |
| **#58** RLS-CI | high/CI | — | CI allowlist gate (after the migrations land) |

### Migration pattern

```ts
// Before:
return this.prisma.runAsSuperAdmin(
  async (tx) => { /* queries scoped by actor.tenantId */ },
  { reason: '...' },
);

// After:
return this.prisma.runInTenant(
  actor.tenantId,
  async (tx) => { /* same queries; RLS now also enforces */ },
);
```

The two-arg signature for `runInTenant` is `(tenantId, cb)`. The
`reason` metadata used by `runAsSuperAdmin` is for the audit
"super-admin escape" trail and doesn't apply to `runInTenant`
(which is the default tenant-scoped path).

### What to verify per site

1. The operation IS tenant-scoped (queries filter by tenantId).
   Most are. The few cross-tenant cases (e.g., audit hash chain
   read inside a trigger function — already SECURITY DEFINER) stay
   on `runAsSuperAdmin`.
2. RLS policies on the affected tables exist (they do — every
   tenant-scoped table has been policied since migration 0001).
3. The test suite still passes — no test relies on cross-tenant
   visibility of a query that was previously running under
   superadmin. If a test does, it's exposing a real RLS gap.

### Rollout plan (session 2026-04-26 + next)

| PR | Issue | Sites | Risk |
|----|-------|-------|------|
| 15 | **#55** reservation | 9 | low — single file, all sites tenant-scoped |
| 16 | **#56** blackout/PAT/invitation/PAT-guard | 11 | medium — 4 services, possible cross-tenant probes |
| 17 | **#57** tenant-admin | 5 | medium — admin operations sometimes cross-tenant |
| 18 | **#58** CI allowlist gate | — | low — script only |

#37 closes alongside #55 (same scope per audit cross-ref).

### Reviewers per PR

- `security-reviewer` veto on every one (auth/RLS/tenant code).
- `tech-lead` veto on architectural concerns (per-PR is fine here
  because it's the same pattern repeated).
- Optional `data-architect` if a query-plan question surfaces.

### Blockers / known caveats

- **PrismaService.runInTenant** sets `panorama.current_tenant`
  GUC for the transaction. Code that crosses tenants inside one
  callback (e.g., the cross-tenant FK trigger in migration 0014)
  must keep using `runAsSuperAdmin`. Verify each call-site doesn't
  have such a cross-tenant assumption hidden in subqueries.
- **Audit writes** via `AuditService.recordWithin(tx, ...)` work
  on either client because the audit trigger writes the row
  through a SECURITY DEFINER function (after #95). Don't refactor
  the audit-write paths unless a specific test fails.

### Smoke test gate before merging each PR

Run the full `pnpm test` suite. The 308 tests cover the affected
modules (reservation has its own e2e + unit, invitation has e2e,
PAT has e2e). A red test in the migrated module is the canary —
investigate before iterating.

## Open buckets (need user input, not session-closeable)

- **B** — #31 #32 #74 (asset maintenance) — paused at ADR-0016
  step 3 (KeyShape registry) since 2026-04-19. Next-session
  decision: resume that work, or push to 0.4?
- **F** — #84 #85 #86 #87 (governance + plugin-sdk redesign) —
  needs maintainer decisions, not code work.
- **E** — UX gaps (#33, #44–#48, #50–#52) — bloqueado em design.
- **H** — #59-#64 perf/observability — backlog 0.4.

## Pre-pilot exit criteria reminder

Per audit Wave 3 / HANDOFF-2026-04-23.md, the pilot blockers were:
#74, #28, #30, #75, #31, #29. With session 2026-04-26 work:

- ✅ #28 OIDC closed
- ✅ #30 RLS GUC closed
- ❌ #29 ARCH-01 inspection-maintenance runAsSuperAdmin —
  STILL OPEN, **belongs in Bucket D scope** (was missed in
  session 2026-04-26's bucket survey; surface in next session)
- ❌ #31 lastReadMileage — Bucket B
- ❌ #74 maintenance UI — Bucket B
- ❌ #75 invitation UI — Bucket E (UX)

So the next-session attack on Bucket D should also include #29
(inspection-maintenance) as a 5th PR if it falls out of the
RLS-migration sweep.

## How to resume

1. Read this file end-to-end.
2. Read `docs/adr/0015-bypassrls-removal-refactor.md` §"Refactor
   scope (file-by-file)" for the call-site inventory.
3. `gh issue view 55` for the canonical scope.
4. `git checkout -b fix/rls-migration-reservation` and start at
   `apps/core-api/src/modules/reservation/reservation.service.ts`
   line 148. Work through the 9 sites in file order.
5. Run reviewer agents (security-reviewer + tech-lead) before
   pushing.
6. Update `MEMORY.md` with this session's summary if it lands.

## Risk register (for the maintainer)

- **CI is informational, not enforced.** Repeating from the prior
  session: required_status_checks is not enabled on main per the
  branch-protection check. CI red since 2026-04-19 due to MinIO +
  MailHog services missing in the workflow (see #93). Don't
  depend on CI to catch regressions until #93 lands.
- **The 1-hour CVE-2026-4800 expiry is calendared for 2026-07-23.**
  Re-triage that .trivyignore entry before then or the expiry
  marker becomes a latent bug.
- **The ESLint ratchet (#101) is the next durable cleanup.** ~6
  rules off; per-module flips would steadily improve signal.
