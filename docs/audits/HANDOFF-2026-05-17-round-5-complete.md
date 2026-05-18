# Handoff — 2026-05-17 (Round 5 complete)

> Continuation of `HANDOFF-2026-05-17-round-5-pr2-complete.md`. Round 5
> of the 7-round revised plan from `HANDOFF-2026-05-16-wave0-scan.md`
> is now complete with the merge of PR3 (SESSION_SECRET secondary-key
> rotation). 7 of 10 Wave 0 acceptance criteria closed; 3 remain
> (Round 6 runbooks + Round 7 pre-launch + Round 7 v2 6-agent scan).

## TL;DR

- **PR #232 / commit `9d71e84` merged 2026-05-17** — closes Round 5.
- Self-hosters can now rotate `SESSION_SECRET` zero-downtime via the
  iron-session-native two-key pattern: set
  `SESSION_SECRET_PREVIOUS=<old>` + `SESSION_SECRET=<new>` → wait
  `SESSION_MAX_AGE_SECONDS` (7 days default) → clear `PREVIOUS`. The
  emergency path (suspected leak) stays distinct: set new primary,
  leave `PREVIOUS` unset, every session invalidated immediately.
- `AuthConfig` builds the iron-session-ready `sessionPassword` value
  once at boot — `SessionService` is a dumb consumer. Three
  boot-throws guard the obvious misconfigs (short `PREVIOUS`,
  `PREVIOUS == SECRET`, `PREVIOUS` without `SECRET`).
- Both cookies (`panorama_session` + `panorama_oauth`) share the
  same `Password` value — without the symmetry, in-flight OIDC
  dances mid-rotation would 500 on the callback.
- Boot INFO log `auth_config_session_secret_rotation_active` confirms
  the rotation window without leaking secret values.
- pino-redact extended with `sessionSecret*` paths as
  defense-in-depth so a future `this.log.debug({ cfg })` accident
  can't leak the cookie key.
- New runbook `docs/runbooks/secrets-rotation.md` lands as a
  self-contained stub (~150 lines) — Path A (emergency, 3 commands)
  + Path B (routine, 4 steps with bolded foot-shooting warning above
  Step 4). Full per-secret rotation matrix lands in Round 6.
- `docs/en/self-hosting.md` "Rotate `SESSION_SECRET`" section
  rewritten with BOTH paths (replaced the prior single-path
  "every session invalidated — Expected" framing).
- All 5 per-PR agents returned APPROVE — first PR in the Round 5
  sequence without a CONVERGENT BLOCKER at per-PR scan, which tracks
  the smaller surface area + the upfront pre-impl discipline.

## PR in chronological order

| # | Commit | Title | Notes |
|---|---|---|---|
| 232 | `9d71e84` | Round 5 PR3 — SESSION_SECRET_PREVIOUS secondary-key rotation | 8 files changed, +461 / -38. New `docs/runbooks/secrets-rotation.md` (~150 lines), `apps/core-api/src/modules/auth/auth.config.ts` interface + validator + boot-throw + INFO log, `apps/core-api/src/modules/auth/session.service.ts` consumes `sessionPassword` for both cookies, `apps/core-api/test/auth-config-session-secret.test.ts` +8 cases, `apps/core-api/.env.example` SESSION_SECRET_PREVIOUS block (emergency path first), `docs/en/self-hosting.md` dual-path rewrite, `docs/runbooks/secrets-inventory.md` row update + redundant pre-promise paragraph deleted, `apps/core-api/src/shared/observability/pino-logger.service.ts` redact paths. |

## Numbers

- Session length: same working day as Round 3 close + Round 4 close
  + Round 5 PR1 close + Round 5 PR2 close (2026-05-17 — the fifth
  bounded session of the day; landing-page trim PR #231 was a
  parallel sixth)
- PRs shipped: 1 (squash + `--admin` bypass)
- Tests added: 8 unit cases (sessionPassword string form / object
  form / 3 boot-throw scenarios / treats empty PREVIOUS as unset /
  round-trip seal-with-previous-unseal-via-combined / lockout
  contract after drop)
- Suite total — core-api: 521/521 (was 513/513 after Round 5 PR2;
  +8 new)
- Lines of TypeScript added: ~100 (auth.config.ts ~50 + tests ~145
  + redact paths ~6)
- Lines of docs added: ~190 across `.env.example`, `self-hosting.md`,
  `secrets-rotation.md` (new), `secrets-inventory.md`
- Agent scans: 5 pre-implementation + 5 per-PR = 10 agent passes;
  rev1 closed several runbook clarity NON-BLOCKERs (multi-replica
  grep caveat, Step 4 bolded warning, calendar-reminder hint,
  sed-no-op note, Enterprise wedge framing)

## Decisions locked this round

1. **Naming: `SESSION_SECRET_PREVIOUS`** (matches iron-session vocab;
   semantic env-var names hide numeric keys from the operator so
   the highest-key-wins footgun is structurally impossible — the
   operator never sees a numeric id).
2. **Boot-throw on equal-value, not warn** (security per-PR argued
   harder than tech-lead's warn — the silent failure mode at the
   "drop previous" step is too load-bearing to leave as a warn;
   operator who copy-pasted the same value into both vars sees a
   failed deploy with a clear message).
3. **AuthConfig exposes both `sessionSecret: string` (backward-compat
   read for the #35 regression test) AND `sessionPassword:
   SessionOptions['password']`** (the iron-session-ready value
   SessionService consumes). Tech-lead per-PR flagged the dual-field
   risk as a follow-up.
4. **Same `Password` value for session AND oauth-state cookies**
   (tech-lead pre-impl DD3 + security B3 — without the symmetry,
   in-flight OIDC callbacks during rotation 500 on state-cookie
   decrypt failure).
5. **iron-session string-normalization quirk acknowledged**: cookies
   sealed during the rotation window encrypt under the primary at
   id 2; once `PREVIOUS` clears and the form collapses back to a
   bare string at id 1, those cookies stop decrypting. Runbook
   mandates a `SESSION_MAX_AGE_SECONDS` wait between flip and drop
   so live cookies expire naturally; Step 4 carries a bolded
   foot-shooting warning. The alternative (always-object form)
   would have invalidated every existing self-hosted session on
   PR3 upgrade — chose the operator-friendly path.
6. **Unit tests only**, no e2e — used `sealData`/`unsealData`
   directly from iron-session to exercise the rotation contract;
   pure, fast, deterministic. The HTTP-stack-plumbing version would
   test iron-session's library guarantee through 200 lines of
   integration setup for no coverage gain.
7. **Boot INFO log on rotation active** (persona-fleet-ops NB4 +
   security N2). Ops console search for
   `auth_config_session_secret_rotation_active` confirms the
   secondary loaded. NOT an audit row (deferred per data-architect
   — boot env is itself the auditable artifact via Fly secrets /
   VCS history).
8. **Stub runbook self-contained** — does NOT say "see iron-session
   docs" anywhere. Literal commands, target host, verification grep,
   wait constant by name, emergency abort, multi-replica caveat,
   Enterprise multi-tenant wedge call-out. Round 6 expands but does
   NOT replace.

## Iterative review pattern (10 agent passes this PR)

5 agents at the pre-implementation stage shaped the design:
- **tech-lead**: AppConfig shape (expose `sessionPassword`, not raw
  iron-session detail in SessionService); `SESSION_SECRET_PREVIOUS`
  naming; oauthState symmetry; warn-vs-throw on equal-value; YAGNI
  on RotationManager / IronSessionPasswordFactory abstractions.
- **security-reviewer**: length-32 floor on PREVIOUS (boot throw,
  not runtime); equal-value boot throw; HMAC per-key
  constant-time-verified by iron-webcrypto; `.env.example`
  emergency-path-first ordering; pino-redact for `sessionSecret*`
  field names.
- **data-architect**: APPROVE — zero DB surface, zero migration,
  zero new queries; mixin allocation cost trivial at preview scale.
- **product-lead**: edition placement (Community primitive; managed
  multi-tenant rotation = Enterprise); self-hosting.md needs BOTH
  paths; secrets-rotation.md stub shape; README untouched (Round 7
  job).
- **persona-fleet-ops**: structural footgun-removal via env-var
  naming; self-hosting.md needs emergency + routine paths; runbook
  must be self-contained (no "see iron-session docs"); boot log
  line for state visibility; SESSION_MAX_AGE_SECONDS reconciled to
  code-default 7 days, not handoff's 14 days.

5 agents at the per-PR stage all returned APPROVE / SHIPPABLE with
no BLOCKERs. Substantive NON-BLOCKERs (closed in rev1):
- **persona-fleet-ops**: multi-replica grep caveat; Step 4
  foot-shooting warning bolded; calendar-reminder hint; sed-no-op
  comment.
- **product-lead**: Enterprise multi-tenant rotation framing.
- **tech-lead**: unit test references the runbook by path so a
  future rename surfaces the link in the test diff.

The first PR3 in the Round 5 sequence to pass per-PR scan without a
convergent BLOCKER. Two reads: (a) smaller surface area;
(b) pre-impl discipline is paying down review cost. Both probably
true. Keep the 5+5 cadence — the per-PR scan still surfaced a
useful set of runbook clarity NON-BLOCKERs that the implementation
honored.

## What's left

### Round 5 — DONE

PR1 (#223) + PR2 (#226) + PR3 (#232) all merged. Round 5 closed.

### Round 6 — runbooks (Wave 0 §8)

- `docs/runbooks/incident.md` (LGPD 72h ANPD clock + breach
  taxonomy)
- `docs/runbooks/restore.md` + restore drill executed once
- `docs/runbooks/secrets-rotation.md` — expand the PR3 stub:
  - OIDC client secret rotation
  - S3 / SMTP credential rotation
  - Sentry DSN rotation
  - Turnstile secret rotation
  - Per-secret blast radius + recovery checklist
  - Integration with incident.md
- Register controlled domain + `.well-known/security.txt`
- PR3-deferred follow-up: add `AuditEvent.requestId TEXT NULL`
  column for log↔audit correlation
- PR3-deferred follow-up: `tenant-export.service.ts` `dispatchEmail`
  overwriting `completed → failed` bug (still in main; persona N1
  per-PR PR2 + handoff risk item 6 PR1 — has NOT been fixed yet)

### Round 7 — pre-launch + v2 scan + URL flip go/no-go

- Privacy + ToS at `apps/web/src/app/legal/*` (LGPD Art. 9)
- Status page (Upptime on GH Actions)
- SBOM CycloneDX + cosign sigstore keyless sign on release
- README "Backend: production-ready" softened
- Hosted-vs-self-host CTA tracking
- v2 6-agent scan on the closed-blocker delta
- URL flip go/no-go decision recorded as ADR-0014 amendment

## Follow-ups filed during Round 5 PR3

(File these as GH issues post-merge — they're tracked in the PR
description but should be ticketed.)

1. **`/healthz` exposing `rotation_active` flag** — runtime
   visibility so an operator who forgot they started a rotation 10
   days ago can check via curl. 0.4 admin-console-adjacent.
2. **`panorama.auth.session_secret_rotated` audit event** —
   deferred from PR3 (boot INFO log lands instead). When the audit
   chain Round 6 work expands, consider adding for tenant-visible
   security-config-change records.
3. **Deprecate `sessionSecret` field on AuthConfig in favor of
   `sessionPassword`** — tech-lead per-PR observation. The dual
   field is a stale-value risk if a future contributor reaches for
   `sessionSecret` directly during rotation. Either drop the field
   (small refactor) or `@deprecated` JSDoc.
4. **`tenant-export.service.ts` `dispatchEmail` completed → failed
   bug** — STILL UNFIXED in main (handoff risk item 6 from PR1 +
   persona N1 PR2). File a dedicated issue before Round 6 lands so
   the runbook drill doesn't shadow it.
5. **AuditEvent.requestId column** (Round 6 / runbooks — already
   listed above).
6. **Per-tenant Sentry sampling** (deferred until free-tier signal
   forces it).
7. **Asset-tag in Sentry tags** (`scope.setTag('assetId',
   req.params.id)` from AllExceptionsFilter — 0.4 enhancement).

## How to pick up the next session

1. **Read this handoff first.** Then
   `HANDOFF-2026-05-17-round-5-pr2-complete.md` for the PR2
   observability context;
   `HANDOFF-2026-05-17-round-5-pr1-complete.md` for the CI gate;
   `HANDOFF-2026-05-16-wave0-scan.md` for the 7-round plan.
2. **Start Round 6 from a fresh branch off `main`.** Round 6 is
   multi-day scope — not a one-session slice. Plan to split into
   at least three PRs:
   - **PR1 — incident.md + register domain + `.well-known/security.txt`**
   - **PR2 — restore.md + executed restore drill (gates Wave 0 §8;
     non-trivial because the drill needs an actual practice run on
     staging)**
   - **PR3 — secrets-rotation.md full per-secret matrix** (expanding
     the PR3 stub from Round 5)
   - **Bundle: `AuditEvent.requestId` column** at whichever Round 6
     PR touches the audit chain naturally
3. **File the 7 follow-up GH issues listed above** before Round 6
   PR1 lands so they're tracked.
4. **Per-PR 5-agent scan stays mandatory.** Round 6's runbook PRs
   have lower technical-risk per change but higher
   procurement-positioning risk — product-lead + persona-fleet-ops
   are the load-bearing reviewers. Don't skip the scan because the
   diff is "just docs."
5. **No new migrations from Round 5 PR3.** Schema unchanged this
   round.
6. **`FEATURE_SELF_SERVE_SIGNUP` continues default off in prod.**
   Hosted URL flip is gated by ALL 10 Wave 0 acceptance criteria;
   PR3 closed nothing on the criteria list — it's supporting
   infrastructure for §8 (Round 6 closes §8).
7. **Existing self-hosters survive the PR3 upgrade.** Bare-string
   form is preserved when `SESSION_SECRET_PREVIOUS` is unset
   (which it is by default); existing iron-session cookies continue
   to decrypt without any operator action.

## Files newly authoritative in main

- `apps/core-api/src/modules/auth/auth.config.ts` (interface
  extended with `sessionSecretPrevious?: string` +
  `sessionPassword: SessionOptions['password']`; new
  `validateSessionSecret` module-level helper; three boot-throws;
  boot INFO log on rotation active)
- `apps/core-api/src/modules/auth/session.service.ts` (both
  `sessionOptions()` and `oauthStateOptions()` consume
  `sessionPassword`)
- `apps/core-api/src/shared/observability/pino-logger.service.ts`
  (redact paths for `sessionSecret`, `sessionSecretPrevious`,
  `sessionPassword` + wildcards)
- `apps/core-api/test/auth-config-session-secret.test.ts` (+8
  rotation cases)
- `apps/core-api/.env.example` (SESSION_SECRET_PREVIOUS block,
  emergency path documented first)
- `docs/en/self-hosting.md` "Rotate `SESSION_SECRET`" section
  (both paths)
- `docs/runbooks/secrets-rotation.md` (new, ~150 lines)
- `docs/runbooks/secrets-inventory.md` (table updated; redundant
  pre-promise paragraph deleted)

## Risks / known-stale items

1. **`FEATURE_SELF_SERVE_SIGNUP=false` remains the only gate
   stopping public access.** PR3 doesn't change this.
2. **`S3_*` env vars remain REQUIRED on every deployment** per
   Round 3 PR #216. Unchanged.
3. **`tenant-export.service.ts` `dispatchEmail` completed → failed
   bug is STILL UNFIXED in main.** Tracked across PR1's handoff
   risk item 6, PR2's persona N1, and PR3's follow-up #4. File a
   dedicated issue before Round 6 PR1 lands.
4. **`sessionSecret` field on AuthConfig is a stale-value risk
   during rotation.** Only consumer in src today is the
   `auth-config-session-secret.test.ts` test surface for #35.
   `SessionService` uses `sessionPassword` exclusively. Follow-up
   #3 above tracks the deprecation.
5. **iron-session string-normalization quirk**: cookies sealed
   during the rotation window stop decrypting after `PREVIOUS` is
   cleared. Runbook mandates the `SESSION_MAX_AGE_SECONDS` wait
   between flip and drop — documented + tested + bold-warned in
   Step 4. Operator-side risk.
6. **PR3 is the first Round 5 PR without a per-PR CONVERGENT
   BLOCKER.** Don't read this as "the cadence can drop" — the
   per-PR scan still surfaced load-bearing runbook clarity
   NON-BLOCKERs (multi-replica grep, Step 4 warning) that the
   implementation honored.
7. **Stack depth — fifth bounded session of 2026-05-17.** Round 6
   is multi-day scope; trying to land Round 6 PR1 in the same
   session would compress the per-PR scan iteration into noise.

## Round-by-round status snapshot

| Round | Status |
|---|---|
| 0 — ADR scaffolding | DONE (#199) |
| 1 — Docs + a11y quick wins | DONE (#203) |
| 2A — Throttler wiring | DONE (#204 + #205) |
| 2B — Audit chain reproducibility | DONE (#206) |
| 3 prereqs — audit registry + env + throttler infra | DONE (#208 + #209 + #210) |
| 3 main — signup + verify + delete + export endpoints | DONE (#212 + #213 + #214 + #215 + #216) |
| 4 — daily-driver UX (vitest + shell + actor-on-row + approvals + settings) | DONE (#217 + #218 + #219 + #220 + #221) |
| 5 PR1 — no-enterprise-imports + community-smoke functional gate (#49) | DONE (#223) |
| 5 PR2 — observability stack (ADR-0018) | DONE (#226) |
| **5 PR3 — SESSION_SECRET secondary-key rotation** | **DONE (#232)** |
| 6 — runbooks (incident + restore drill + secrets-rotation full + AuditEvent.requestId) | not started |
| 7 — Privacy + ToS + status page + SBOM + v2 6-agent scan + URL flip | not started |

Wave 0 acceptance progress: 7/10 criteria closed (ADRs §1, Round 1
§2, Round 2 §3, Round 3 §4, Round 4 §5, Round 5 PR1 §6, Round 5 PR2
§7). 3 still open: §8 runbooks + restore drill (Round 6), §9
Privacy/ToS/status/SBOM (Round 7), §10 v2 6-agent scan (Round 7).
The hosted URL flips when all 10 close.
