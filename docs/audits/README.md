# Audit trail

Durable record of QA/QC audit passes over the Panorama codebase. Each wave is a snapshot-in-time review; findings are also filed as GitHub issues with the `audit:wave-N` label so they can be triaged, owned, and closed individually.

## Waves

- [2026-04-23 — Wave 1](./2026-04-23-wave-1.md) — pre-alpha full-repo baseline. Security, architecture, data, UX, ops, product. ~68 distinct findings; top 25 filed as individual issues.

## Conventions

- One folder per wave date. Audit docs are immutable after their wave ships — corrections live in the next wave, not by editing history.
- Each wave opens one tracking issue (parent) and N per-finding issues (children, `closes` the parent when all are resolved or deferred).
- Severity scale: `critical` (ship blocker, pre-alpha or later) / `high` (pre-pilot blocker) / `medium` (pre-1.0) / `low` (nice-to-have) / `info` (documented, no action).
- Findings that cross multiple reviewer domains are consolidated into one issue with cross-links, not fanned out.
