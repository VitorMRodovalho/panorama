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
- HSTS + CSP + X-Content-Type-Options + Referrer-Policy set via middleware
- Argon2id password hashing (with bcrypt fallback for Snipe-IT migrations)
- All outbound fetches disable follow-redirects unless the caller opts in
- Rate limiting on auth endpoints (configurable per-tenant)
- Audit log appended to every write operation (tamper-evident hash chain)

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
4. **Supply chain** — dependency updates are gated by `renovate` + SCA scanning
   in CI (trivy, osv-scanner).
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
