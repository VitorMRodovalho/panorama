# Security Policy

## Supported versions

Panorama is pre-alpha. Once we ship 1.0, the supported-versions matrix will live here.

## Reporting a vulnerability

The preferred path is GitHub's **Private Vulnerability Reporting**:
<https://github.com/VitorMRodovalho/panorama/security/advisories/new>.

Alternatively, email **security@vitormr.dev** (temporary contact until the
project moves under a dedicated organisation and domain). Include:

- Affected version / commit hash
- Reproduction steps or proof of concept
- Impact classification in your opinion (CVSS if you have it)
- Disclosure timeline you'd like us to follow

We aim to:

- Acknowledge receipt within **48 hours**
- Provide an initial assessment within **5 business days**
- Ship a fix for critical findings within **14 days** (longer for non-critical)
- Publish a security advisory when we release the patch

Do not open a public issue or pull request for vulnerabilities. We will credit
reporters in the advisory unless you ask otherwise.

## Hardening defaults

Panorama ships with sane defaults (see `apps/core-api/src/config/security.ts`):

- Secure/HttpOnly/SameSite=Lax session cookies, with `Secure` enforced when the
  deployment has `NODE_ENV=production`
- CSRF tokens rotated per session, with double-submit support for APIs
  _(NOTE: audit-flagged as not yet implemented — see issue [#34](https://github.com/VitorMRodovalho/panorama/issues/34))_
- HSTS + CSP + X-Content-Type-Options + Referrer-Policy set via middleware
- Argon2id password hashing (with bcrypt fallback for Snipe-IT migrations)
- OIDC logins refused unless the IdP asserts `email_verified=true`.
  A narrow exception trusts the Google Workspace `hd` (hosted domain)
  claim when (a) the domain is listed in `OIDC_GOOGLE_TRUSTED_HD_DOMAINS`,
  (b) the token's `iss` is the actual Google issuer, and (c) the email
  ends with `@<hd>` — Workspace admin verification stands in for the
  per-account flag. Under the `hd` override, linking a Google identity
  to a pre-existing local account at the same email is also refused;
  the override proves domain ownership, not control of an existing
  account. Microsoft Entra has no equivalent claim; deployments must
  enforce email verification on the IdP side. Refusals are recorded as
  `panorama.auth.oidc_refused` audit events with the structured reason
  (`email_not_verified` / `hd_not_allowlisted` / `hd_iss_mismatch` /
  `hd_email_mismatch` / `oidc_account_link_requires_verified_email`).
  **On-call runbook for a Workspace tenant locked out at pilot
  launch:** add their domain to `OIDC_GOOGLE_TRUSTED_HD_DOMAINS`
  (comma-separated, lowercase) and roll the deployment. There is no
  knob to disable the gate entirely — that is intentional.
- All outbound fetches disable follow-redirects unless the caller opts in
- Rate limiting on auth endpoints (configurable per-tenant)
- Audit log appended to every write operation (tamper-evident hash chain)
  _(NOTE: audit-flagged that the notification tamper trigger breaks the chain —
  see issue [#41](https://github.com/VitorMRodovalho/panorama/issues/41))_

## Audit trail

Three QA/QC audit waves were completed on 2026-04-23. Findings with security
implications are filed under [`type: security`](https://github.com/VitorMRodovalho/panorama/issues?q=is%3Aissue+label%3A%22type%3A+security%22)
and organised by wave under [`audit:wave-1`](https://github.com/VitorMRodovalho/panorama/issues?q=is%3Aissue+label%3Aaudit%3Awave-1) /
[`audit:wave-2`](https://github.com/VitorMRodovalho/panorama/issues?q=is%3Aissue+label%3Aaudit%3Awave-2) /
[`audit:wave-3`](https://github.com/VitorMRodovalho/panorama/issues?q=is%3Aissue+label%3Aaudit%3Awave-3).
See [`docs/audits/HANDOFF-2026-04-23.md`](./docs/audits/HANDOFF-2026-04-23.md) for
the master entry point. ADR-0017 (Draft) at
[`docs/adr/0017-ai-llm-integration-principles.md`](./docs/adr/0017-ai-llm-integration-principles.md)
establishes governance for future AI/LLM integrations, drafted in response to the
2026-04-20 MCP CVE family.

## Threat model summary

Primary threats we defend against:

1. **Authenticated-user lateral movement** — a driver in company A trying to
   see company B's vehicles. Enforced at the query layer via Prisma middleware
   AND at the Postgres layer via row-level security (RLS) policies that read a
   per-transaction GUC. See [`docs/adr/0003-multi-tenancy.md`](./docs/adr/0003-multi-tenancy.md).
2. **CSRF on state changes** — session cookies are SameSite=Lax and every POST
   requires a token.
3. **SSRF on proxy endpoints** — any outbound fetch whose target is derived
   from user input goes through an allowlist + redirect-disabled fetcher.
   The object-storage `S3_ENDPOINT` is DNS-resolved at boot and rejected if
   any A/AAAA answer hits a private/metadata range.
4. **Supply chain** — dependency updates are gated by Dependabot + SCA scanning
   in CI (Trivy). Contributor workstations using AI coding tools with MCP servers
   are covered by [`docs/runbooks/dev-environment-ai-tooling.md`](./docs/runbooks/dev-environment-ai-tooling.md)
   (allowlist, forbidden patterns, incident response — added in response to the
   2026-04-20 MCP CVE family).
5. **Data at rest** — we do not implement file-level encryption; documented
   expectation is encrypted volumes (EBS, LUKS, managed-Postgres encryption,
   S3/R2 SSE-AES256).

See `docs/en/threat-model.md` for the full write-up once the initial version
lands.

## Out of scope

The following are explicitly out of scope for the vulnerability-reporting
pipeline. We will close reports against these without triage:

- **Denial-of-service via resource exhaustion against a self-hosted
  instance.** Self-hosters are responsible for rate-limit / WAF / firewall
  sizing; the ADR-0008 fail-closed limiter is a guardrail, not a substitute
  for ingress protection.
- **Social engineering, phishing, or physical-access attacks** against
  Panorama maintainers, contributors, or users.
- **Third-party platform vulnerabilities** — Cloudflare, Supabase, Fly.io,
  Upstash, AWS, GCP, Azure, etc. Report those to the platform owner. We
  ship a coordinated patch only when the platform's fix lands and we need
  to adapt our integration.
- **Issues requiring an attacker to already hold valid administrator
  credentials** for the target tenant (e.g. a tenant-admin running malicious
  SQL via a future custom-report builder). The "post-auth admin can do bad
  things" model is documented; we treat post-auth-admin compromise as
  customer-side.
- **Bugs in unmerged feature branches.** We patch what's on `main` and the
  most recent tagged release.

## CVE issuance

For findings we accept and patch, we file a CVE under the GitHub Security
Advisories pipeline (CNA: GitHub). The advisory ID + CVE number land in the
release notes alongside the patch. We do not issue CVEs for findings deemed
out-of-scope above.

## Bug-bounty status

**No monetary reward at this time** — Panorama is pre-1.0 and pre-revenue.
Reporters who follow the disclosure timeline above are credited by name in
the published advisory unless they request anonymity. A formal bounty
programme will land when Panorama Cloud (managed SKU) reaches paying
customers, scoped to the managed surface only.

## AGPL self-hosters

If you operate a self-hosted Panorama instance, the AGPL responsibility for
deployment hardening (ingress TLS, secret rotation, OS-level updates, backup
strategy, network segmentation) is on you. The reference deployment we
maintain is documented in [`docs/en/self-hosting.md`](./docs/en/self-hosting.md);
`docs/en/threat-model.md` will list the assumptions our defaults make about
the surrounding network. We will not accept reports of "the default config
is insecure when exposed naked to the internet" — the defaults assume an
ingress with TLS termination + WAF in front. If you discover a default that
is insecure even **with** a hardened ingress, that IS in scope.
