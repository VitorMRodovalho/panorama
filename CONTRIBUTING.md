# Contributing to Panorama

Thanks for your interest in helping. This document is the authoritative guide for
getting changes into Panorama.

## Ground rules

1. **Open an issue first.** We don't accept surprise pull requests for anything
   larger than a typo fix. Describe the problem, the proposed approach, and your
   willingness to own the follow-ups.
2. **Pick the right edition.** Label your issue `edition: community` or
   `edition: enterprise`. If you're unsure, open it in the community repo first
   and a maintainer will reclassify.
3. **No hardcoded English.** Every user-facing string lands in
   `packages/i18n/en/*.json` with matching keys in `pt-br/` and `es/`. PRs that
   slip English into components get blocked by CI.
4. **Migrations must be reversible.** Every Prisma migration ships a rollback
   note in the migration folder README. No destructive column drops without a
   two-phase migration plan.
5. **Small, reviewable PRs.** Target < 400 lines changed (excluding generated
   code and fixtures). Bigger changes need to be split.
6. **Conventional Commits.** `feat(core-api): ...`, `fix(web): ...`, etc.
   The commit message body explains **why**; the diff shows **what**.
7. **Write the test.** New features require tests. Fixes require a regression
   test. CI requires ≥ 80 % line coverage on touched files.

## Dev setup

See [README.md § Getting started](./README.md#getting-started-dev).

## Branches

- `main` — always deployable, protected, requires 1 review + passing CI
- `release/x.y` — cut from main when we freeze for a release; only patches land here
- Feature branches: `feat/<short-kebab>`, `fix/<short-kebab>`, `chore/<short-kebab>`

Never force-push to `main` or `release/*`.

## Testing

```bash
pnpm test                 # all packages
pnpm --filter @panorama/core-api test
pnpm e2e                  # Playwright against a docker-compose stack
pnpm lint                 # ESLint + Prettier + markdownlint
pnpm typecheck
```

## Reporting security issues

Do **not** open a public issue for a security vulnerability. Email
**security@vitormr.dev** with:

- Affected version
- Reproduction steps
- Impact assessment
- Your preferred disclosure timeline

We aim to acknowledge within 48 h and ship a fix within 14 days for critical issues.

## Licensing

By submitting a contribution you agree it is licensed under AGPL-3.0-or-later, the
same licence as the repository. We may later require contributors to sign a CLA
before we can merge Enterprise-destined code — see
[ADR-0002](./docs/adr/0002-oss-commercial-split.md).

## AI assistance attribution

Panorama is developed with AI coding assistance (Claude Code). Our convention is:

- Commits that received meaningful AI help include an `Assisted-By:` trailer, e.g.
  ```
  Assisted-By: Claude (Anthropic) <noreply@anthropic.com>
  ```
  This is a **non-standard, informational trailer** — it is not Git-recognised
  and does NOT register the assistant as a co-author in GitHub's UI. The human
  listed as `Author:` is the sole author of record and the responsible party
  for the change.
- Commits landed before 2026-04-18 may still carry the legacy
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
  trailer. We are not rewriting history to change them — the trailer is
  inaccurate only in the sense of the framing, not in the sense of the work
  done. Going forward `Assisted-By:` is the standard.
- Contributors are under no obligation to disclose AI assistance unless a
  policy change requires it (e.g. an enterprise customer contract). Use your
  judgement.

## Community

- Discussions: GitHub Discussions on this repo
- Chat: (TBD) Matrix or Discord server before first public release
