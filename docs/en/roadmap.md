# Roadmap

Target versions and tenant-visible milestones. Living document — last updated 2026-04-18.

## 0.1 — Scaffold (shipped 2026-04-17)

- [x] Monorepo green: pnpm + Turborepo, CI on every PR
- [x] Core-api: Prisma schema for Tenant, User, AuthIdentity, Category,
      Manufacturer, AssetModel, Asset, Reservation, AuditEvent,
      SystemSetting (schemas for Group / Supplier / Location /
      StatusLabel / CustomField / CustomFieldset deferred to 0.3 where
      they're actually consumed)
- [x] Row-level tenancy end-to-end: Prisma middleware + Postgres RLS,
      17 integration tests green
- [x] Docker Compose dev stack (Postgres 16 + Redis + MinIO + MailHog)
- [x] i18n coverage gate wired in CI (EN/PT-BR/ES must stay in sync)

## 0.2 — Auth, import, web login (in progress; target Jun 2026)

- [x] **Step 1** — migrator ↔ core-api fixture loop closed
      (canonical fixtures, `ImportIdentityMap`, 6 round-trip tests)
- [x] **Step 2** — AuthModule: password + Google OIDC + Microsoft OIDC,
      iron-session cookies, home-realm discovery, multi-tenant
      switching, 26 tests green
- [x] **Step 3a** — ADRs for Tenant Owner ([0007](../adr/0007-tenant-owner-role.md))
      and Invitation flow ([0008](../adr/0008-invitation-flow.md))
- [x] **Step 3b** — web login + /assets list in `apps/web` (Next.js 14
      App Router). No invitation UI yet; users seeded via super-admin.
- [x] **Step 3c** — Invitation flow per ADR-0008: `Invitation` table,
      email token + TTL + one-time-use + partial unique index, BullMQ
      email worker + hourly maintenance cron, `/invitations/*`
      endpoints, acceptance web page, trilingual templates (EN / PT-BR
      / ES), Redis-backed rate limits that fail CLOSED, and full audit
      trail (`panorama.invitation.*`).
- [x] **Step 3d** — Tenant Owner enforcement per ADR-0007: Postgres
      trigger `enforce_at_least_one_owner`, `TenantAdminService` with
      create-with-owner + promote/demote/suspend/delete guards,
      admin `PATCH/DELETE /tenants/:id/memberships/:mid`, single-Owner
      warning banner on `/assets`, and the super-admin
      `tenant-nominate-owner` break-glass CLI.
- [~] **Step 4** — Reservation model, approval workflow, blackouts
      (ADR-0009).
      - Part A **shipped**: migration 0006 extensions + blackout_slots
        table + per-tenant `reservationRules` JSON; ReservationService
        with conflict detection, blackout check, min-notice /
        max-duration / max-concurrent rules, auto-approve by role;
        `/reservations/*` + `/blackouts/*` endpoints; web `/reservations`
        list + new form with admin approve/reject buttons.
      - Part B pending: check-out / check-in with mileage / condition /
        damage capture; basket multi-asset reservations; calendar view.
- [ ] **Step 5** — Snipe-IT API compatibility shim read-only

## 0.3 — Inspections, maintenance, enterprise prep (target Aug 2026)

- [ ] Configurable checklists (per asset type), photo evidence, EXIF strip
- [ ] Asset maintenances, Snipe-IT-compatible maintenance flow
- [ ] Mileage + time-based alerts
- [ ] CSV exports for every list view
- [ ] Training-expiry gating
- [ ] Email bounce webhook (SES/SendGrid) → invitation state update
- [ ] Just-in-time tenant membership based on `allowedEmailDomains` match
      at first OIDC login (gates the enterprise SCIM story)

## 0.3 — Inspections + maintenance (target: Sept 2026)

- [ ] Configurable checklists (per asset type), photo evidence, EXIF strip
- [ ] Asset maintenances, Snipe-IT-compatible maintenance flow
- [ ] Mileage + time-based alerts
- [ ] CSV exports for every list view

## 0.4 — Notifications + reports + webhooks (target Oct 2026)

- [ ] Event bus (NATS JetStream), outbox pattern, delivery retries
- [ ] Email, Teams, Slack, webhook channels
- [ ] Saved reports, schedule to email, CSV/XLSX/PDF render
- [ ] First closed-beta customer live
- [ ] `panorama-enterprise` private repo spun up; white-label + SOC-2 pack start

## 1.0 GA (target: Q1 2027)

- [ ] SAML / LDAP / SCIM 2.0 provisioning
- [ ] WebAuthn passkeys
- [ ] Barcode/label designer (SVG templates)
- [ ] Plugin SDK public, first 2 plugins shipped (Fleetio + PagerDuty)
- [ ] `panorama migrate-from-snipeit` — GA (full; compat shim can be turned off)
- [ ] Trilingual UI complete (EN/PT-BR/ES) with framework for additional locales
- [ ] Docs site live, threat model published, SOC-2 Type I in progress

## 1.1+ (2027+)

- Mobile app (Expo) GA
- Search via OpenSearch
- Offline-first inspections on mobile
- Predictive maintenance (Enterprise only)
- More IdP connectors (Enterprise)

## How we say no

Not every feature in Snipe-IT or FleetManager will come across. A feature
is dropped from the roadmap if it meets **any** of:

- Used by fewer than 5% of tracked Snipe-IT installs (from public anonymised telemetry)
- Has a better analogue in the modern stack (e.g., Spatie backups → native Postgres PITR + object-store lifecycle rules)
- Creates an ops burden out of proportion to its value (e.g., legacy LDAP binding without StartTLS)

Dropped features are tracked in [`docs/en/dropped-features.md`](./dropped-features.md).
