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
