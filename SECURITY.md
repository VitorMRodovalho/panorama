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
   see company B's vehicles. Enforced at query layer via Prisma middleware.
2. **CSRF on state changes** — session cookies are SameSite=Lax and every POST
   requires a token.
3. **SSRF on proxy endpoints** — any outbound fetch whose target is derived
   from user input goes through an allowlist + redirect-disabled fetcher.
4. **Supply chain** — dependency updates are gated by `renovate` + SCA scanning
   in CI (trivy, osv-scanner).
5. **Data at rest** — we do not implement file-level encryption; documented
   expectation is encrypted volumes (EBS, LUKS, managed-Postgres encryption).

See `docs/en/threat-model.md` for the full write-up once the initial version
lands.
