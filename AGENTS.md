# Panorama — Agent Context

Loaded automatically by Claude/Cursor/Cline/Aider (2025-2026 convention). **Read this before making changes.**

This file holds **how to operate as an agent in Panorama**. For sub-agent specialization (lanes, personas, scopes), see [`.claude/agents/`](./.claude/agents/) — 7 specialized agent definitions already exist there.

## Quick reference

| Need to… | Go to |
|---|---|
| Project overview | `README.md` (also `README.pt-br.md`, `README.es.md`) |
| Sub-agent definitions | `.claude/agents/` |
| Architecture decisions | `docs/adr/` |
| Audit findings | `docs/audits/` (3-wave QA/QC done 2026-04-23, 126 findings) |
| Current wave plan | `docs/audits/HANDOFF-2026-05-09-session-end.md` |
| Security policy | `SECURITY.md`, `.gitleaks.toml`, `.trivyignore`, `.runAsSuperAdmin.allowlist.json` |
| Contributing | `CONTRIBUTING.md` |
| Workspace structure | `pnpm-workspace.yaml`, `turbo.json` |
| Validation | `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build` |

## What this is

Unified open-source platform for IT asset + operational fleet management. Successor to Snipe-IT + SnipeScheduler-FleetManager. **AGPL-3.0** (fork-friendly, copyleft).

**Stack:** TypeScript monorepo (pnpm + Turborepo). NestJS 11 backend (`apps/core-api`) + Next.js frontend (`apps/web`) + Prisma 6 + PostgreSQL with RLS. OIDC end-to-end. Hash-chained tamper-detected audit log. Multi-tenant from construction (RLS forced at every tenant-scoped table). Trilingual EN/PT-BR/ES.

**Packages:** `i18n`, `migrator`, `plugin-sdk`, `shared`, `ui-kit`.

**Status:** Early access, bootstrapped 2026-04-17. Backend production-ready (PR #92); Web app in active build (~10% surface, PR #52). Hosted preview opening when Wave 0 readiness closes.

## Harness engineering principles (adopted 2026-05-19)

Anchored on Anthropic's three engineering posts:
- [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) (2024) — workflow patterns
- [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (Nov 2025) — context as a finite resource
- [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (Mar 2026) — multi-session continuity, handoff artifacts

**1. Workflow first, agent second.** Most CRUD-shaped tasks (entity, controller, page, migration) are deterministic — write the pipeline, don't loop the model. The sub-agents in `.claude/agents/` exist for tasks that genuinely need specialized reasoning (architecture review, persona validation, security review, UX critique).

**2. Context is finite.** Don't paste full Prisma schema or i18n files. Use targeted reads (`grep`/`glob`); load ADRs in `docs/adr/` on demand. Trilingual i18n is large — operate on one locale at a time, then propagate.

**3. Persist outside the model.** State of in-flight work lives in: ADRs in `docs/adr/`, GitHub issues, draft PRs, `docs/audits/HANDOFF-*` for cross-session continuity, sub-agent context files in `.claude/agents/`. Do not invent parallel "progress files".

**4. Validate, don't trust.** Every completion claim must be proven:
- `pnpm lint` (per-package linter)
- `pnpm typecheck` (tsc across workspace)
- `pnpm test` (unit + integration)
- `pnpm build` (Turbo full build — all packages green)
- For DB changes: `pnpm prisma migrate diff` and run migration against a local DB first
- CI additionally runs gitleaks + trivy — both must pass

No exceptions for "small changes" — gates run cheap, regressions are expensive.

**5. Plan for context reset.** Multi-issue features must write progress to a draft PR description or extend `docs/audits/HANDOFF-*` before context fills. The next session reads the HANDOFF, picks up. Wave plans are explicit.

**6. The ACI is the product.** API routes, GraphQL resolvers (if any), CLI flags = public surface. Their schemas, descriptions, error messages = production contract. Treat changes accordingly.

**7. Guardrails in layers:**
- Input validation: NestJS DTOs, Zod schemas at API boundary
- Permissions: multi-tenant RLS at DB level, RBAC at app level, `.runAsSuperAdmin.allowlist.json` for elevated ops
- Risk-rating: rate limits on critical endpoints
- HITL for destructive: tenant deletes, schema migrations on shared infra — never auto-apply against production
- Audit trail: hash-chained, tamper-detected — never log around or bypass

## Agent lanes

7 specialized sub-agents live in [`.claude/agents/`](./.claude/agents/). **Read the agent file before operating in its lane.**

| Agent | File | When to invoke |
|---|---|---|
| **ai-architect** | `ai-architect.md` | Designing new AI/ML features, MCP tools, agentic flows |
| **data-architect** | `data-architect.md` | Schema design, RLS policy, tenant isolation |
| **persona-fleet-ops** | `persona-fleet-ops.md` | Validating product decisions against fleet-ops operator persona |
| **product-lead** | `product-lead.md` | Scope, prioritization, roadmap |
| **security-reviewer** | `security-reviewer.md` | Auth, OIDC, RLS, audit chain, secret handling |
| **tech-lead** | `tech-lead.md` | Architectural review, tech debt prioritization |
| **ux-critic** | `ux-critic.md` | UI/UX review, accessibility, i18n consistency |

## Cross-cutting rules

1. **AGPL discipline.** Every dep added must be AGPL-compatible. Check license before `pnpm add`.
2. **Multi-tenant by default.** Every query against tenant-scoped tables MUST filter by tenant. RLS enforces, but app code shouldn't rely on RLS as primary guard — defense in depth.
3. **Trilingual or explicitly partial.** New user-facing strings go to all 3 locales in the same PR. Single-locale PRs blocked unless flagged as partial in the PR body.
4. **Hash-chained audit trail is sacred.** Never log around it. Never bypass. Audit events flow through the chain.
5. **No proprietary data.** Test fixtures synthetic only. `.gitleaks.toml` enforces secret scanning.
6. **Break the build = revert.** Turbo CI failure post-merge → revert before any other work.
7. **One concern per commit.** DB migrations don't ship with UI changes in the same commit.

## Validation gates (mandatory before merge to `main`)

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build

# For DB changes additionally:
cd apps/core-api && pnpm prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma
```

CI runs gitleaks + trivy. Both must pass.

## When to consult external sources

- Anthropic harness/context/agent posts (linked above) — when designing a new agentic flow or MCP tool
- NestJS / Next.js docs — prefer official docs to Stack Overflow
- Prisma docs — for schema patterns and migration strategy
- AGPL-3.0 text — when in doubt about license obligations on new deps

---

*Initial adoption: 2026-05-19. Coordinated with the sub-agent definitions in `.claude/agents/`.*
