-- =============================================================================
-- pg_stat_statements slow-query detection
-- =============================================================================
-- Wave 2c artifact. See docs/audits/2026-04-23-wave-2.md.
--
-- Prereq:
--   CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
--   Restart postgres with shared_preload_libraries = 'pg_stat_statements'.
--
-- Run as a scheduled task (pg_cron or application cron) every 15 min in
-- staging/prod. Surfaces queries exceeding thresholds.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Reset once per deploy / daily to keep the baseline current:
--   SELECT pg_stat_statements_reset();

-- Thresholds — tune per environment:
--   mean_exec_time > 50ms          (latency)
--   calls > 1000 AND mean > 20ms   (hot + moderately slow)
--   rows / calls > 500             (fan-out — listing without LIMIT)
--   total_exec_time > 10s          (aggregate impact over sampling window)

SELECT
    queryid,
    LEFT(query, 200)                                   AS query_preview,
    calls,
    round(total_exec_time::numeric, 2)                 AS total_ms,
    round(mean_exec_time::numeric, 2)                  AS mean_ms,
    round(max_exec_time::numeric, 2)                   AS max_ms,
    round(stddev_exec_time::numeric, 2)                AS stddev_ms,
    rows,
    round((rows::numeric / NULLIF(calls, 0)), 1)       AS rows_per_call,
    round((shared_blks_hit::numeric /
           NULLIF(shared_blks_hit + shared_blks_read, 0) * 100), 1)
                                                       AS cache_hit_pct,
    shared_blks_read                                   AS disk_reads
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND (
    mean_exec_time > 50
    OR (calls > 1000 AND mean_exec_time > 20)
    OR (rows::numeric / NULLIF(calls, 0)) > 500
    OR total_exec_time > 10000
  )
ORDER BY total_exec_time DESC
LIMIT 25;

-- -----------------------------------------------------------------------------
-- Operational notes
-- -----------------------------------------------------------------------------
-- 1. pg_stat_statements tracks stats across ALL connections. Filter by userid
--    if you need per-role breakdown (e.g. exclude the dispatcher's poll).
--
-- 2. On Panorama, the dispatcher role dominates `calls` count. For
--    application-layer analysis, filter it out:
--    AND userid != (SELECT oid FROM pg_roles
--                   WHERE rolname = 'panorama_notification_dispatcher')
--
-- 3. To integrate with alerting:
--      - Wrap this query in a function that INSERTs rows into a
--        `perf_slow_queries` table with a timestamp.
--      - Alert when mean_ms > 100 or cache_hit_pct < 95.
--
-- 4. Reset cadence: call pg_stat_statements_reset() at deploy time so the
--    baseline reflects the current code version's query shapes.
--
-- 5. Prisma-generated queries normalize well in pg_stat_statements
--    because $1/$2 placeholders group by query structure.
-- =============================================================================
