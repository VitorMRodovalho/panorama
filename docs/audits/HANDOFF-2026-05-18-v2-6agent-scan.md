# HANDOFF — Wave 0 §10 v2 6-agent scan (2026-05-18)

> **Status.** This document is the §10 closeout artefact for the v2
> 6-agent scan on the closed-blocker delta from Rounds 1-7. Companion
> deliverables: the **ADR-0014 amendment** (URL-flip go/no-go decision
> + capacity cap + customer-discovery commitment) and the **v2 scan
> surgical fixes PR** (autonomous CONDITIONAL items addressed in code).

## TL;DR

**Verdict tally:** 1 GO + 5 CONDITIONAL + 0 NO-GO across the 6 agents.

**Aggregate verdict:** **CONDITIONAL GO** on the URL flip, gated on:

- **Three external blockers** (maintainer-hands-on, cannot be closed by autonomous work):
  - PR2b restore drill executed against Supabase staging with measured RTO/RPO
  - Counsel review on `/legal/{privacy,terms}` (Brazilian-LGPD lawyer)
  - The URL flip itself (ADR-0014 amendment go/no-go + DNS + landing copy)
- **One autonomous-fix PR** (this PR's sibling): the surgical CONDITIONAL items every agent named that can be closed by code/doc edits.

**No agent issued NO-GO. The closed-blocker delta verifies on inspection. The Rounds 1-7 work is shippable.**

## Verdict by agent

| Agent | Verdict | Key conditions | Section |
|---|---|---|---|
| tech-lead | CONDITIONAL | PR2b + counsel review + ADR-0021 flipped to Accepted | §1 |
| data-architect | **GO** | No blockers (soft observations are Wave A / Round 6 PR2b items) | §2 |
| security-reviewer | CONDITIONAL | 3 surgical fixes (OIDC error log + THROTTLER_ENABLED docs + ADR-0022 Universal Links primary) | §3 |
| product-lead | CONDITIONAL | PR2b + counsel review (or amendment language) + roadmap.md drift + amendment date-bound commitment | §4 |
| ux-critic | CONDITIONAL | ES placeholder copy fix OR locale switcher on /legal/* | §5 |
| persona-fleet-ops | CONDITIONAL | PR2b + counsel review + this scan + status-page live + homepage honesty band | §6 |

## §1 — tech-lead verdict (CONDITIONAL → GO)

Conditions named:

1. **Round 6 PR2b** (executed restore drill) — external maintainer-hands-on
2. **Round 7 §9 counsel review** — external lawyer engagement
3. **ADR-0021 flipped to Accepted** before Wave 0+ work starts — autonomous

Items closed CLEANLY (cited): throttler `APP_GUARD` wiring, audit-chain reproducibility (migration 0021 + 0026), module wiring discipline on conditional features, Round 5 #49 functional CI gate, ADR-0018 observability stack, migration 0026 audit_events.requestId, all 26 migrations have ROLLBACK.md + rls.sql coverage.

Items closed with EARNED CONCERN (no veto):
- Audit-chain digest landed in 0021 not 0020 as v1 expected (cutover marker pattern is honest about the discontinuity)
- Tenant export / deletion / verification tables intentionally have no RLS (super-admin-only by GRANT; convention is now mixed and worth an ADR clarification before Wave A's Teams table)
- Cross-module imports (signup → auth.AuthService, email-verification → signup.SignupRateLimits) — defensible but the `EmailVerification → SignupRateLimits` import is the trip-wire; promote to `shared/rate-limit/` before a third consumer

NEW blockers surfaced: none that block URL flip.

## §2 — data-architect verdict (GO)

The strongest verdict. All schema invariants hold post-Round-7:

- Audit chain reproducibility (`audit_events` policies = SELECT + INSERT only; no UPDATE, no DELETE; RLS + FORCE both `t`)
- `digestPreImage` + advisory lock concurrency contract holds
- Tenant-immutable triggers in 0021 hold (both `emit_notification_tamper_audit` + `emit_pat_resurrected_audit`)
- All 26 migrations applied to staging successfully (including migration 0026 verified live `audit_events.requestId TEXT NULL`)
- RLS+FORCE spot-check on 5 random tenant-scoped tables: all confirmed `t/t`
- Migration sequencing 0020-0026 correct, no out-of-order hazards
- Wave A migration readiness (0027 Teams + 0028 AssetAssignment) confirmed
- restore-drill exercises bootstrap + rls.sql + chain-verify coherently

Soft observations (Wave A / Round 6 PR2b items, not URL-flip blockers):

- Migration-discipline runbook for future audit-column renames (Wave A item)
- Trigger-fire validation in restore drill (PR2b item)
- Add `(tenantId, parentTeamId)` partial index when migration 0027 ships

## §3 — security-reviewer verdict (CONDITIONAL → GO with 3 surgical fixes)

OWASP-Top-10 retrospective: zero new VETO-class issues.

Closed-blocker delta verified: C1 (status-page `/health`-only), C2 (sub-processor CATEGORIES), B2 (audit chain reproducibility), B1 (.gitignore on dump + log artefacts), CWE-214 (PGPASSWORD env replaces password-in-argv), §4-§8 (anti-spoof + timing floor + tenant-export PII at rest).

**Three pre-flip surgical fixes required (none individually veto-class):**

1. **`apps/core-api/src/modules/signup/signup.controller.ts:284-313`** — replace `err: String(err)` with sanitized error shape (`err: err instanceof Error ? err.name : 'unknown'`). Attacker-supplied OIDC `error_description` shouldn't land verbatim in pino. Mirrors the existing `safeCode = idpError.slice(0, 64).replace(/[^a-z_-]/gi, '')` pattern.
2. **`docs/runbooks/secrets-inventory.md`** — add `THROTTLER_ENABLED=1` as REQUIRED prod env. Currently only documented as a test-only skipIf in `app.module.ts:143-145`; a self-hoster who never sets it gets a no-op throttler in prod (fail-OPEN against brute force).
3. **`docs/adr/0022-driver-native-mobile-architecture.md`** — promote Universal Links / App Links from "+" to "PRIMARY" with `panorama://` explicitly relegated to fallback. Wording-only change; protects against URL-scheme hijack on the to-be-built mobile app.

Mobile-app pre-implementation concerns (ADR-0022 still Proposed; these are pre-implementation): lost-phone trust model, jailbreak/root, MITM on enrollment 6-digit code, malicious app `panorama://` interception. Documented in §3 above + ADR-0022 §13 follow-up list.

## §4 — product-lead verdict (CONDITIONAL → GO with amendment language)

v1 strategic recommendations landed materially (close-Wave-0-first held; sub-processor CATEGORIES held; feature-wave sequence with two documented maintainer overrides held). Strategic positioning intact.

Anti-goal walk: zero stealth breaches in Rounds 5-7. The one explicit override (native mobile before PWA, maintainer decision #3) is documented as override with Risk-register coverage. Edition placement on the new artefacts (status page / SBOM / audit chain / restore drill / secrets rotation / Privacy/ToS / ADR-0021 / ADR-0022) all correct.

Customer-discovery gap: unchanged structurally; mitigation is now explicit but paragraph-level not date-level — **the ADR-0014 amendment must add the date**.

**Four pre-flip conditions:**

1. **PR2b restore drill** — external (same as tech-lead, persona-fleet-ops)
2. **Counsel review** on #245 OR amendment language committing to counsel-reviewed v2 by first paying tenant
3. **`docs/en/roadmap.md` "Beyond 1.0" mobile-app line** — move to Wave B or remove. Public-facing lie-in-30-days otherwise.
4. **ADR-0014 amendment carries** the date-bound commitment: 3 design partners contacted within 14 days of URL flip, first weekly call within 21 days.

Capacity cap recommendation: **25 active tenants** soft cap before maintainer pauses new signups to revisit operational cost.

## §5 — ux-critic verdict (CONDITIONAL → GO with one defect fix)

v2 delta did not introduce UX regressions. Legal pages render well (760px max-width, 16px body, 1.65 line-height; status banner visible with left-border + amber tint; sub-processor disclosure clean).

**One shipped defect that explicitly misleads users:**

- **ES placeholder on `/legal/{privacy,terms}` references a "language switcher" that does not exist on `/legal/*` routes.** `apps/web/src/app/legal/privacy/content.ts:526` and `terms/content.ts:457` say *"por favor seleccione su idioma en el selector de idiomas"* — but no such switcher is rendered on those routes. Spanish-speaking visitor arrives, sees explicit "pendiente" message, is told to do something they can't do.

Two fix options (PR-author chooses):
- **(a)** Add a 3-link locale strip to `apps/web/src/app/legal/layout.tsx`: `[EN] · [PT-BR] · [ES]` that sets `panorama_locale` cookie via Server Action + redirects. ~20 lines.
- **(b)** Edit the ES placeholder to either render BOTH EN and PT-BR content blocks for ES readers, OR rewrite to not reference a UI element that does not exist.

**Strong-suggestion (not URL-flip blockers):**

- Legal footer tap target 44px → 48px (`globals.css:756`) — off by 4px from ADR-0021 §6 commitment
- Status-banner copy says "at end of document" but renders at top — pick one (`packages/i18n/{en,pt-br,es}/common.json:590`)
- Add `id={slugify(text)}` to H2 renderer in legal page parser — anchor-link citation pattern, ~5 lines

**Named-and-deferred to Wave 0+** (NOT blockers, ADR-0021 commits to all):

- Role-aware `/` router (currently `redirect('/assets')` for all personas)
- Light theme + tap-target audit + design-system primitives + mobile baseline

## §6 — persona-fleet-ops verdict (CONDITIONAL → GO)

Procurement-credibility delta moved the needle meaningfully (442-line incident.md + 1193-line secrets-rotation.md + executable restore drill + tamper-evident audit chain + 14 green CI gates). Honest assessment: B+ on infra evidence, D on UX evidence.

End-user surface largely unchanged from 2026-05-17 session-end perception walkthrough (~10% of FleetManager v2.1 feature surface). At URL flip:

- **Fleet manager** lands on `/assets` (wrong page; bounces within 90 seconds — no synthesis screen)
- **Dispatcher** can use the SSR 14-day calendar grid for *viewing* but not *changing* (Wave C)
- **Driver** has no `/me` page + no native app yet; lands on `/assets` like everyone else (Wave 0+ minimal + Wave B Expo app)
- **Maintenance tech** sees a flat ticket list; useful for 5-vehicle pilots, insufficient at 40 vehicles + 120 drivers

Wave A vs Wave B sequence call: **defensible on reflection.** Wave A is faster (pure schema + web) and Wave B's Expo pipeline costs real setup. Caveat: Wave B must be the immediate next wave after A; no Wave C interleaving.

**Pre-flip conditions (consolidated; overlaps with other agents):**

- PR2b restore drill executed (external)
- Counsel review on /legal (external)
- Round 7 §10 v2 scan close-out (this document) + ADR-0014 amendment
- Status-page workflow live (PR #243 cron firing — verify after this scan)
- **Honesty band on `docs/index.md`** — homepage must say "preview, ~10% feature surface, no SLA, 30-day delete clause" before URL flip. Tenants consent at signup, not discover post-hoc.

## Consolidated condition list

Combining all 6 agents' CONDITIONAL items, deduplicated:

### Autonomous (closed in the v2 scan surgical fixes PR — sibling to this handoff)

1. **Sanitize OIDC error log** — signup.controller.ts:284-313 (security-reviewer §3-1)
2. **THROTTLER_ENABLED=1 mandatory prod env** — secrets-inventory.md (security-reviewer §3-2)
3. **ADR-0022 Universal Links primary** — wording-only (security-reviewer §3-3)
4. **docs/en/roadmap.md mobile-app line** — move to Wave B (product-lead §4-3)
5. **ES placeholder on /legal/*** — content edit OR locale switcher (ux-critic §5)
6. **docs/index.md honesty band** — preview disclaimer (persona-fleet-ops §6)
7. **ADR-0021 Status: Proposed → Accepted** (tech-lead §1-3)
8. **ADR-0022 Status: Proposed → Accepted** (recommended alongside ADR-0021 since both are Wave-prereqs and have been reviewed at length)

Optional same-PR surgical follow-ups from ux-critic §5:

- Legal footer 44px → 48px tap target
- Status-banner copy "at end of document" vs current position consistency
- H2 anchor-id rendering in legal pages

### Captured in ADR-0014 amendment (sibling deliverable)

9. **25-tenant capacity soft cap** (product-lead §4)
10. **Date-bound design-partner commitment** — 3 partners within 14 days; first call within 21 days (product-lead §4-4)
11. **Counsel-review commitment language** — counsel-reviewed v2 by first paying-tenant trigger (product-lead §4-2)
12. **30-day exit ramp + delete clause restate** (product-lead §4)
13. **Enterprise-positioning forward-looking footer** (product-lead §4)

### External (cannot close autonomously; gates URL flip)

14. **PR2b restore drill executed** with observed RTO/RPO into `docs/audits/restore-drill-<date>/` (maintainer-hands-on)
15. **Counsel review** on `/legal/{privacy,terms}` (external Brazilian-LGPD lawyer)
16. **URL flip itself** — ADR-0014 amendment commit + DNS + landing copy (maintainer-hands-on)

## What this means for Wave 0 closure

**§8 (runbooks + restore drill):**
- Docs: ✅ (all 3 PRs merged: incident.md + secrets-rotation + restore.md + restore-drill.sh)
- Drill execution: ⏳ #14 PR2b (external blocker)

**§9 (Privacy/ToS + status page + SBOM):**
- Status page: ✅ (PR #243 merged; cron firing)
- SBOM + cosign keyless: ✅ (PR #244 merged; release-tag pipeline ready)
- Privacy/ToS v1: ✅ (PR #245 merged; pre-counsel banner explicit)
- Counsel review: ⏳ #15 (external blocker)

**§10 (v2 6-agent scan + ADR-0014 amendment):**
- v2 scan: ✅ (this document)
- Surgical fixes PR: ⏳ (sibling to this handoff, items #1-8 above)
- ADR-0014 amendment: ⏳ (sibling to this handoff, items #9-13)
- URL flip decision: ⏳ #16 (gated on items #14-15 + amendment merge)

## URL flip — go condition

The URL flip happens when:

```
items #1-8 merged
AND items #9-13 in the amendment merged
AND item #14 (PR2b drill) executed
AND item #15 (counsel review) complete
AND maintainer reads the amendment + says GO
```

The §10 v2 scan does NOT issue the GO itself — the scan produces the green-light verdict (this document); the amendment IS the GO. The maintainer's commit on the amendment is the formal flip.

## Risk register additions (post-scan)

These are new entries for `docs/audits/roadmap-to-feature-complete-2026-05-18.md` §Risk register:

- **OIDC error_description in logs** — security-reviewer §3-1; mitigation: surgical fix PR. SEVERITY: Low (attacker-influenced text in pino, not exfiltration).
- **THROTTLER_ENABLED prod fail-open** — security-reviewer §3-2; mitigation: secrets-inventory update + boot-time warning if unset in prod. SEVERITY: Medium pre-fix; Low post-fix.
- **Cross-module `EmailVerification → SignupRateLimits` import** — tech-lead §1; mitigation: promote to `shared/rate-limit/` before a third consumer. SEVERITY: Low.
- **Tenant export / deletion / verification tables RLS-by-omission convention** — tech-lead §1; mitigation: ADR clarification before Wave A's Teams table. SEVERITY: Low (current code is correct; documentation gap).
- **Public roadmap.md drift** — product-lead §4; mitigation: surgical fix PR. SEVERITY: Low (public-facing copy lie).
- **Customer-discovery commitment is paragraph-level not date-level** — product-lead §4; mitigation: amendment date-bound commitment. SEVERITY: Medium pre-amendment.
- **ES /legal/* broken affordance** — ux-critic §5; mitigation: surgical fix PR. SEVERITY: Medium (shipped UX defect visible to Spanish-speaking visitors).
- **Legal footer 44px tap target** — ux-critic §5; mitigation: same surgical fix PR. SEVERITY: Low.

## Sequencing for §10 closure

1. **This handoff document** lands as one PR (or bundled with the surgical fixes; see below)
2. **v2 scan surgical fixes PR** addressing items #1-8 of the consolidated condition list. Estimated ~10 file edits + the ADR Status flips.
3. **ADR-0014 amendment PR** addressing items #9-13. Pure docs.
4. **Maintainer reviews + merges** the surgical fixes + the amendment.
5. **Maintainer executes** items #14 (PR2b drill) + #15 (counsel review engagement).
6. **Maintainer commits the URL flip** per the amendment's go-condition language.

Items 1-3 may bundle into a single PR for review density (since the handoff + amendment + fixes are all §10 closure artefacts). PR-author's call; the per-PR scan signal density argues for keeping them separable if they're substantial.

## What this scan does NOT cover

- **Wave A onward.** The §10 scan is the Wave 0 acceptance gate. Wave A's first PR gets its own 5-agent per-PR scan; Wave B's first PR gets its own. The v2 6-agent scan does not pre-clear any wave A-I work.
- **Counsel-side legal review** of `/legal/{privacy,terms}`. The security-reviewer threat-model review of the policy text is in §3 above; the counsel review remains external + gates URL flip independently.
- **Live post-flip monitoring.** Status-page + SBOM verification + audit-chain CLI run on cron + drill cadence are operational concerns; the §10 scan verifies they're set up correctly, not that the operator is running them. Quarterly drills are documented in each runbook.
- **The actual URL flip mechanics** — DNS + Cloudflare routing rules + landing page copy + Fly deploy + ANPD form readiness. Maintainer-hands-on, captured in the ADR-0014 amendment's implementation notes.

## Agent reports raw (synthesis source)

The 6 raw agent reports from the 2026-05-18 scan live in the conversation transcript (~6500 words total across the 6 agents). This handoff is the synthesis. The raw reports cite file:line + commit-sha + PR# throughout; if any item in this handoff needs deeper grounding, re-spawn the relevant agent with the closed-blocker delta from main as context.

---

**Generated 2026-05-18 from the v2 6-agent scan.** Awaits the surgical fixes PR + the ADR-0014 amendment + maintainer-execution of the external blockers before §10 closes and the URL flips.
