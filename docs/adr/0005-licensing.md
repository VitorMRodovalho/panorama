# ADR-0005: Licensing — AGPL-3.0-or-later for Community

- Status: Accepted
- Date: 2026-04-17
- Deciders: Vitor Rodovalho

## Context

We need to choose a licence for the public / Community edition that:

- Is **OSI-approved** (so distros and cloud vendors can bundle us)
- **Discourages proprietary SaaS forks** that eat our lunch without
  contributing back
- Is **compatible with Snipe-IT's AGPL-3.0** origin code that our migration
  shim emulates (we never copy Snipe-IT code, but the precedent matters)

## Decision

**AGPL-3.0-or-later** for everything in the public `panorama` repo.

Rationale:

1. AGPL closes the "SaaS loophole" in GPL — if you run a modified version as a
   network service, you must share your modifications with the service's users.
   This aligns with our sustainability story.
2. OSI-approved and FSF-endorsed, unlike SSPL / BUSL; Linux distros, Debian,
   Fedora will package us; cloud vendors can (with conditions) bundle us.
3. Low cognitive cost for contributors: "same as Snipe-IT" is a recognised
   licence in our space.
4. Gives us a clear story when a cloud vendor copies us: either contribute
   back or pay for the commercial edition.

Enterprise-only modules in `panorama-enterprise` are under a **proprietary
commercial licence**. That's a separate repo, separate licence, separate
distribution story — documented in ADR-0002.

## Alternatives considered

- **Apache 2.0** — permissive. Attracts more corporate adoption but doesn't
  push cloud vendors to contribute back. Rejected.
- **MIT** — same story as Apache, minus patent clauses. Rejected.
- **BSL (Business Source License)** — auto-converts to Apache after N years.
  Better than proprietary; strictly worse than AGPL for OSI adherence.
  Rejected.
- **SSPL** — non-OSI-approved; cloud-vendor-hostile in a way that also hurts
  non-adversarial adopters. Rejected.
- **MPL 2.0** — file-level copyleft; doesn't close the SaaS loophole.
  Rejected.

## Consequences

### Positive
- SaaS vendors cannot fork us into a closed product
- We are OSI-aligned and get all distribution benefits
- Contributors understand what they're signing up to

### Negative
- Some enterprise procurement departments red-flag AGPL; we need a short
  legal FAQ (`docs/en/licensing.md`) to explain that hosting Panorama
  internally does **not** trigger the network clause (only distributing a
  modified version does)
- We must audit any copied code for licence compatibility — we'll run
  `license-checker` in CI

### Neutral
- Our choice does not require us to ever write a CLA for Community
  contributions. We will require a CLA only for contributions destined for
  the commercial Enterprise tier (ADR-0002).
