# Architecture Decision Records

ADRs capture **why** we chose one option over others for a decision we expect to live with for years.
Keep them short. Date them. When superseding, link back and mark the old one deprecated.

| # | Title | Status | Date |
|---|-------|--------|------|
| 0001 | [Stack choice: NestJS + Next.js + Postgres + Prisma](./0001-stack-choice.md) | Accepted | 2026-04-17 |
| 0002 | [OSS/Community + commercial Enterprise split](./0002-oss-commercial-split.md) | Accepted | 2026-04-17 |
| 0003 | [Multi-tenancy model: row-level with tenant-scoped queries](./0003-multi-tenancy.md) | Accepted | 2026-04-17 |
| 0004 | [Product name: Panorama](./0004-name.md) | Proposed | 2026-04-17 |
| 0005 | [Licensing: AGPL-3.0-or-later for Community](./0005-licensing.md) | Accepted | 2026-04-17 |
| 0006 | [Plugin / extension SDK boundary](./0006-plugin-sdk.md) | Draft | 2026-04-17 |
| 0007 | [Tenant Owner role (designated admin)](./0007-tenant-owner-role.md) | Accepted | 2026-04-18 |
| 0008 | [Invitation flow (email-token, TTL, one-time-use, audit)](./0008-invitation-flow.md) | Accepted | 2026-04-18 |
| 0009 | [Reservation domain (two-axis state, conflicts, blackouts, approval)](./0009-reservation-domain.md) | Accepted | 2026-04-18 |
| 0010 | [Snipe-IT compat shim — auth model (per-user PATs)](./0010-snipeit-compat-shim-auth.md) | Accepted | 2026-04-18 |
| 0011 | [Notification event bus — architecture](./0011-notification-event-bus.md) | Accepted | 2026-04-18 |

## Template

```
# ADR-NNNN: <short title>

- Status: Proposed | Accepted | Deprecated | Superseded by ADR-XXXX
- Date: YYYY-MM-DD
- Deciders: @alice, @bob

## Context
What is the problem? What constraints are we working under? What did we try before?

## Decision
What did we pick? State it as a sentence; avoid hedging.

## Alternatives considered
Brief list with why each was rejected.

## Consequences
Positive, negative, and neutral outcomes. What this locks us into. What this frees us up for.
```
