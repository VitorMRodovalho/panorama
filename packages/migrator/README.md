# @panorama/migrator

CLI that reads an existing **Snipe-IT** install (via its API) and,
optionally, a **SnipeScheduler-FleetManager** MySQL dump, and produces
Panorama fixtures ready for import.

Designed for three migration strategies documented in
[`docs/en/migration-from-snipeit.md`](../../docs/en/migration-from-snipeit.md):

1. Big-bang cutover (freeze Snipe-IT → migrate → swap)
2. Parallel run behind a Snipe-IT-compatible API shim
3. Read-replica while humans transition

The CLI is deliberately **idempotent, dry-run-first, and non-destructive to
Snipe-IT** — it only reads.

## Commands

### `inventory`

Count every entity in the source Snipe-IT install and flag migration risks.

```bash
pnpm --filter @panorama/migrator cli inventory \
  --snipeit-url https://snipe.example.com \
  --snipeit-token $SNIPEIT_API_TOKEN \
  --out ./inventory.json
```

Output includes:
- Counts for hardware, users, licenses, accessories, consumables,
  components, maintenances, categories, manufacturers, locations, companies
- Users with duplicate emails (case-insensitive) — fix before migration
- Assets with status labels that don't match Panorama's bundled defaults
- Multi-company flag + any rows with NULL company when the flag is on

### `migrate`

Read Snipe-IT (+ optional FleetManager dump) and write Panorama fixture
JSON files.

```bash
pnpm --filter @panorama/migrator cli migrate \
  --snipeit-url https://snipe.example.com \
  --snipeit-token $SNIPEIT_API_TOKEN \
  --fleetmanager-dump ./snipescheduler_backup.sql \
  --out ./migrated \
  --dry-run
```

`--dry-run` writes Panorama fixture JSON (per entity, one file per type)
and prints a summary diff. Drop the flag to enable real imports (requires
a Panorama install URL — deferred to 0.2).

## Development status

**0.0 skeleton** (this scaffold):
- ✅ CLI entry point, command wiring, structured logging
- ✅ `SnipeItClient` with retry + pagination + token auth
- ✅ `inventory` command that hits a real Snipe-IT and prints counts
- 🚧 `migrate` command — writes minimal fixtures (users + assets) in JSON
- 🚧 SnipeScheduler-FleetManager MySQL dump reader — stub only
- 🚧 Panorama fixture format — subject to change until core-api 0.2 ships

Roadmap shape is in `docs/en/roadmap.md`:
- 0.2 — alpha: users, assets, companies
- 0.3 — beta: custom fields, reservations, maintenances
- 0.4 — GA: full Snipe-IT + FleetManager round-trip with rollback path

## Safety rails

- Never writes to the Snipe-IT source (read-only API client)
- Never runs Panorama imports directly — outputs fixtures for a separate
  `panorama import-fixtures` command in `@panorama/core-api`
- Refuses to run against a DATABASE_URL that looks like production unless
  `ALLOW_DESTRUCTIVE_SEED=true` is set (belt-and-braces)

## Testing

```bash
pnpm --filter @panorama/migrator test
```

Unit tests mock the Snipe-IT HTTP client. Integration tests require a real
Snipe-IT; they're tagged `@integration` and skipped unless
`SNIPEIT_URL` + `SNIPEIT_TOKEN` are set in env.
