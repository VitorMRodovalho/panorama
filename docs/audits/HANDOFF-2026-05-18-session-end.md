# HANDOFF — 2026-05-18 session end

> **Session ended at maintainer's request.** Comprehensive day:
> 10 PRs total (9 merged + 1 open), Wave 0 §10 closed (autonomous
> portion), the first executed restore drill landed, and the URL
> flip is now gated on TWO maintainer decisions (read this doc +
> the ADR-0014 amendment) plus one external blocker (counsel review).

## Two MDs the maintainer needs to read for the next session

To resume the URL-flip workstream, read these in order:

### 1. `docs/audits/HANDOFF-2026-05-18-v2-6agent-scan.md` (synthesis)

**[Merged in PR #252; lives in main.](https://github.com/VitorMRodovalho/panorama/blob/main/docs/audits/HANDOFF-2026-05-18-v2-6agent-scan.md)**

The 2026-05-18 v2 6-agent scan synthesis. Verdict: 1 GO +
5 CONDITIONAL + 0 NO-GO. CONDITIONAL items all closed in PR #252
(autonomous fixes) + the ADR-0014 amendment (commitments). External
blockers (PR2b drill + counsel review) are tracked separately.

**Why read first:** establishes the rationale + provides the context
for the amendment in §2 below. Without this synthesis, the
amendment text reads as arbitrary commitments; with it, every
commitment ties to a named agent's named finding.

### 2. `docs/adr/0014-public-hosted-instance.md` §"Amendment — 2026-05-18 v2 scan close-out"

**[Merged in PR #252; lives in main at the bottom of ADR-0014.](https://github.com/VitorMRodovalho/panorama/blob/main/docs/adr/0014-public-hosted-instance.md#amendment--2026-05-18-v2-scan-close-out)**

The formal URL-flip decision document. **Status: Proposed.** Your
commit flipping `Status: Proposed` → `Status: Accepted` IS the formal
URL-flip authorization.

Sections to validate:

- §6 — Capacity soft cap at 25 active tenants (you can adjust the
  number if your operational cost analysis says different)
- §7 — Customer-discovery date-bound commitment (3 partners /14
  days, first call /21 days). **Adjust dates or scope if your
  outreach timeline is different.**
- §8 — Exit ramp restate (30-day notice + tenant export + self-host
  migration path). Already accurate; just confirm.
- §9 — Enterprise-positioning forward-looking footer (pre-revenue,
  Community-only). Already accurate.
- §10 — Counsel-review commitment (v2 lands before first paying
  tenant). Already accurate.
- §11 — Pre-flip condition list. **Verify items §11-1 through §11-8
  are all closed in main** (they are, per PR #252 + PR #253). The
  two external items (§11-9 PR2b + §11-10 counsel review) need YOUR
  action.
- §12 — Post-flip operational cadence (quarterly drills, day-60
  metrics review, weekly chain-verify on staging).
- §13 — Rollback path for the URL flip (FEATURE_SELF_SERVE_SIGNUP
  toggle + Fly scale 0 + amendment-2).
- §14 — Verdict: CONDITIONAL GO.

**Your decision when committing this amendment as Accepted:** you
are formally authorizing the URL flip. The act is a single git
commit; the DNS / Cloudflare / Fly mechanics ship in a sibling
commit per the amendment's implementation notes.

## Open work the maintainer can choose to act on

### Open PRs

| # | Title | Status | What it needs |
|---|---|---|---|
| #253 | Round 6 PR2b — first executed restore drill | OPEN, CI-green 14/14 | Maintainer review + merge (closes Wave 0 §8 acceptance) |

All other session PRs are merged. No queue depth from this session.

### External blockers (maintainer-hands-on)

| Item | What | Status |
|---|---|---|
| **Counsel review on `/legal/{privacy,terms}`** | Brazilian-LGPD-qualified lawyer engagement | Not started (you said: not blocking now, will read + discuss later) |
| **PR2b' staging-source drill** | Spin up throwaway Supabase project; run drill against it for real-shape RTO numbers | Deferred — pairs with the quarterly drill cadence post-URL-flip |
| **ADR-0014 amendment Status: Accepted commit** | The formal URL-flip authorization | Awaits PR #253 merge + your read of the two MDs above |

### Autonomous follow-ups Claude can pick up next session

Per the roadmap doc + the v2 scan's "soft observations" (not URL-flip blockers):

- **Migration discipline runbook** — `docs/runbooks/migration-discipline.md` for future audit-column renames (data-architect §5)
- **ADR clarification on RLS-by-omission convention** — for the tenant export / deletion / verification tables (tech-lead §2)
- **Boot-audit warning if `THROTTLER_ENABLED` is unset in production** — extends security-reviewer §3-2's docs-only fix to runtime enforcement
- **`secrets-rotation-due` + `restore-drill-due` + `incident-drill-due` GitHub Actions crons** — issue openers that enforce quarterly cadence
- **Wave 0+ PR1 — ADR-0021 implementation start** — features/ folder scaffold + ESLint encourage-extraction rule
- **Wave A PR1 — Migration 0027 Teams + hierarchical schema** — once Wave 0 closes officially

## Session summary — 2026-05-18

### PRs landed in main (9 merged)

| # | Title | Wave |
|---|---|---|
| #240 | Round 6 PR3 — secrets-rotation matrix + `AuditEvent.requestId` (migration 0026) | 6 |
| #241 | Round 6 PR2a — restore drill script + runbook | 6 |
| #242 | docs(roadmap) — 5-agent planning round + 4 decisions logged | strategic |
| #243 | Round 7 §9 — status page + monitoring | 7 |
| #244 | Round 7 §9 — CycloneDX SBOM + cosign keyless signing | 7 |
| #245 | Round 7 §9 — Privacy + ToS plain-language v1 | 7 |
| #250 | docs(adr-0021) — Web frontend architecture | strategic |
| #251 | docs(adr-0022) — Driver native mobile architecture (Expo) | strategic |
| #252 | Round 7 §10 — v2 6-agent scan + ADR-0014 amendment + 8 surgical fixes | 7 |

Plus #253 open (PR2b drill artefact).

### Operational changes applied

- **Migration 0026** (`audit_events.requestId TEXT NULL`) applied to Supabase staging.
- **Status page workflow** (PR #243) now firing on cron every 15 minutes against `panorama.vitormr.dev/`. No outages auto-reported yet.
- **SBOM workflow** (PR #244) regenerates on every push to main that touches `package.json` / `pnpm-lock.yaml`. Cosign signing fires only on `v*` release tags (no release tagged this session).

### Strategic decisions logged (in `roadmap-to-feature-complete-2026-05-18.md` §"Decision points — RESOLVED")

1. Wave A first (Teams + AssetAssignment) over Wave B (Driver Mobile)
2. Hierarchical teams (parentTeamId tree structure)
3. Native React Native / Expo app over PWA (overrides product-lead anti-goal)
4. Roadmap commits as separate planning PR off main

### ADRs flipped to Accepted in PR #252

- **ADR-0021** (Web frontend architecture) — gates Wave 0+ and Wave A web work
- **ADR-0022** (Driver native mobile architecture) — gates Wave B Expo work + protected against URL-scheme hijack via Universal Links primary

### v2 scan surgical fixes shipped in PR #252

1. OIDC error log sanitization (signup.controller.ts)
2. `THROTTLER_ENABLED=1` mandatory prod doc (secrets-inventory.md)
3. ADR-0022 Universal Links primary (security-reviewer §3-3)
4. `docs/en/roadmap.md` mobile-app drift fix (Wave B placement)
5. `/legal/*` ES placeholder copy fix (no longer references missing language switcher)
6. `docs/index.md` honesty band (preview disclaimer)
7. ADR-0021 Status: Proposed → Accepted
8. ADR-0022 Status: Proposed → Accepted

### PR2b drill (PR #253) — script patches discovered + shipped

Five general-purpose drill-script improvements:

1. Docker pg-client fallback for cross-major-version source/target drift
2. Pre-restore bootstrap split (extensions before pg_restore; rls.sql after)
3. `--force-truncate-dst` unconditional drop+recreate of public schema
4. Absolute `OUT_DIR` resolution (chain-verify step is cd-sensitive)
5. `--exclude-schema` list for Supabase-source dumps

### What didn't ship this session

- **PR2b' staging-source drill** — hit several Supabase-flavored extension incompatibilities; documented in the drill artefact README. Requires a Supabase target project to drill cleanly. Operator-paced post-URL-flip work.
- **Counsel-reviewed Privacy/ToS v2** — external lawyer engagement, deferred to first paying-tenant trigger per ADR-0014 amendment §10.

## Wave 0 closure state — final

| Acceptance item | Status |
|---|---|
| §1-7 (Rounds 1-5) | ✅ |
| §8 docs (incident + secrets-rotation + restore + drill script) | ✅ |
| §8 first executed drill (PR2b) | ⏳ PR #253 awaits merge — closes §8 fully on merge |
| §9 status page | ✅ Workflow live, cron firing |
| §9 SBOM + cosign | ✅ Workflow ready for first release tag |
| §9 Privacy/ToS v1 | ✅ |
| §9 counsel review | ⏳ External maintainer action; **NOT blocking for this session's exit** |
| §10 v2 6-agent scan | ✅ |
| §10 ADR-0014 amendment drafted | ✅ Status: Proposed |
| §10 amendment commit as Accepted = URL flip authorization | ⏳ Maintainer commits next session after reading the two MDs above |

## Local-environment cleanup done at session end

- Temporary PG17 Docker containers (`panorama_drill_pg17`, `panorama_drill_supabase`) removed.
- Local drill-target sibling database (`panorama_drill_target`) on the dev-stack postgres dropped.
- Local `source.dump` files from drill attempts deleted from `docs/audits/restore-drill-*/` paths under the working tree (gitignored, but cleared for clean filesystem state).
- Working tree clean on `main` post-session-end-commit.

## Pickup brief — when maintainer types "continue" next session

If the maintainer types "continue" with no further instructions, the
default action is:

1. **Surface this HANDOFF + the two MDs above (their permalinks).**
2. **Wait for maintainer's reading + decision** on the ADR-0014
   amendment.
3. **If maintainer authorizes merge**: merge PR #253 (closes §8) +
   any other operational sweep.
4. **If maintainer authorizes URL flip**: commit ADR-0014 amendment
   with `Status: Accepted` + execute the DNS / Cloudflare / Fly
   mechanics per the amendment's implementation notes.
5. **If maintainer authorizes feature-wave start**: begin Wave 0+
   PR1 (features/ folder scaffold + ESLint encourage-extraction
   rule per ADR-0021 §1).

The session-end memory file (`project_2026_05_18_session_end.md`)
carries the same brief in machine-readable shape for next-session
context inheritance.

## Stat sheet

- **Commits to main today**: 9 (one of which carries 23 file changes
  for the §10 closure)
- **Files changed**: ~50+ across all 9 merged PRs
- **Lines added/modified**: 5,000+ across docs + code
- **Migrations applied to staging**: 1 (0026)
- **Test pass rate**: 523/523 throughout
- **CI green rate**: 14/14 on every PR push (one PR had a lint
  fix-up on second push)
- **Per-PR scans completed**: 2 full 5/6-agent reviews + 1
  per-PR-light review

Good night. The URL flip is one merge + one amendment commit away.
