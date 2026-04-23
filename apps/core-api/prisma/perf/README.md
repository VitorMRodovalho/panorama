# Query-performance baselines

Ad-hoc performance artifacts the team can run against a local or staging Postgres to profile the hottest query paths. Origin: Wave 2c audit (`docs/audits/2026-04-23-wave-2.md`).

## Files

- `baseline.sql` — seeds a synthetic tenant (200 assets, 10k reservations, 5k inspections, 2k notifications, 500 invitations) and runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)` on 10 hot queries. Idempotent — skips seeding if the perf tenant already exists.
- `pg-stat-statements.sql` — optional scheduled detection query. Surfaces queries exceeding latency/frequency/fan-out thresholds. Requires `pg_stat_statements` extension + `shared_preload_libraries` config.

## Usage

```bash
# One-off baseline run
psql -U panorama -d panorama \
  -f apps/core-api/prisma/perf/baseline.sql \
  -o apps/core-api/prisma/perf/baseline-$(date +%Y%m%d-%H%M%S).txt

# Commit the output file — reviewers diff regressions by comparing
# successive baseline-*.txt captures.
```

## When to re-run

- Before merging a migration that adds/removes an index
- Before merging a service change that alters a hot-path query shape
- Weekly against staging (cron), posting the diff to a maintainer Slack channel
- Ad-hoc when latency regression is suspected

## Adding a query

Append a new `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)` block to `baseline.sql`. Include a one-line comment describing:

1. Where in the code the query lives (`file.ts:Lnn`)
2. Which queries trigger it (user action → call path)
3. Which indexes should be used

## Relationship to the main test suite

This is **not** a CI artifact. It's a maintainer tool. The CI test job at `ci.yml` already runs integration tests; a separate perf-CI job with seeded fixtures is a candidate for Wave 3 but not scoped here.
