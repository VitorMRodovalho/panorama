---
title: Early access
---

# Early access — Panorama hosted preview

The Panorama hosted preview is **not yet open**. We're working through
the public-preview readiness checklist (Wave 0 in the
[roadmap](/en/roadmap)) before the URL goes live.

## When it opens

The hosted preview will be **free, no SLA, data may be wiped with 30
days notice** (operational commitments codified in
[ADR-0014](/adr/0014-public-hosted-instance)). You'll be able to:

- Sign up via Google or Microsoft OIDC (no password)
- Provision your own tenant in one click
- Bring real fleet or asset data and try the workflows
- Export your data anytime
- Delete your tenant anytime (7-day cool-off applies)
- Talk to the maintainer weekly about what's broken — that's the deal

## Until it opens

- **Watch the repo** — [GitHub Releases](https://github.com/VitorMRodovalho/panorama/releases)
  will publish the URL-flip release tag
- **Public roadmap** — [`/en/roadmap`](/en/roadmap) tracks the Wave 0 path
- **Email** —
  [vitorodovalho@gmail.com](mailto:vitorodovalho@gmail.com?subject=Panorama%20hosted%20preview%20-%20notify%20me)
  to follow along; we'll email you when the URL opens

## Self-host alternative

If you'd rather not wait, or you want your data on your own
infrastructure: Panorama is AGPL-3.0 self-host-friendly. See the
[self-hosting guide](/en/self-hosting). Same codebase, same features,
your servers.

## Why "preview" and not "beta"

Different word, different meaning. "Beta" implies "feature-complete,
hunting bugs." Panorama isn't there yet — the daily-driver UI surface
is still being built, photo uploads still run synchronously, and the
hosted instance is **the maintainer's instance** you're welcome to
use, not a commercial offering. "Preview" describes what's true:
you'll see something real, with rough edges, while the operator who
ships it is genuinely available to talk about what's broken.

Bring real data only if you also have a copy elsewhere. We'll be
honest about what's stable enough to depend on as the surface
matures.
