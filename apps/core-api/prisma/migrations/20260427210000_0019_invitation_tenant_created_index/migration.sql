-- Migration 0019 — Invitation list (tenantId, createdAt DESC) index
-- (closes #64 PERF-07; pairs with the service-side filter push in
-- the same PR).
--
-- AdminInvitationsPage's `InvitationService.list()` orders by
-- `createdAt DESC` scoped to a single tenant. Pre-this-index the
-- planner used `(tenantId, email)` for the filter then ran a Sort
-- on the full tenant partition to find the top-N. At 100k
-- invitations per tenant that's a full scan of the partition's
-- email-clustered range to discard everything but the top-100,
-- per page.
--
-- The DESC sort key here matches the `ORDER BY createdAt DESC`
-- direction natively: the index leaf pages are already in DESC
-- order, so the planner reads them forward and stops at LIMIT —
-- O(N) → O(LIMIT). No `Sort` node, no `Backward Index Scan` in
-- the EXPLAIN output. (A plain ASC index would also work for the
-- descending walk via reverse scan, but DESC keeps the EXPLAIN
-- plan readable to anyone debugging it.)
--
-- Partial-index alternative considered + rejected: a partial
-- `WHERE acceptedAt IS NULL AND revokedAt IS NULL` would cut
-- size ~50%, but it can't serve `status='all'` (the admin
-- default) or `status='accepted'` (the audit slice). Covering
-- the workload would need TWO indexes instead of one — net
-- storage worse, not better. Re-evaluate only if `status=open`
-- becomes overwhelmingly dominant and the size matters.
--
-- The status filter (open / accepted / revoked / expired) was
-- previously evaluated client-side after the fetch. The companion
-- service change in this PR pushes it to the WHERE clause via
-- column derivation:
--   open     → acceptedAt IS NULL AND revokedAt IS NULL AND expiresAt > now()
--   accepted → acceptedAt IS NOT NULL
--   revoked  → acceptedAt IS NULL AND revokedAt IS NOT NULL
--   expired  → acceptedAt IS NULL AND revokedAt IS NULL AND expiresAt <= now()
--
-- The added (tenantId, createdAt DESC) index serves the unfiltered
-- `status='all'` path; status-filtered paths still benefit because
-- the planner uses it for the ORDER BY + LIMIT and applies the
-- nullability filters as a Filter step after Index Scan.

CREATE INDEX "invitations_tenantId_createdAt_idx"
    ON "invitations" ("tenantId", "createdAt" DESC);

COMMENT ON INDEX "invitations_tenantId_createdAt_idx" IS
    '#64 PERF-07 — supports admin invitation list ORDER BY '
    'createdAt DESC LIMIT N. DESC index direction matches ORDER BY '
    'natively so EXPLAIN shows a forward Index Scan that stops at '
    'LIMIT, not a Sort.';
