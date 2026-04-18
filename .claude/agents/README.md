# Panorama agent team — phase 1

Persona sub-agents that review Panorama's work with specific lenses.
Each file in this directory is a self-contained Claude Code sub-agent
definition with YAML frontmatter + system prompt. Claude Code picks
them up automatically when the working directory is this repo.

## Design principle: **agents with teeth, not cheerleaders**

Every agent is scoped so they can say "no". If an agent can't veto or
surface a concrete gap, it's ceremony. We're deliberately small —
research consensus (Anthropic engineering blog Jun/2024, Claude Code
Agent Teams docs v2.1.32+) shows 2–5 specialised agents is the sweet
spot; we sit at 7 because two are domain personas (standby +
end-user) rather than reviewers.

## Phase 1 roster (active)

| Agent | Domain | Has veto? | Trigger |
|---|---|---|---|
| `tech-lead` | architecture, migrations, module boundaries | yes | pre-push in any backend diff |
| `security-reviewer` | OWASP, RLS, auth surfaces, PII | yes | any diff touching auth/tenant/invitation/reservation |
| `ux-critic` | web accessibility, cognitive load, trilingual coverage | yes (apps/web/ only) | apps/web/ diffs + new flows |
| `product-lead` | scope, roadmap, edition split, unicorn lens | no — advises scope | ADR updates, roadmap changes, feature proposals |
| `data-architect` | indexes, query plans, migration reversibility at scale | yes (data layer) | new migration, non-trivial query, schema change |
| `ai-architect` | LLM feature governance, model choice, evals | yes (when AI lands) | first AI feature — standby until then |
| `persona-fleet-ops` | end-user voice (María, ops director using FleetManager v2.1 in prod) | concern-only (user voice) | any user-facing feature before merge |

## Phase 2 roster (queued, activate when project pulls)

- `investor-advisor` — quarterly metrics, fundraising-readiness, governance
- `legal-compliance` — GDPR / AGPL / SOC2 / enterprise-customer contracts
- `persona-driver` — driver perspective (mobile, quick check-out flows)
- `persona-it-admin` — provisioning, OIDC, SCIM integration perspective

## Invocation

```ts
// Reactive (self-review before push)
Agent({ subagent_type: "tech-lead", prompt: "review commit <hash>" })

// Periodic (quarterly)
Agent({ subagent_type: "investor-advisor", prompt: "Q2 2026 governance review" })

// On-demand
Agent({ subagent_type: "persona-fleet-ops", prompt: "review /reservations/calendar UX" })
```

Agents are read-only by convention — their job is to review + surface.
They don't write code. If an agent wants a change made, it returns the
issue; the human (or orchestrator agent) implements.

## Grounding (critical)

Following the PersonaCite finding (arXiv 2601.22288): a persona without
grounding is a confident hallucination machine. Each persona agent
(`persona-fleet-ops` today, more later) has a `Grounding you MUST use
before speaking` block that REQUIRES reading real artefacts (prior
codebases, audit reports, ADRs) before opining. Agents refuse to
respond without that grounding.

## Governance

The agent roster itself gets a quarterly review (driven by
`product-lead` + `investor-advisor` in phase 2). Questions to ask:

- Which agent hasn't surfaced a non-trivial concern in the last
  quarter? Retire or re-scope.
- Which domain has no voice? Add an agent.
- Which agent is becoming rubber-stamp? Rewrite the non-negotiables.

## References

- Anthropic engineering — multi-agent research system (Jun/2024):
  https://www.anthropic.com/engineering/multi-agent-research-system
- Claude Code Agent Teams docs: https://code.claude.com/docs/en/agent-teams
- AWS Bar Raiser program (the pattern `tech-lead` + `security-reviewer`
  copy): https://aws.amazon.com/careers/life-at-aws-amazons-bar-raiser-program-hiring-for-long-term-growth-and-innovation/
- Teresa Torres, continuous discovery (product trio lens):
  https://www.producttalk.org/
- PersonaCite — grounding-or-hallucinate (arXiv 2601.22288):
  https://arxiv.org/html/2601.22288v1
