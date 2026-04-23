# ADR-0017: AI/LLM integration principles

- Status: **Draft** (drafted 2026-04-23 from Wave 3b audit; pending maintainer acceptance)
- Date: 2026-04-23
- Deciders: TBD (maintainer + ai-architect + security-reviewer)
- Related: ADR-0006 (plugin-sdk), `.claude/agents/ai-architect.md`

## Context

On 2026-04-20, OX Security disclosed CVE-2025-49596 et al. — a design-level RCE affecting Anthropic's MCP (Model Context Protocol) SDK and 7,000+ publicly accessible MCP servers / 150M+ downloads. The core flaw: MCP's STDIO transport allows configuration-to-command execution with no sandboxing boundary. Anthropic declined to patch the reference implementation, calling the behaviour "expected."

Reference: [The Hacker News — Anthropic MCP Design Vulnerability](https://thehackernews.com/2026/04/anthropic-mcp-design-vulnerability.html).

Panorama has no AI features in production today (correctly — `.claude/agents/ai-architect.md` is in standby until the first AI feature ADR lands, targeted 0.3+). This ADR establishes guardrails **before** any AI feature lands or ADR-0006 (plugin-sdk) exits Draft, so the team doesn't accidentally replicate MCP's architectural mistakes.

This ADR was drafted from Wave 3b audit findings (MCP-04). It is a skeleton — individual principles may be revised as the first AI feature is scoped. What is non-negotiable is that **the ADR exists and is Accepted before AI code ships**.

## Decision

The following six principles govern any AI/LLM integration in Panorama — whether via a core feature, a plugin, a dev-environment tool, or a cloud-side inference path.

### Principle 1 — Separation of configuration from execution

No configuration file (JSON, YAML, env var, manifest) shall trigger code execution by its mere presence or modification. Plugin manifests declare metadata; a separate audited loader with cryptographic verification decides whether to execute. **This principle is the direct lesson from the MCP CVE family.**

### Principle 2 — Real isolation boundary for untrusted code

`vm.runInContext`, `vm.createContext`, and "Node VM" in general are **not** security boundaries (per [Node.js documentation](https://nodejs.org/api/vm.html)). Any code from a third party (plugin, AI tool, marketplace download, LLM-generated tool invocation) runs in one of:

- Worker thread with `--experimental-permission` (Node 20+) and deny-by-default filesystem/network permissions
- Container or sidecar with no host filesystem access beyond an explicit bind mount
- Deno isolate with explicit `--allow-*` flags

### Principle 3 — Explicit allowlist, deny by default

No MCP server, plugin, AI tool, or external inference endpoint runs in Panorama's process space unless:

1. Explicitly allowlisted in a signed configuration file (cryptographic signature by a maintainer)
2. Allowlist entries cite the purpose, the signing reviewer, and the review date
3. Marketplace-sourced code requires human approval + signature verification before execution

### Principle 4 — Prompt-injection threat modeling is mandatory

Any feature where an LLM reads user-supplied content (asset names, inspection notes, reservation comments, imported Snipe-IT data) and then calls tools based on that content **MUST** include a prompt-injection threat model section in its feature ADR. The threat model must cover:

- What tools can the LLM invoke?
- What is the worst-case outcome of a tool call triggered by injection?
- What is the rollback/audit path?
- How does the system distinguish human-initiated from LLM-initiated mutations?

### Principle 5 — Tool-use audit parity

LLM-invoked tools that mutate tenant state emit the same `panorama.*` audit events as human-invoked code paths, with an additional `actorSource: 'llm_agent'` marker plus the LLM run ID, prompt hash, and tool-call ID. No AI mutation is silent. No exceptions.

### Principle 6 — AI dependency supply-chain review

Before adding any AI/LLM dependency — `@modelcontextprotocol/*`, `@anthropic-ai/*`, `openai`, `langchain`, `llamaindex`, or equivalent — the security-reviewer must triage:

- Its CVE history (30 days minimum; check NVD + GHSA)
- Its transport model (STDIO vs HTTP vs WebSocket) and the trust boundary of each
- Its sandboxing guarantees
- Whether its authors have indicated a history of responding (or not) to security reports

**Known-vulnerable transports (MCP STDIO without sidecar isolation) are vetoed pending upstream fix.**

## Alternatives considered

- **No governance ADR; rely on the ai-architect subagent.** Rejected — the subagent needs a policy document to enforce. Without it, guidance is implicit, inconsistent, and brittle to subagent-config drift.
- **Ban all AI features until 1.0.** Rejected — overly conservative. The guardrails above allow safe adoption at 0.3+.
- **Defer the ADR until the first AI feature is scoped.** Rejected — this is exactly how MCP's architecture mistake propagated (implementation first, governance later). The ADR is the gate, not the consequence.

## Consequences

### Positive

- First AI feature ships with security-reviewed architecture, not retrofitted controls.
- ADR-0006 (plugin-sdk) inherits the isolation requirements before it exits Draft — closes the analogy risk flagged as Wave 3b MCP-02.
- Dev-environment AI tooling guidance (see `docs/runbooks/dev-environment-ai-tooling.md`) has a policy anchor.
- The `ai-architect` subagent gets a written policy to enforce.

### Negative

- Adds review overhead to AI feature proposals. This is deliberate.
- May slow initial AI feature development by requiring isolation infrastructure that doesn't exist yet.

### Neutral

- This ADR is intentionally strict. It can be relaxed per-principle with a follow-up ADR if a specific use case justifies it — but the default is strict.
- The six principles will be re-evaluated whenever a new high-severity AI-supply-chain CVE class is disclosed (the MCP CVE family being the precipitating event for this ADR).
