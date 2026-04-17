# Features from Snipe-IT / FleetManager that we won't port (at least not to 1.0)

This is a living list. Each entry should say **why** we're dropping it. If a
compelling argument surfaces, we reconsider.

## From Snipe-IT

| Feature | Why we drop it | Potential revisit |
|---------|----------------|-------------------|
| Livewire-based admin UI | Replaced by Next.js admin. Livewire is Laravel-specific and we're not on Laravel. | Never — new stack |
| Spatie file-system backups | Replaced by Postgres PITR + object-store lifecycle rules + periodic logical dumps. Covers the same RPO/RTO with less app-layer code. | Never |
| TCPDF + Snappy PDF renderer | Replaced by server-side SVG + browserless-Chromium for PDF. Cleaner i18n, better fonts. | Never |
| Legacy CSV importers per entity | Replaced by a single unified importer with dry-run and idempotency. | Never |
| phpMyAdmin / dashboard admin links | Not applicable to NestJS stack | Never |
| `database/seeders` fixtures with made-up user data | Replaced by `faker` + `@faker-js/faker` + deterministic seeds | Never |

## From SnipeScheduler-FleetManager

| Feature | Why we drop it | Potential revisit |
|---------|----------------|-------------------|
| CRC32 user ID hashing | Replaced by UUIDv7. Collisions impossible; index-friendly. | Never |
| Dual booking-flow (basket + individual) | Consolidated to a single reservation model with a "cart" UX; same outcomes, half the code | Never |
| In-process email queue via CRON | Replaced by BullMQ + Redis. Sub-second delivery, proper retries. | Never |
| Apache + .htaccess guards | Nest + Helm + ingress annotations cover the same | Never |
| `scripts/release.php` bump-and-commit helper | Replaced by Changesets + turbo + CI. | Never |
| `scripts/security_scan.py` + `security_remediate.py` | Replaced by CodeQL + SonarCloud + trivy in CI | Never |
| "Announcements" system-wide banner | Unless a user asks for it; lightweight enough to ship as a plugin first | v1.2 if requested |

## From either that we might keep as Enterprise

| Feature | Reason | Where |
|---------|--------|-------|
| SAML attribute mapping from LDAP groups | Niche, complex, enterprise-procurement driven | Enterprise |
| Hard delete vs soft delete toggle (GDPR) | Sensitive defaults + audit requirements | Community has soft delete; Enterprise adds regulated hard-delete with evidence |
| Export-to-CSV for activity log | Community has CSV; Enterprise adds streaming-to-SIEM | Both |

## How to propose adding to this list

Open a PR touching this file, citing:

1. The feature and its origin (Snipe-IT / FleetManager / both)
2. Why it doesn't fit the modern stack or doesn't earn its maintenance cost
3. What we're doing instead (link to the equivalent Panorama feature or plugin)

Maintainer review: +1 from a core maintainer merges.
