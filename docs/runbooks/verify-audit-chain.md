# Runbook — Verify audit-event hash chain (per-row reproducibility)

## What this checks

Every row in `audit_events` carries a `selfHash` =
`sha256(prevHash || canonical_pre_image)`. Migration 0021 added the
`digestPreImage` column so a verifier can recompute the digest
byte-for-byte without needing to reconstruct the canonical pre-image
from JSONB columns (which Postgres recanonicalises on store).

`pnpm chain-verify` is the operational check. It connects via
`DATABASE_PRIVILEGED_URL`, takes the BYPASSRLS path inside a single
transaction (so the GUC stays in scope for the read), and verifies
each row:

- If `digestPreImage IS NOT NULL`: asserts
  `sha256(COALESCE(prevHash, '') || digestPreImage) == selfHash`.
  Mismatch = tamper signal.
- If `digestPreImage IS NULL`: row is reported as "legacy
  (unverifiable)" — pre-0021 rows + rows written during a 0021
  rollback window. Counted but neither pass nor fail.

## Scope — what this verifier DOES NOT check

- **Multi-strand prev-link integrity.** The chain is intentionally
  multi-strand under the SECURITY DEFINER trigger + `runInTenant`
  RLS contracts (see `audit.service.ts` docstring). Trigger writes
  link into the global chain regardless of the row's `tenantId`,
  so a per-tenant verifier walk would report false mismatches on
  cross-tenant adjacency. Per-row reproducibility is the trust
  anchor we ship in Round 2B; multi-strand prev-link verification
  is a separate workstream.
- **`ipAddress` / `userAgent` tamper.** Those columns are stored
  but NOT included in the canonical pre-image (they are
  observational metadata about the actor, not part of the audit
  row's logical identity). Editing them post-write goes undetected
  by this CLI.
- **Row deletion.** An attacker who DELETEs the latest row leaves
  no fork — the next row's prevHash points to a row that's gone,
  but the verifier processes each row in isolation. Detection of
  missing rows requires the prev-link walk this CLI doesn't do.

## When to run

- **Quarterly** as a scheduled drill. Capture output under
  `docs/audits/chain-verify-<date>/`.
- **After any restore** from backup. The restored DB must verify
  (zero digest mismatches) before traffic resumes.
- **After a suspected tamper.** The "what changed" answer is in
  the first mismatch's `id` + `action` — start the investigation
  there.
- **As a smoke check** after a deploy that touches
  `audit.service.ts`, migration files under `prisma/migrations/`,
  or any of the SECURITY DEFINER trigger functions in migrations
  0011 / 0015 / 0020 / 0021.

## How to run

```bash
# Human-readable summary on stdout, exit 0/1/2.
pnpm --filter @panorama/core-api chain-verify

# Machine-readable JSON for runbook tooling / CI.
pnpm --filter @panorama/core-api chain-verify --json
```

The CLI requires `DATABASE_PRIVILEGED_URL` in the environment. The
value is enumerated under §Postgres in
[`docs/runbooks/secrets-inventory.md`](./secrets-inventory.md). On
staging / prod, source the appropriate `.env`:

```bash
set -a; source apps/core-api/.env.staging; set +a
pnpm --filter @panorama/core-api chain-verify
```

## Reading the output

PASS shape:

```
audit chain verification — PASS
generated:               2026-05-16T18:30:00.000Z
total rows:              1284
verified:                1237
legacy (pre-0021, NULL): 47
digest mismatches:       0
```

FAIL shape:

```
audit chain verification — FAIL
total rows:              1284
verified:                1236
legacy (pre-0021, NULL): 47
digest mismatches:       1

first mismatch:
  id:       905
  tenantId: 9f6e...c10a
  action:   panorama.invitation.accepted
  detail:   selfHash = 0a3b..., recomputed = 9f2c...
```

## What a digest mismatch means

A row's stored `selfHash` does not equal the sha256 of its
`prevHash || digestPreImage`. Possible causes:

1. **Tamper.** Someone edited a column AFTER the row was written.
   The `digestPreImage` was committed with the original values, so
   the recomputed digest still matches the *original* logical
   state. If the row's other columns disagree with the pre-image,
   that's the smoking gun. Compare `metadata` JSONB against
   `digestPreImage`'s parsed JSON to see which field drifted.
2. **Bug in the writer.** A future code change miscomputed the
   digest or mismatched the canonical JSON shape. Diff
   `audit.service.ts:recordWithin` against the trigger functions in
   migration 0021 — both must hash the same canonical shape.

## What an empty-result exit-2 means

The CLI exits 2 with a stderr message if `audit_events` is empty,
because we cannot distinguish:

- A fresh DB before migrations have applied (no cutover markers
  yet)
- RLS silently filtered every row to zero (the bug the
  `$transaction`-wrapped BYPASS path guards against, but if a
  future regression re-introduces it, this exit-2 catches it)
- Someone truncated `audit_events` (itself a chain-integrity
  failure)

Investigate: check `\dt audit_events`, run a manual
`SELECT count(*) FROM audit_events`, verify the role's BYPASSRLS
posture on the target DB.

## What to do on FAIL

1. **Do not delete or repair audit rows.** Append-only is the
   property under audit; "fixing" the chain by editing a row would
   itself be evidence destruction.
2. Take a snapshot of the audit_events table (`pg_dump --table`)
   and store it in the incident folder.
3. Trace the first failure's `id` + `action` + `tenantId` back
   through application logs. The audit row records what the
   application *intended* to record; logs show what the application
   *saw at the time*. Divergence is the tamper signal.
4. Open a security incident per
   `docs/runbooks/incident.md` (when that runbook lands per Round
   6).

## Known legacy

The "legacy" count reflects rows whose `digestPreImage` is NULL.
These are rows written before migration 0021 (which adds the
column) OR rows written during a 0021 rollback window. They cannot
be byte-exact verified from the columns alone but they are not
tamper signals — they just predate the column.

The chain-repair markers emitted at migration apply time
(`action = 'panorama.audit.chain_repair'`, with
`metadata.migration` identifying which one) are themselves
verifiable from migration 0021 onward.

## See also

- `apps/core-api/src/modules/audit/audit.service.ts` — the writer
- `apps/core-api/src/scripts/verify-audit-chain.ts` — the verifier
- `apps/core-api/prisma/migrations/20260516180117_0021_audit_digest_preimage_chain_lock/migration.sql`
- `apps/core-api/test/audit-chain-integrity.e2e.test.ts` +
  `apps/core-api/test/migration-0021-audit-chain.test.ts` — the
  test-time invariants the CLI mirrors at runtime
- `docs/adr/0014-public-hosted-instance.md` — the public claim the
  chain underwrites
