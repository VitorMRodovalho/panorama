# Roadmap

Target versions and tenant-visible milestones. Living document — last updated 2026-04-17.

## 0.1 — Scaffold (target: end of May 2026)

- [ ] Monorepo green: pnpm + Turborepo, CI on every PR
- [ ] Core-api: Prisma schema for Tenant, User, AuthIdentity, Group, Asset,
      AssetModel, Category, Manufacturer, Supplier, Location, StatusLabel,
      CustomField, CustomFieldset
- [ ] Auth: email/password + Google OIDC + Microsoft OIDC
- [ ] Row-level tenancy working end-to-end, RLS tests in place
- [ ] Web app: login → list assets → open asset detail
- [ ] i18n: EN + PT-BR + ES bundles for the auth and assets modules
- [ ] Docker Compose dev stack

## 0.2 — Reservations (target: July 2026)

- [ ] Reservation model, approval workflow, blackouts, basket booking
- [ ] Check out / check in primitives
- [ ] Training-expiry gating
- [ ] Snipe-IT API compatibility shim read-only
- [ ] `panorama migrate-from-snipeit` — ALPHA (users + assets only)

## 0.3 — Inspections + maintenance (target: Sept 2026)

- [ ] Configurable checklists (per asset type), photo evidence, EXIF strip
- [ ] Asset maintenances, Snipe-IT-compatible maintenance flow
- [ ] Mileage + time-based alerts
- [ ] CSV exports for every list view

## 0.4 — Notifications + reports + webhooks (target: Nov 2026)

- [ ] Event bus (NATS), outbox pattern, delivery retries
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
