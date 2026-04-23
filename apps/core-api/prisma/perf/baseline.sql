-- =============================================================================
-- Panorama query-performance baseline
-- =============================================================================
-- Origin: Wave 2c audit, committed 2026-04-23. See docs/audits/2026-04-23-wave-2.md.
--
-- Usage:
--   1. Seed a local DB:  npx prisma migrate deploy && npx prisma db seed
--   2. Run:              psql -U panorama -d panorama \
--                          -f apps/core-api/prisma/perf/baseline.sql \
--                          -o apps/core-api/prisma/perf/baseline-$(date +%Y%m%d-%H%M%S).txt
--   3. Commit the output file so reviewers can diff regressions.
--
-- The seed block below is idempotent (skips if the perf tenant already exists).
-- It creates 200 assets, 10k reservations, 5k inspections, 2k notifications,
-- and 500 invitations under a single tenant — enough cardinality to make
-- index choice meaningful without needing hours of warmup.
-- =============================================================================

\timing on

-- ============ SEED SYNTHETIC DATA (idempotent) ============

DO $$
DECLARE
  _tenant_id   UUID := '00000000-0000-0000-0000-000000000001';
  _user_id     UUID := '00000000-0000-0000-0000-000000000010';
  _asset_ids   UUID[];
  _i           INT;
  _asset_id    UUID;
  _start       TIMESTAMP;
  _end         TIMESTAMP;
BEGIN
  IF EXISTS (SELECT 1 FROM tenants WHERE id = _tenant_id) THEN
    RAISE NOTICE 'Perf seed data already present, skipping generation';
    RETURN;
  END IF;

  INSERT INTO tenants (id, slug, name, "displayName", "systemActorUserId",
    "reservationRules", "createdAt", "updatedAt")
  VALUES (_tenant_id, 'perf-test', 'Perf Test', 'Perf Test Tenant',
    '00000000-0000-0000-0000-000000000099',
    '{"min_notice_hours":0,"max_duration_hours":0,"max_concurrent_per_user":0,"auto_approve_roles":["owner"]}',
    now(), now());

  INSERT INTO users (id, email, "displayName", status, "createdAt", "updatedAt")
  VALUES ('00000000-0000-0000-0000-000000000099',
    'system+perf@panorama.invalid', 'Perf System', 'ACTIVE', now(), now());

  INSERT INTO users (id, email, "displayName", status, "createdAt", "updatedAt")
  VALUES (_user_id, 'driver-perf@test.com', 'Perf Driver', 'ACTIVE', now(), now());

  INSERT INTO tenant_memberships (id, "tenantId", "userId", role, status, "createdAt", "updatedAt")
  VALUES (gen_random_uuid(), _tenant_id, _user_id, 'driver', 'active', now(), now());

  INSERT INTO categories (id, "tenantId", name, kind, "createdAt", "updatedAt")
  VALUES ('00000000-0000-0000-0000-000000000020', _tenant_id, 'Trucks', 'VEHICLE', now(), now());

  INSERT INTO asset_models (id, "tenantId", "categoryId", name, "createdAt", "updatedAt")
  VALUES ('00000000-0000-0000-0000-000000000030', _tenant_id,
    '00000000-0000-0000-0000-000000000020', 'F-150', now(), now());

  FOR _i IN 1..200 LOOP
    _asset_id := gen_random_uuid();
    _asset_ids := _asset_ids || _asset_id;
    INSERT INTO assets (id, "tenantId", "modelId", tag, name, status, bookable, "createdAt", "updatedAt")
    VALUES (_asset_id, _tenant_id, '00000000-0000-0000-0000-000000000030',
      'TRUCK-' || lpad(_i::text, 4, '0'), 'Truck #' || _i, 'READY', true, now(), now());
  END LOOP;

  FOR _i IN 1..10000 LOOP
    _asset_id := _asset_ids[1 + (_i % array_length(_asset_ids, 1))];
    _start := now() - interval '730 days' + (random() * 730 * 24 * 3600 * interval '1 second');
    _end   := _start + (1 + random() * 72) * interval '1 hour';
    INSERT INTO reservations (id, "tenantId", "assetId", "requesterUserId",
      "startAt", "endAt", "approvalStatus", "lifecycleStatus",
      "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), _tenant_id, _asset_id, _user_id,
      _start, _end,
      CASE WHEN random() < 0.7 THEN 'APPROVED' WHEN random() < 0.5 THEN 'AUTO_APPROVED' ELSE 'PENDING_APPROVAL' END::"approval_status",
      CASE WHEN random() < 0.5 THEN 'RETURNED' WHEN random() < 0.3 THEN 'BOOKED' WHEN random() < 0.3 THEN 'CHECKED_OUT' ELSE 'CANCELLED' END::"reservation_status",
      _start - interval '1 day', _start - interval '1 day');
  END LOOP;

  FOR _i IN 1..5000 LOOP
    _asset_id := _asset_ids[1 + (_i % array_length(_asset_ids, 1))];
    INSERT INTO inspections (id, "tenantId", "assetId", "startedByUserId",
      "templateSnapshot", status, outcome,
      "completedAt", "completedByUserId",
      "startedAt", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), _tenant_id, _asset_id, _user_id,
      '{"name":"Pre-trip","description":null,"templateVersionAt":"2026-01-01T00:00:00Z","items":[{"id":"' || gen_random_uuid() || '","position":0,"label":"Tires OK","itemType":"BOOLEAN","required":true,"photoRequired":false,"minValue":null,"maxValue":null,"helpText":null}]}',
      'COMPLETED',
      CASE WHEN random() < 0.8 THEN 'PASS' WHEN random() < 0.5 THEN 'FAIL' ELSE 'NEEDS_MAINTENANCE' END::"inspection_outcome",
      now() - (_i * interval '30 minutes'),
      _user_id,
      now() - (_i * interval '32 minutes'),
      now() - (_i * interval '32 minutes'),
      now() - (_i * interval '30 minutes'));
  END LOOP;

  FOR _i IN 1..2000 LOOP
    INSERT INTO notification_events (id, "tenantId", "eventType", payload,
      status, "availableAt", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), _tenant_id,
      'panorama.reservation.approved',
      '{"reservationId":"00000000-0000-0000-0000-000000000000"}',
      CASE WHEN random() < 0.1 THEN 'PENDING' WHEN random() < 0.05 THEN 'FAILED' ELSE 'DISPATCHED' END::"notification_event_status",
      now() - (_i * interval '1 hour'),
      now() - (_i * interval '1 hour'),
      now() - (_i * interval '1 hour'));
  END LOOP;

  FOR _i IN 1..500 LOOP
    INSERT INTO invitations (id, "tenantId", email, role, "tokenHash",
      "invitedByUserId", "expiresAt", "createdAt", "updatedAt",
      "acceptedAt", "revokedAt")
    VALUES (gen_random_uuid(), _tenant_id,
      'user' || _i || '@example.com', 'driver',
      encode(gen_random_bytes(32), 'base64'),
      _user_id,
      CASE WHEN random() < 0.5 THEN now() + interval '7 days' ELSE now() - interval '1 day' END,
      now() - (_i * interval '2 hours'),
      now() - (_i * interval '2 hours'),
      CASE WHEN random() < 0.3 THEN now() - (_i * interval '1 hour') ELSE NULL END,
      CASE WHEN random() < 0.1 THEN now() - (_i * interval '1 hour') ELSE NULL END);
  END LOOP;

  RAISE NOTICE 'Seeded: 200 assets, 10k reservations, 5k inspections, 2k notifications, 500 invitations';
END $$;

-- ============ SET TENANT CONTEXT ============
SET LOCAL "panorama.current_tenant" = '00000000-0000-0000-0000-000000000001';

-- ============ Q1: Reservation list scope=mine (OR clause) ============
-- Wave 2c PERF-06 — suspects missing index on onBehalfUserId arm.
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM reservations
WHERE "tenantId" = '00000000-0000-0000-0000-000000000001'
  AND ("requesterUserId" = '00000000-0000-0000-0000-000000000010'
       OR "onBehalfUserId" = '00000000-0000-0000-0000-000000000010')
  AND "approvalStatus" IN ('PENDING_APPROVAL','AUTO_APPROVED','APPROVED')
  AND "lifecycleStatus" IN ('BOOKED','CHECKED_OUT')
ORDER BY "startAt" ASC, "createdAt" ASC
LIMIT 50;

-- ============ Q2: Inspection tether check ============
-- Executed on every checkout. Covered by inspections_asset_recent_idx prefix.
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT "id" FROM inspections
WHERE "tenantId" = '00000000-0000-0000-0000-000000000001'
  AND "assetId" = (SELECT id FROM assets WHERE "tenantId" = '00000000-0000-0000-0000-000000000001' LIMIT 1)
  AND "startedByUserId" = '00000000-0000-0000-0000-000000000010'
  AND "status" = 'COMPLETED'
  AND "outcome" = 'PASS'
  AND "completedAt" >= now() - interval '4 hours'
ORDER BY "completedAt" DESC
LIMIT 1;

-- ============ Q3: Notification dispatcher poll ============
-- Runs every 2 seconds. Wave 2c PERF-01 suggests collapsing to a SKIP LOCKED CTE.
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT "id" FROM notification_events
WHERE "status" IN ('PENDING','FAILED')
  AND "availableAt" <= now()
ORDER BY "availableAt" ASC
LIMIT 32;

-- ============ Q4: assertNoOverlap ============
-- Per-asset cardinality stays small — low risk.
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT "id" FROM reservations
WHERE "tenantId" = '00000000-0000-0000-0000-000000000001'
  AND "assetId" = (SELECT id FROM assets WHERE "tenantId" = '00000000-0000-0000-0000-000000000001' LIMIT 1)
  AND "approvalStatus" IN ('PENDING_APPROVAL','AUTO_APPROVED','APPROVED')
  AND "lifecycleStatus" IN ('BOOKED','CHECKED_OUT')
  AND "startAt" < now() + interval '8 hours'
  AND "endAt"   > now()
LIMIT 1;

-- ============ Q5: Audit chain predecessor lookup ============
-- Hit on every mutation. Backward index scan on PK — O(1).
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT "selfHash" FROM audit_events
ORDER BY "id" DESC
LIMIT 1;

-- ============ Q6: Notification dedup probe ============
-- Partial unique index — low risk. Wave 1 DATA-05 flagged NULL-tenantId gap.
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT 1 FROM notification_events
WHERE "tenantId" = '00000000-0000-0000-0000-000000000001'
  AND "eventType" = 'panorama.reservation.approved'
  AND "dedupKey" = 'test-dedup-key'
LIMIT 1;

-- ============ Q7: Invitation list (admin UI) ============
-- Wave 2c PERF-02 + PERF-07 — missing (tenantId, createdAt DESC) index;
-- status filter should push to DB.
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM invitations
WHERE "tenantId" = '00000000-0000-0000-0000-000000000001'
ORDER BY "createdAt" DESC
LIMIT 100;

-- ============ Q8: Concurrency cap count (reservation create) ============
-- Hot on every new-reservation request. Same OR risk as Q1.
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT COUNT(*) FROM reservations
WHERE "tenantId" = '00000000-0000-0000-0000-000000000001'
  AND ("requesterUserId" = '00000000-0000-0000-0000-000000000010'
       OR "onBehalfUserId" = '00000000-0000-0000-0000-000000000010')
  AND "approvalStatus" IN ('PENDING_APPROVAL','AUTO_APPROVED','APPROVED')
  AND "lifecycleStatus" IN ('BOOKED','CHECKED_OUT')
  AND "endAt" > now();

-- ============ Q9: Inspection resume check ============
-- Driver hot path — runs on every "new inspection" click.
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM inspections
WHERE "tenantId" = '00000000-0000-0000-0000-000000000001'
  AND "startedByUserId" = '00000000-0000-0000-0000-000000000010'
  AND "assetId" = (SELECT id FROM assets WHERE "tenantId" = '00000000-0000-0000-0000-000000000001' LIMIT 1)
  AND "status" = 'IN_PROGRESS'
  AND "startedAt" >= now() - interval '4 hours'
ORDER BY "startedAt" DESC
LIMIT 1;

-- ============ Q10: Blackout overlap check ============
-- Runs inside reservation create. The OR with asset-null (cluster-wide blackout)
-- is a potential plan hazard at scale.
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT "id","title" FROM blackout_slots
WHERE "tenantId" = '00000000-0000-0000-0000-000000000001'
  AND ("assetId" = (SELECT id FROM assets WHERE "tenantId" = '00000000-0000-0000-0000-000000000001' LIMIT 1)
       OR "assetId" IS NULL)
  AND "startAt" < now() + interval '8 hours'
  AND "endAt"   > now()
LIMIT 1;

\echo '---- baseline complete ----'
