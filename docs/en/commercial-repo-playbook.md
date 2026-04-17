# Commercial repo playbook

How and when we spin up `panorama-enterprise`, the private commercial repository.
Extracted from ADR-0002 into an actionable checklist.

## Why a separate repo at all

Read ADR-0002 for the full reasoning. Short version: contamination-proof
boundary between OSS and commercial code + clean contributor story.

## When to create it

**Not yet.** The project is pre-alpha. Spinning up a commercial repo too early
signals to the OSS community that commercial is where the effort is going, and
it saddles us with a two-pipeline burden before there's revenue to justify it.

Create `panorama-enterprise` when **all three** conditions are met:

1. Panorama Community has shipped its first public release (`v0.3` or `v0.4`,
   roughly Sept–Nov 2026).
2. We have a **signed letter of intent** from at least one paying design-partner
   customer who wants a feature we're willing to put in Enterprise.
3. We have a full-time person who will own Enterprise (can be the same
   maintainer on part-time split initially).

Until then, any "Enterprise candidate" feature sits in a `docs/en/enterprise-backlog.md`
file in the public repo, with a note that it's intentionally deferred.

## Where it lives

- **GitHub organisation** `panorama` (public-facing) — add `panorama-enterprise`
  as a private repo in the same org. GitHub's Teams model lets us limit access
  cleanly.
- **Alternative** if the OSS community grows before Enterprise: consider
  `panorama-co` as a separate corporate org and keep the community in
  `panorama`. Decide at creation time based on ownership structure.

## Repo layout (when we create it)

```
panorama-enterprise/
├── README.md                    # "This is the commercial edition..."
├── LICENSE                      # Proprietary commercial licence
├── packages/
│   ├── whitelabel/              # Per-tenant theming engine
│   ├── soc2-pack/               # SOC-2 audit evidence export
│   ├── okta-advanced/           # Premium Okta connector
│   └── policy-as-code/          # Rego-based ABAC
├── apps/
│   └── ops-console/             # Commercial-only ops dashboard
├── infra/
│   └── pinned-community/        # git submodule pointing at a Community tag
├── scripts/
│   └── bump-community.ts        # Automated Community-version bump
├── package.json                 # Depends on @panorama/* @ <pinned version>
└── pnpm-workspace.yaml
```

The Enterprise build **consumes** the Community edition as:

1. A pinned npm version of `@panorama/*` packages (cleanest)
2. A git submodule at a signed release tag of the `panorama` repo (fallback if
   we need to patch before an upstream release)

Never by copy-paste of Community files.

## Access controls

- **Write access** to `panorama-enterprise`: full-time Enterprise maintainers only
- **Read access**: same + a few trusted design-partner engineers under NDA
- **CI secrets**: separate from Community CI; no public Actions logs leak
- **Issues**: private; we triage and optionally mirror a sanitised version in
  the Community repo if it's non-sensitive

## Release cadence

- **Community** releases on its own train (monthly 0.x during build-up;
  quarterly 1.x after GA)
- **Enterprise** releases **follow** a Community release by 1–2 weeks:
  1. Community v1.4.0 ships Monday
  2. Enterprise automation opens a bump PR in `panorama-enterprise`
  3. Engineers review, adjust anything (new API, breaking change), run the
     Enterprise-only test suite
  4. Enterprise v1.4.0 ships the following Monday
- **Never** release an Enterprise that depends on an unreleased Community

## CLA

Contributions destined for the commercial repo require the contributor to have
signed the Panorama CLA (Community-only contributions do not). The CLA grants
the Panorama project the right to dual-license. We use the Apache Individual CLA
text verbatim so lawyers can approve quickly.

Community-only contributors never see or sign a CLA.

## Pricing strategy (outline)

Published separately at panorama.vitormr.dev/pricing when we're ready to sell.
Typical shape:

- **Starter** — up to 50 users — per-user/month, credit card
- **Growth** — up to 500 users — per-user/month, invoice + PO
- **Enterprise** — unlimited — negotiated annual, SLA, SOC-2, support
- Non-profit & education discount (tier below Starter at cost)
- Panorama-hosted SaaS tier priced separately (adds infra + SOC-2 hosting)

## Trademark registration

Spin up the commercial repo at the same time as the trademark filings
(ADR-0004). The commercial entity holds the trademark; Community uses it under
a perpetual royalty-free licence. This keeps the brand consistent across both
editions and protects us if a SaaS fork tries to use the wordmark.

## Day-one Enterprise features

The first set that justifies the split (and none sooner):

1. **White-label / theming** — per-tenant logo, colour, email template, login
   page, custom domain. Relatively self-contained; high value for buyers.
2. **SOC-2 audit pack** — evidence export, control mapping, scheduled
   attestation reports. Sellable into mid-market.
3. **Priority support dashboards** — customer-facing ticketing that customers
   plug into via Zendesk / Intercom.

Deferred to a second wave:

- Premium IdP connectors (Okta advanced, PingFederate)
- ABAC / policy-as-code
- Predictive maintenance
- Data residency pinning

## Exit clauses

If the Enterprise edition shuts down or the maintaining company ceases to
operate, we commit to **releasing the Enterprise repo under AGPL-3.0-or-later**
within 90 days, so customers are never stranded. This clause lives in the
Enterprise licence text and the website — it's a credibility anchor for
buyers comparing us against closed-source competitors.

## Checklist before day 1 of Enterprise

- [ ] Trademark registrations filed (US + EU + BR)
- [ ] Commercial entity / LLC / Ltda set up
- [ ] `panorama-enterprise` repo created, access controls set
- [ ] CLA workflow live (CLA Assistant or equivalent)
- [ ] Private CI with pinned-Community automation
- [ ] Pricing page draft
- [ ] Legal: commercial licence text reviewed (template plus adjustments)
- [ ] Support desk: email (support@), ticketing tool, on-call rota
- [ ] Observability for Enterprise-only modules separated from Community's
