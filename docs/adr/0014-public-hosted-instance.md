# ADR-0014: Public hosted instance (Community deployed, free preview)

- Status: Accepted (2026-05-16). Drafted from the Wave 0 6-agent scan
  on the same date; accepted by maintainer in the same session.
  Supersedes the prior "Cloud SKU" reservation in `docs/adr/0000-index.md`,
  which was held open since 2026-04-19 awaiting customer signal.
- Date: 2026-05-16
- Deciders: Vitor Rodovalho (maintainer)
- Reviewers (Wave 0 scan, 2026-05-16):
  - product-lead → SUPPORT with named amendments (items 1–5 below
    are the verbatim guard rails that defuse the "third edition by
    accident" concern this slot has carried since 2026-04-19)
  - tech-lead → no objection on framing; observability + per-tenant
    throttler + worker boundary captured in ADR-0018 / ADR-0019
  - data-architect → no objection on data surface; rollback + restore
    drill remain Wave 0 deliverables
  - security-reviewer → no objection on framing; signup model + threat
    model split into ADR-0020
  - ux-critic → no objection on positioning; homepage rewrite is a
    Wave 0 deliverable that follows this ADR's framing
  - persona-fleet-ops → SUPPORT; "free hosted = real ops feedback at
    zero customer-acquisition cost" is the loop that was missing
- Related: [ADR-0002 OSS/Enterprise edition split](./0002-oss-commercial-split.md),
  [ADR-0013 Staging deploy architecture](./0013-staging-deploy-architecture.md),
  [ADR-0020 Self-serve OIDC signup](./0020-self-serve-oidc-signup.md)

## Context

Panorama needs to open a public URL where ops teams can evaluate the
product against real fleet/asset workflows. Until 2026-05-09 this slot
was reserved as "Cloud SKU + edition placement; unwritten by intent
until customer signal" — gated on a paying-customer hypothesis that
never had its anchor (the 2026-04-19 product-lead BLOCK was framed
against an Amtrak/FDT pilot that the maintainer is no longer
employed at).

The 2026-05-09 strategic re-anchor (see
`docs/audits/HANDOFF-2026-05-09-session-end.md`) replaced the paid-SKU
hypothesis with a **free hosted public preview alongside the AGPL
self-host option** — two journeys, one homepage. The Wave 0 6-agent
scan on 2026-05-16 converged on this framing and produced the five
guard rails captured below.

This ADR exists to **lock the operational scope of that hosted
instance** so that subsequent Wave 0 work (legal docs, observability,
audit-chain reproducibility, signup endpoint, homepage rewrite) can
cite a single source of truth, and so that the "third edition by
accident" risk that has gated this slot since 2026-04-19 is defused
in writing rather than rhetorically.

## Decision

Panorama operates a **maintainer-run hosted instance of the Community
edition under AGPL §13**. The instance is free, has no SLA, and is
explicitly framed as a public preview — not a product.

### 1. Operational scope statement

This ADR scopes a maintainer-operated hosted instance of the Community
edition under AGPL §13. **It does NOT introduce a third edition.** The
code surface running on the hosted instance is identical to a vanilla
self-host of the same Git SHA: zero Enterprise modules, zero
hosted-only endpoints, zero hosted-only feature flags.

### 2. Edition-boundary lock

If this instance ever ships any code, feature, endpoint, schema
change, or configuration that does not exist on a vanilla self-host of
the same Git SHA, **that is a violation of this ADR and triggers an
immediate amendment** — not a "we'll productise later." The CI gate
established in #49 (Wave A, replacing the current grep with a
functional bootstrap-without-Enterprise-flags assertion) is the
mechanical enforcement of this clause and is a hard prerequisite for
opening the public URL.

### 3. Pricing non-decision

Pricing is explicitly out of scope of this ADR. The decision to charge
for any version of this hosted instance, and the resulting SKU shape,
is a **separate future amendment** gated on day-60 metrics:

| Signal at day 60 | Action |
|---|---|
| ≥3 active tenants, retention ≥40%, feedback density ≥0.3 events/tenant/week | Start ADR-0014-amendment-1 paid-SKU draft (likely candidate: enterprise email channel, per-tenant SMTP, or SCIM push — pick one) |
| 1–2 active tenants, retention OK, feedback density low | Distribution problem, not product problem; stay free-preview, invest in customer-development; 90-day re-check |
| Active tenants but high churn (<20% week-2 retention) | Daily-driver gap is real; stay free, prioritize whichever workflow churn signals point to |
| 5+ self-host fork activations, near-zero hosted signups | Self-host IS the market; reframe paid offering as managed-deployment-for-self-hosters (DR + observability + on-call), not multi-tenant SaaS — material reshape of this ADR |

These triggers are explicit decision points, **not marketing copy**.
They live in this ADR (an internal commitment) rather than in the
README (which is consent-and-positioning surface for users).

### 4. Data lifecycle commitment

The hosted instance is **free, has no SLA, and may delete tenant data
with 30-day notice**. This sentence is binding both as a product
commitment (the maintainer reserves the operational right) and as a
consent surface (tenants are warned at signup). The mechanism MUST
exist by URL-flip:

- Cron-able shutdown notification (per-tenant email)
- Working data-export endpoint (`GET /tenants/:id/export` per
  ADR-0020)
- 30-day calendar window between notice and deletion

A "30-day notice" we can't actually send is not a commitment; it's a
trust hole. Wave 0 acceptance gates the URL flip on this mechanism
existing, not just the words on the homepage.

### 5. Sunset / promotion path

If this instance is ever promoted to a paid SKU OR sunset, both
transitions follow the same 30-day-notice + data-export flow that
exists from day one of the hosted instance. There is no "you signed
up for free, now it's paid, sorry" path. Promotion to paid:

- ≥30-day notice
- Existing tenants offered: continue free until end of preview period;
  migrate to paid SKU; export and self-host; export and leave
- No silent feature gating; no retroactive paywalling of features
  used during preview

Sunset:

- ≥30-day notice
- Working export available throughout
- Self-host migration guide updated and tested before notice

## Alternatives considered

### A) Stay reserved indefinitely (the prior status)

Rejected. The 2026-04-19 hold was anchored on Amtrak/FDT customer
signal that no longer exists. Continuing to defer leaves
ADR-0013 (staging) without its declared promotion target and blocks
the public-preview pivot the 2026-05-09 re-anchor depends on. The
"third edition" risk that justified the original hold is defusable in
writing (items 1 + 2 above) rather than by inaction.

### B) Paid SaaS launch (the 2026-04-19 framing)

Rejected. Without anchor customer or pricing-discovery research,
charging without distinguishing features creates an SKU that's neither
"AGPL self-host" nor "Enterprise per-seat" — exactly the third edition
ADR-0002 forbids. The day-60 metric triggers in §3 above are the
explicit re-entry path.

### C) Closed beta with hand-picked operators only

Rejected. Reduces signal: hand-picked operators are friendly; rough
edges get patched-over instead of surfacing. The free public preview
trades wider exposure (which might surface more bugs publicly) for
genuinely organic feedback. Risk mitigated by §4 (operational right
to delete with notice) and Wave 0 hardening (audit chain, throttler,
LGPD legal docs, runbooks).

### D) Self-host only (no hosted instance at all)

Rejected. Self-host adoption is high-friction (DB + storage + email +
OIDC config + ops). Without a public hosted instance, the dominant
signup path is "ops manager evaluates Panorama on their own infra" —
a multi-day commitment they will not make for an unproven product.
The free hosted instance is the "try it in 60 seconds" funnel that
makes self-host adoption decidable.

## Consequences

### Positive

- Real customer feedback loop replaces theoretical priorities. Day 60
  retention curves and feedback density are measurable signal that
  internal hypotheses are not.
- The "free hosted = Community" claim becomes provable, not
  aspirational, via the §2 edition-boundary lock + #49 functional CI
  gate.
- The 2026-04-19 "3rd edition by accident" concern is closed in
  writing (§§ 1 + 2 are the verbatim defusing).
- Issue #50 (bus factor of 1) gets a forcing function: operating a
  public instance demands the runbooks the maintainer would otherwise
  procrastinate on.
- The pricing decision (§3) finally has a data-driven re-entry path
  rather than vibes-based debate.

### Negative

- Operational cost trickles up. Supabase Free → Pro ($25/mo) → PITR
  ($100/mo) → real Redis ($50+/mo) → real email ($20+/mo) → backup
  storage. At 5 active tenants the personal-account spend is
  ~$200/mo with zero revenue. Acceptable for 90 days; revisit at
  day 91.
- Free-rider class: people who would have paid for Enterprise's
  premium connectors will instead self-host with the free OIDC + email
  channel and never convert. Acceptable while optimizing for adoption
  at 0.3; becomes a strategic question at 1.0.
- §2's edition-boundary lock means "let's add just one little thing
  to the hosted instance" requires an ADR amendment every time. This
  is the cost of defusing the "third edition" risk — features ship to
  Community (visible to self-hosters) or not at all.
- §4's deletion right is real and must be exercised the first time
  it's needed, not softened under partner pressure. The first such
  exercise is the credibility test of this ADR.

### Neutral / locked-in

- The hosted instance becomes an additional production surface the
  maintainer is responsible for. Wave 0 acceptance criteria (audit
  chain, throttler, runbooks, restore drill, secret rotation) are
  scoped to this surface; they're not optional.
- The day-60 metric triggers (§3) become the canonical decision rule
  for the next ADR-0014 amendment. Drifting from them ("let's not
  ramp paid yet because…") requires its own ADR amendment.
- The first paying tenant or first reported LGPD Art. 18 data-subject
  request triggers a separate "lawyer-reviewed Privacy/ToS" amendment
  per the Wave 0 deferral rules.

## Implementation notes

This ADR ships as part of Wave 0; the URL flip itself is gated on:

1. This ADR landing as Accepted (this commit closes it)
2. ADR-0020 (signup model) landing as Accepted with implementation
3. Wave 0 must-fix backlog per `HANDOFF-2026-05-16-wave0-scan.md`
4. CI #49 functional Community gate (Wave A) shipping
5. v2 6-agent scan green-lighting the closed-blocker delta

Until all five gate, the staging URL remains internal and the
homepage continues to read "early access — not yet open."

---

## Amendment — 2026-05-18 v2 scan close-out

> **Amendment status: Proposed.** Captures the URL-flip go/no-go
> per the Wave 0 §10 v2 6-agent scan
> (`docs/audits/HANDOFF-2026-05-18-v2-6agent-scan.md`). The amendment
> commits to the additional pre-flip conditions surfaced by the v2
> scan + the capacity / customer-discovery / exit-ramp commitments
> the product-lead seat named. The maintainer's commit of this
> amendment IS the formal URL-flip decision.

### Amendment context

The original ADR-0014 (Accepted 2026-05-16) committed to the
5-gate flip condition above (gates 1-5). At amendment time
(2026-05-18):

- Gates 1-2 closed: this ADR + ADR-0020 both Accepted.
- Gate 3 closed: Wave 0 must-fix backlog from the 2026-05-16 scan
  worked through Rounds 1-7. The `HANDOFF-2026-05-18-v2-6agent-scan.md`
  artefact summarises the closed-blocker delta with file:line +
  commit-sha + PR# citations.
- Gate 4 closed: Round 5 PR1 (#223) merged 2026-05-17. The
  `community-smoke.e2e.test.ts` + `no-enterprise-imports` static
  gate are in CI.
- Gate 5 closed: v2 6-agent scan executed 2026-05-18; verdict
  tally 1 GO + 5 CONDITIONAL + 0 NO-GO. CONDITIONAL items split
  into (a) autonomous fixes shipped in the sibling "v2 scan
  surgical fixes" PR, (b) commitments captured in this amendment,
  (c) external blockers (counsel review + PR2b drill) the
  maintainer executes before committing this amendment's go.

### Amendment §6 — Capacity soft cap

The hosted preview accepts up to **25 active tenants** before the
maintainer pauses new signups to revisit operational cost
(Supabase + Redis + S3 + email + Sentry + observability quotas at
the projected per-tenant load).

The cap is a forcing function for the day-60 metric review per
§3, not a hard rate-limit on Cloudflare. Implementation:

- A new boot-time check reads the current tenant count from the
  DB; if ≥ 25, the signup endpoint returns a constant-latency 400
  per ADR-0020 §5 envelope with `error_code = capacity_reached`.
- The cap value lives in `apps/core-api/src/modules/signup/signup.config.ts`
  as `HOSTED_INSTANCE_TENANT_CAP` (default 25; override via env for
  self-hosters who DO NOT want the cap, e.g., a private-deploy
  operator running for their own organisation).
- Hitting the cap fires a Sentry breadcrumb + a `maintainer-action-
  required` GitHub issue via the existing status-page workflow
  pattern, so the maintainer is paged automatically.

### Amendment §7 — Customer-discovery date-bound commitment

The maintainer commits to:

- **3 design-partner contacts within 14 days of URL flip.** Outreach
  initiated; identity recorded in a follow-up issue tagged
  `design-partner-outreach`. Contacts may be: Amtrak / FDT
  reconnect, friendly self-hosters who installed Panorama from
  the public repo, new outreach to Brazilian fleet operators.
- **First weekly call with at least one design partner within 21
  days of URL flip.** Call cadence weekly thereafter; minutes
  filed in a `design-partner-notes-<YYYY-MM-DD>.md` doc under
  `docs/audits/` (sanitised — names/orgs redacted unless partner
  opts in).
- **If either commitment slips**, an amendment-2 to ADR-0014
  documents the slip rationale + a revised date. The slip itself
  is not a failure; the failure mode is silent drift.

### Amendment §8 — Exit ramp restate

Re-affirming the existing §4 data-lifecycle commitment for the
amendment-decision moment:

- **Discontinuation notice**: 30 days minimum, sent to the email
  on file for every active tenant Owner.
- **Data export**: tenant Owner can self-export at any time via
  Settings → Export tenant data. Export tarballs retained for 24
  hours.
- **Self-host migration path**: the same git SHA running the
  hosted instance is publicly tagged + documented at
  `docs/en/self-hosting.md`. A tenant can stand up self-host on
  their own infrastructure from the tarball + the public source
  before the 30-day clock expires.
- **Post-deletion residual data**: only audit-trail rows about
  the deletion itself (per migration 0024 + the audit chain
  immutability of ADR-0003 + migration 0021). No tenant
  operational data persists.

### Amendment §9 — Enterprise positioning forward-looking footer

The Enterprise edition referenced in this ADR + feature-matrix +
ADR-0002 + ADR-0021 + ADR-0022 + sibling runbooks is **forward-
looking**. As of 2026-05-18:

- Panorama is **pre-revenue** and **Community-only**.
- No Enterprise SKU exists.
- No Enterprise repo exists.
- "Enterprise edition" mentions in the docs name the *plan* for
  edition placement; they are not commitments to ship those
  features within a date.
- No Enterprise SKU until **a customer asks for one by name**, AND
  the asking is recorded in a sales artefact (not a roadmap doc).
  Trigger language per the product-lead 2026-05-18 planning round
  + this amendment.

This footer applies to every public-facing reference to the
Enterprise edition until ADR-0014 amendment-2 (or a separate
Enterprise-launch ADR) supersedes it.

### Amendment §10 — Counsel-review commitment

The `/legal/{privacy,terms}` pages shipped in PR #245 carry a
"plain-language v1 — pre-counsel-review draft" banner per
ADR-0014 §C6 trigger. The amendment commits to:

- **Counsel-reviewed v2 ships before the first paying tenant.**
  The first paying tenant trigger from §3 also fires the
  counsel-review-completion deliverable. The 30-day change notice
  promised in the legal text applies to any post-counsel
  revision.
- **Until counsel-reviewed v2 lands**, the hosted preview is
  free + the pre-counsel banner remains visible on every legal
  page. The banner is removed only as part of the counsel-reviewed
  v2 commit.

### Amendment §11 — Pre-flip condition list

The URL flip — DNS + Cloudflare routing rule + landing-page copy
+ Fly deploy that exposes the hosted Panorama at the chosen
public hostname — happens when ALL of the following are true.
The maintainer's commit of this amendment is the formal flip
authorization; the checks below must verify BEFORE the maintainer
publishes the DNS change.

**Autonomous (close via sibling v2 surgical fixes PR):**

1. ADR-0021 (web frontend architecture) Status: Proposed →
   Accepted.
2. ADR-0022 (driver native mobile architecture) Status: Proposed
   → Accepted.
3. `apps/core-api/src/modules/signup/signup.controller.ts:284-313`
   — sanitize OIDC error log (security-reviewer §3-1).
4. `docs/runbooks/secrets-inventory.md` — `THROTTLER_ENABLED=1`
   documented as REQUIRED prod env (security-reviewer §3-2).
5. `docs/adr/0022-driver-native-mobile-architecture.md` §5 — promote
   Universal Links / App Links to PRIMARY; `panorama://` to
   fallback (security-reviewer §3-3).
6. `docs/en/roadmap.md` — move "Mobile app" line from Beyond 1.0
   to Wave B (product-lead §4-3).
7. `apps/web/src/app/legal/{privacy,terms}/content.ts` ES
   placeholder — fix the "language switcher" broken-affordance
   reference; either ship the switcher in
   `apps/web/src/app/legal/layout.tsx` OR edit the copy to not
   reference a UI element that doesn't exist (ux-critic §5).
8. `docs/index.md` honesty band — preview disclaimer naming the
   ~10% feature surface vs FleetManager v2.1, no SLA, 30-day
   delete clause (persona-fleet-ops §6).

**External (maintainer executes before committing this amendment):**

9. **Round 6 PR2b restore drill** executed against Supabase staging.
   Observed RTO/RPO captured in
   `docs/audits/restore-drill-2026-05-XX/` (date when executed).
   This closes Wave 0 §8 acceptance.
10. **Counsel-review engagement** for `/legal/{privacy,terms}` —
    a Brazilian-LGPD-qualified lawyer has been retained.
    Engagement letter or equivalent on file. The counsel-reviewed
    v2 deliverable lands later (per amendment §10) but the
    engagement-existence gates THIS amendment.

**Final gate (maintainer-issued):**

11. The maintainer reads this amendment + the v2 scan handoff +
    the surgical-fixes PR + confirms items 9-10 are complete.
    Maintainer commits this amendment with status flipped to
    **Accepted**. The commit is the formal URL-flip
    authorization.

### Amendment §12 — Post-flip operational cadence

Once the URL is live, the following operational rituals apply:

- **Quarterly drills**: incident drill + restore drill (cf.
  `restore.md` §"Drill cadence" + `incident.md` §"Drill cadence").
  Both pair into one operator-hour slot.
- **Weekly chain-verify CLI** on staging: a sustained tamper
  signal triggers `incident.md` Phase 1 from the cron's failure
  notification.
- **Status-page workflow** running (PR #243): every 15 min, with
  auto-issue creation on sustained failure.
- **SBOM regeneration**: on every push to main that touches
  `package.json` / `pnpm-lock.yaml`; signed on release-tag push.
- **Day-60 metrics review** per §3: scheduled calendar event 60
  days post-flip. The review writes a decision document under
  `docs/audits/day-60-metrics-<YYYY-MM-DD>.md` covering: number of
  active tenants vs the 25-cap, opt-in feature-flag adoption
  (FEATURE_INSPECTIONS / FEATURE_MAINTENANCE / FEATURE_SELF_SERVE_SIGNUP),
  Sentry event rate per tenant, signup-flood rate-limit trip
  count, support-channel volume.

### Amendment §13 — Rollback path for the URL flip

If the URL flip surfaces a P0 incident in the first 7 days
(audit-chain tamper, RLS leak, sustained `/health` failure, mass-
signup abuse the throttler doesn't catch), the maintainer:

1. Sets `FEATURE_SELF_SERVE_SIGNUP=false` (kills new signups
   without disrupting existing tenants)
2. If the incident is data-impacting, drains traffic via Fly
   `scale count 0` per `incident.md` Phase 3
3. Notifies active tenants per the 30-day notice clause (§4 + §8)
4. Files an `incident-followup` GitHub issue documenting the
   rollback rationale
5. Drafts ADR-0014 amendment-2 capturing the post-mortem +
   restating the URL-flip readiness conditions for re-attempt

The URL flip is reversible; the data lifecycle commitment (§4)
guarantees tenants retain their data on a rollback.

### Amendment §14 — Verdict

**Aggregate v2 6-agent scan verdict: CONDITIONAL GO** on the URL
flip, gated on items §11-1 through §11-11 above.

The maintainer commits this amendment with `Status: Accepted` —
flipping from `Status: Proposed` — once items §11-1 through
§11-10 verify. The commit IS the URL-flip authorization.

