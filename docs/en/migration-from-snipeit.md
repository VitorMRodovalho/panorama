# Migrating from Snipe-IT (and SnipeScheduler-FleetManager)

This guide is the canonical path for moving an existing deployment to Panorama.
It covers both pure Snipe-IT installs and the SnipeScheduler-FleetManager
overlay.

## 0. Decide your strategy

There are three ways in:

1. **Big-bang weekend migration** — freeze writes on Snipe-IT, run the
   migrator, cutover, decommission. Appropriate for < 500 users.
2. **Parallel run with shim** — run Panorama alongside Snipe-IT behind a
   Snipe-IT-compatible API shim (`/api/v1/hardware` etc.), let integrations
   keep calling the old URL while humans move to Panorama. Cutover when
   traffic tapers.
3. **Read-replica initially** — Panorama pulls from Snipe-IT continuously
   for N weeks, writes are still in Snipe-IT; staff get used to Panorama's
   UX, then you flip the write direction.

Most mid-size orgs should pick option 2.

## 1. Prerequisites

- Panorama v0.2 or later (reservations, migrator alpha)
- Snipe-IT v8.0 or later (API v1 with accepted-eula endpoint, multi-company
  flag)
- A Snipe-IT API token with a role that can read **and** write every entity
  you plan to migrate (usually Super Admin)
- For FleetManager overlay: a MySQL dump of the FleetManager database taken
  while no app server was running

## 2. Inventory

Before the first dry-run, take stock of what you have:

```bash
pnpm --filter @panorama/migrator cli inventory \
  --snipeit-url https://snipe.example.com \
  --snipeit-token $SNIPEIT_API_TOKEN \
  --out ./inventory.json
```

`inventory.json` lists every entity count and flags:

- Custom fields with non-portable validators (regex with Snipe-IT-specific flags)
- Users with duplicate emails (case-insensitive)
- Assets with status labels that don't match the bundled defaults
- Multi-company enabled but some users/assets have no company assigned

Fix anything flagged **before** running the actual migrator.

## 3. Dry run

```bash
pnpm --filter @panorama/migrator cli migrate \
  --snipeit-url https://snipe.example.com \
  --snipeit-token $SNIPEIT_API_TOKEN \
  --fleetmanager-dump ./snipescheduler_backup.sql \
  --out ./migrated \
  --dry-run
```

`--dry-run` writes Panorama fixture JSON files without touching any database.
Audit the output:

- Asset / user / reservation counts match expectations
- No entity has `tenantId: null`
- Email addresses are all normalised to lowercase
- Custom fields preserve their values

## 4. Real migration

```bash
pnpm --filter @panorama/migrator cli migrate \
  --snipeit-url https://snipe.example.com \
  --snipeit-token $SNIPEIT_API_TOKEN \
  --fleetmanager-dump ./snipescheduler_backup.sql \
  --out ./migrated

# Then import into a fresh Panorama DB
pnpm --filter @panorama/core-api import-fixtures ./migrated
```

Import runs in a single transaction per entity type. A failure rolls back
without partial writes.

## 5. Compatibility shim

For option 2 (parallel run), enable the shim in core-api config:

```env
COMPAT_SNIPEIT_API_ENABLED=true
COMPAT_SNIPEIT_READ_BACKING=panorama   # or 'snipeit' during cutover
```

The shim translates Snipe-IT's API v1 calls to Panorama native calls. It is a
read/write proxy; each endpoint's parity status lives in
`apps/core-api/src/modules/compat-snipeit/README.md`. Target parity:

- All `GET` endpoints — v0.2
- `POST/PATCH /hardware`, `/users`, `/checkouts`, `/checkins` — v0.3
- Remaining writes — v0.4

## 6. Cutover checklist

- [ ] All integrations now point at Panorama (or at the shim URL)
- [ ] Drivers have been trained on the Panorama UI (at least a screen recording)
- [ ] Fleet Staff have practiced the approval queue in a sandbox tenant
- [ ] Snipe-IT is put in read-only mode (or write-disabled via network ACL)
- [ ] A final delta migrator run captures anything changed during the cutover window
- [ ] Panorama audit log has been inspected for the cutover window
- [ ] Old Snipe-IT backups retained for 90 days before decommission

## 7. What does NOT migrate

- Snipe-IT's stored user password hashes. Panorama uses Argon2id; we will
  force password resets via email link on first login if someone logs in
  with a non-SSO identity.
- Snipe-IT's API tokens (Passport). Re-issue fresh Panorama PATs.
- Spatie backup archives. Panorama's backup story uses Postgres PITR +
  object-store lifecycle rules (see `docs/en/ops-backup.md` once it lands).
- LDAP session cache. Users will re-authenticate once.

## 8. Rollback

If the cutover goes sideways:

1. Flip the DNS back to Snipe-IT (it's still running read-only — flip it writable again)
2. Run `panorama migrate-back` to export any writes that hit Panorama during
   the cutover window into Snipe-IT API calls
3. Keep the Panorama install powered down but intact for post-mortem

This rollback path is drill-tested as part of the 1.0 release criteria.
