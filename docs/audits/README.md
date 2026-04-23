# Audit trail

Durable record of QA/QC audit passes over the Panorama codebase. Each wave is a snapshot-in-time review; findings are also filed as GitHub issues with the `audit:wave-N` label so they can be triaged, owned, and closed individually.

## Start here

**→ [`HANDOFF-2026-04-23.md`](./HANDOFF-2026-04-23.md)** — master entry point after the 3-wave baseline audit. Prioritised action list across 5 tiers, sprint-split scenarios, decisions needing maintainer input, scope disclosure, and the full map of everything produced. If you're picking this up cold, start there.

## Waves

- [2026-04-23 — Wave 1](./2026-04-23-wave-1.md) — pre-alpha full-repo baseline. Security, architecture, data, UX, ops, product. ~68 distinct findings; top 25 filed as individual issues.
- [2026-04-23 — Wave 2](./2026-04-23-wave-2.md) — four follow-up deep-dives. RLS compliance sweep (53 call sites classified), notification bus trace (76 events catalogued), query perf baseline (10 queries analysed, runnable `perf/baseline.sql` delivered), CI hardening (8 concrete diffs + 6-PR rollout plan). 38 new findings.
- [2026-04-23 — Wave 3](./2026-04-23-wave-3.md) — pilot readiness gap (MVP cut for first real pilot tenant) + supply-chain advisory triage + MCP CVE family exposure analysis. 20 findings. Produced ADR-0017 (draft, AI/LLM integration principles) and `docs/runbooks/dev-environment-ai-tooling.md`. Triggered in part by the 2026-04-20 OX Security disclosure of design-level RCE in Anthropic's MCP SDK.

## Conventions

- One folder per wave date. Audit docs are immutable after their wave ships — corrections live in the next wave, not by editing history.
- Each wave opens one tracking issue (parent) and N per-finding issues (children, `closes` the parent when all are resolved or deferred).
- Severity scale: `critical` (ship blocker, pre-alpha or later) / `high` (pre-pilot blocker) / `medium` (pre-1.0) / `low` (nice-to-have) / `info` (documented, no action).
- Findings that cross multiple reviewer domains are consolidated into one issue with cross-links, not fanned out.
