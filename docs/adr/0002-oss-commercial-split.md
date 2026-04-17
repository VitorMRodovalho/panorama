# ADR-0002: OSS Community + commercial Enterprise split

- Status: Accepted
- Date: 2026-04-17
- Deciders: Vitor Rodovalho

## Context

We want:

1. A credible **open-source** product — self-hostable, no feature flags hidden behind
   "contact sales for a quote", AGPL so SaaS forks contribute back.
2. A **commercial** revenue stream that funds full-time maintainers.
3. A **clean** boundary: contributors never have to read or touch commercial
   code, and we never accidentally leak it by tagging the wrong commit.

We studied prior art:

- **GitLab** — single repo, EE and CE interleaved in `/ee` and `/ce` paths; they
  later consolidated to a single codebase with feature gates. Boundary is
  technically enforced but "one wrong merge" stories exist.
- **Sentry** — split into `getsentry/sentry` (BSL core) + `getsentry/getsentry`
  (private commercial). Clean boundary; the private repo pulls the public one
  as a dependency.
- **Elastic** — started AGPL, moved to SSPL after SaaS forks. Controversial.

We prefer **Sentry-style split**. We favour AGPL-3.0 for the Community edition
over SSPL: AGPL is OSI-approved and FSF-endorsed, SSPL is not; long-term
distribution partners (Linux distros, cloud vendors) require OSI approval to
bundle us.

## Decision

Two top-level repositories:

### `panorama` (public, this repo) — Community edition

- AGPL-3.0-or-later
- Contains everything needed to run a fully-functional instance
- All core flows work without Enterprise: asset management, bookings,
  inspections, maintenance, SAML/OIDC basic, audit log, reports, API
- No "call sales" dead ends
- Releases tagged as `v1.2.3`

### `panorama-enterprise` (private) — Enterprise edition

- Proprietary, per-seat commercial licence
- Depends on `panorama` at a pinned version as a published npm package
  (published from the public repo's release pipeline)
- Contains only **additive** modules:
  - Premium IdP connectors (Okta advanced, Ping, JumpCloud SCIM push)
  - Compliance packs (SOC-2 evidence export, NIST AAL-2 WebAuthn, FedRAMP audit log)
  - White-label / theming engine
  - Advanced RBAC (attribute-based, policy-as-code)
  - Priority connectors (SAP Ariba, Oracle Fusion, Coupa, Fleetio)
  - SLA-backed support dashboards
- Releases tagged as `v1.2.3-enterprise`
- **Cannot remove or gate features** that exist in Community

### `panorama-infra` (public, MIT)

- Opinionated Terraform / Helm / Ansible recipes for self-hosting
- MIT (not AGPL) so internal ops teams can copy-paste without legal review

## How the build works

```
panorama (public)
  └─ on tag v1.2.3
     ├─ publishes Docker image `ghcr.io/panorama/core-api:1.2.3`
     ├─ publishes npm packages `@panorama/*:1.2.3`
     └─ (private CI job) triggers bump PR in panorama-enterprise

panorama-enterprise (private)
  └─ depends on @panorama/* @ 1.2.3
     ├─ on tag v1.2.3-enterprise
     └─ publishes Docker image `ghcr.io/panorama/enterprise:1.2.3`  (private registry)
```

## When to open the commercial repo

Not at day zero. Order of operations:

1. **Now (April 2026)** — `panorama` public, no enterprise repo. All effort on
   Community parity with Snipe-IT + FleetManager.
2. **At ~v0.4** — mature enough for closed beta customers. Spin up
   `panorama-enterprise` as private repo with two or three initial modules
   (white-label + SOC-2 audit pack + premium support dashboards).
3. **At v1.0 GA** — publish Enterprise pricing, enable the commercial CI pipeline.

We deliberately ship the Community edition to its **first happy customer** before
commercial exists. That's the forcing function that keeps Community good.

## Alternatives considered

### Open-core single-repo with feature flags

Contamination risk. Contributors can accidentally read or be influenced by
licence-restricted code. Rejected.

### BSL (Business Source License)

Valid, but conversion clauses (usually 4 years to Apache) make it harder to
build developer trust in the short term. Rejected for now.

### No commercial edition at all

Good for the community, bad for sustainability. We have seen too many
single-maintainer OSS projects collapse. Rejected.

## Consequences

### Positive
- Clean contributor story: public repo is the only one you can see, touch, and
  read as a non-employee
- Commercial incentives don't corrupt the Community roadmap because Enterprise
  is strictly additive
- Enterprise can move fast on licence-sensitive features (SSO connectors with
  NDA-restricted docs, etc.)

### Negative
- Two CI pipelines to maintain
- Version drift between `panorama` and `panorama-enterprise` requires careful
  pinning and a monthly release train
- Contributors in closed beta may propose features that belong in Enterprise;
  we must be explicit about the tier early

### Neutral
- A CLA **is** required for Enterprise-destined contributions (because the
  project ships them under a commercial licence). The Community-only
  contributor flow is CLA-free.
