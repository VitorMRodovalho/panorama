# ADR-0011: Notification event bus — architecture

- Status: Accepted (reviewed 2026-04-18 — tech-lead + security-reviewer pass after v2 revisions)
- Date: 2026-04-18
- Deciders: Vitor Rodovalho
- Related: [ADR-0003 Multi-tenancy](./0003-multi-tenancy.md), [ADR-0008 Invitation flow](./0008-invitation-flow.md), [ADR-0009 Reservation domain](./0009-reservation-domain.md)

## Context

0.2 domain services emit audit events (ADR-0003 §audit) when they mutate
tenant state, but those are for compliance — there's no mechanism to
*react* to a state change. The product surface needs:

- **Reservation approved / rejected** → email the requester.
- **Damage flagged on check-in** → alert ops (email, Slack for
  Enterprise).
- **Invitation bounced** → flip the invitation row into a
  `bounced` state, surface a warning in the admin UI.
- **Reservation reminder** — 1 h before `startAt`, nudge the driver.
- **SLA escalation** (0.4) — auto-route a pending reservation after
  N minutes without an admin decision.

Each of those already has an `audit.record(...)` call at the emit site
or a scheduled-job opportunity. What's missing is a durable fan-out
layer that takes those signals and drives side-effects without coupling
domain services to transport details (SMTP, webhooks, Slack, in-app).

The recurring failure modes we're defending against:

- **Lost notifications**. Domain write commits, the "send email" step
  crashes before it runs — no retry, no alert, no visibility.
- **Duplicated notifications**. A crash between "send succeeded" and
  "mark dispatched" replays the send on retry. Same email twice is a
  credibility loss.
- **Coupled services**. `ReservationService.approve` reaches into
  `EmailService.send(...)` — the Slack / webhook follow-up requires
  editing every emit site. Fan-out should be declarative.
- **Tenant cross-talk**. Tenant A's Slack webhook URL leaks into
  tenant B's notification. Every event must be tenant-scoped at the
  data layer.
- **Compliance invisibility**. "Did we actually notify this driver?"
  has to be answerable from the audit log, not "check Sentry for the
  SMTP timestamp".

## Prior art

| Pattern | Used by | Works for us? |
|---|---|---|
| **Outbox table** + dispatcher worker | ~every SaaS with Postgres + exactly-once ambitions | Yes — our invariant: event emitted iff domain tx commits |
| Pure in-process EventEmitter | Smaller Node apps | No — crash-lossy, no durability |
| Kafka / Redis Streams | High-throughput event systems | Overkill at 0.3; adds ops burden |
| Pub/sub with SNS / PubSub | Cloud-native | Couples to provider; we're multi-deploy |
| Native Postgres LISTEN / NOTIFY | Small-scale | Not durable across restarts; payload size capped |

The **outbox pattern** — domain services INSERT into a
`notification_events` table as part of the same transaction as their
domain write, and a separate dispatcher picks up `pending` rows and
drives the side-effect — matches our existing patterns (audit events
already live in this shape) and gives us the "emitted iff committed"
guarantee for free.

## Decision

**Outbox-backed notification bus with a polling dispatcher and a
channel registry.** Three moving parts:

### 1. `notification_events` table (migration 0011)

Schema:

```prisma
model NotificationEvent {
  id                String                   @id @default(uuid()) @db.Uuid
  /// Null = cluster-wide event (rare; most events are tenant-scoped).
  tenantId          String?                  @db.Uuid
  /// e.g. `panorama.reservation.approved`. Dotted namespace so the
  /// channel registry can route by prefix or exact match. Must be a
  /// KEY in the payload-schema registry (see §Payload schema below);
  /// an unknown type is REJECTED at enqueueWithin time.
  eventType         String
  /// Event body, validated against the Zod schema registered for
  /// `eventType`. Never contains plaintext tokens / passwords /
  /// secrets — the enqueue path applies a redaction pass that
  /// strips keys matching `/token|secret|password|authorization/i`
  /// and writes an ERROR-level audit breadcrumb
  /// (`panorama.notification.payload_redacted`) when it fires.
  /// Hard cap `pg_column_size(payload) <= 16384` (CHECK constraint).
  payload           Json
  status            NotificationEventStatus  @default(PENDING)
  dispatchAttempts  Int                      @default(0)
  availableAt       DateTime                 @default(now())
  lastAttemptAt     DateTime?
  lastError         String?
  /// Per-handler retry history so a "show me every retry and why"
  /// audit is one query (not a lossy JOIN). `lastError` stays as a
  /// fast-path convenience for logs; `errorHistory` is the durable
  /// trail. Kept on the row to avoid a second-table JOIN on every
  /// dispatch attempt.
  errorHistory      Json                     @default("[]")
  /// Per-channel dispatch outcome: `{"email":"dispatched","slack":"failed","webhook":"dead"}`.
  /// Addresses the "Slack dead but email succeeded — what did the
  /// customer actually get?" compliance question. Populated
  /// incrementally as handlers ack.
  channelResults    Json                     @default("{}")
  /// Optional idempotency key, scoped to `(tenantId, eventType,
  /// dedupKey)` via a partial unique index. The dispatcher SKIPS an
  /// event whose triple collides with a prior row already in
  /// DISPATCHED or DEAD. Handlers without a dedupKey get at-least-
  /// once semantics.
  dedupKey          String?
  dispatchedAt      DateTime?
  createdAt         DateTime                 @default(now())
  updatedAt         DateTime                 @updatedAt

  tenant Tenant? @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([status, availableAt])
  @@index([tenantId, eventType, createdAt(sort: Desc)])
  @@map("notification_events")
}

enum NotificationEventStatus {
  PENDING       // Enqueued, waiting for dispatcher
  IN_PROGRESS   // Claimed by a dispatcher instance
  DISPATCHED    // All registered channels acked
  FAILED        // Retryable — will be picked up again after availableAt
  DEAD          // Retry budget exhausted; no more attempts

  @@map("notification_event_status")
}
```

**Partial unique index** (hand-written in migration — Prisma 5.x
can't model partial uniques):

```sql
CREATE UNIQUE INDEX notification_events_dedup_unique
  ON notification_events ("tenantId", "eventType", "dedupKey")
  WHERE "dedupKey" IS NOT NULL;
```

Scoping the uniqueness to `(tenantId, eventType, dedupKey)` —
across ALL statuses, not just terminal — gives us strict "one row
per key" semantics over the key's lifetime. Two concurrent
enqueues with the same triple both race the INSERT; the second
fails with 23505 (`unique_violation`) and the service treats it
as a successful dedup skip. A row that dead-letters blocks new
attempts with the same key until an operator prunes it — by
design, same-key reuse requires human intent.

**Tamper-detection trigger** (migration 0011):

```sql
CREATE OR REPLACE FUNCTION emit_notification_tamper_audit()
RETURNS trigger AS $$
BEGIN
  -- Disallowed transitions include:
  --   * PENDING → DISPATCHED (skips IN_PROGRESS + handler run)
  --   * DEAD → anything (resurrection)
  --   * DISPATCHED → anything (reopen)
  -- The service layer flips through IN_PROGRESS + terminal via the
  -- dispatcher; any UPDATE that violates the state diagram is a
  -- direct-SQL edit, which we flag in the audit chain.
  IF (OLD.status = 'PENDING'   AND NEW.status = 'DISPATCHED') OR
     (OLD.status = 'DEAD')                                    OR
     (OLD.status = 'DISPATCHED' AND NEW.status <> 'DISPATCHED')
  THEN
    INSERT INTO audit_events (
      action, "resourceType", "resourceId", "tenantId",
      metadata, "occurredAt", "prevHash", "selfHash"
    )
    VALUES (
      'panorama.notification.status_tampered',
      'notification_event',
      NEW.id::text,
      NEW."tenantId",
      json_build_object(
        'fromStatus', OLD.status::text,
        'toStatus',   NEW.status::text,
        'eventType',  NEW."eventType"
      ),
      now(),
      NULL,
      digest(('tamper:' || NEW.id::text || ':' || now()::text)::bytea, 'sha256')
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

Payload size cap as a table-level CHECK:

```sql
ALTER TABLE notification_events
  ADD CONSTRAINT notification_events_payload_size_cap
  CHECK (pg_column_size(payload) <= 16384);
```

RLS + role separation (security-reviewer requirement): a dedicated
`panorama_notification_dispatcher` role with `SELECT, UPDATE` on
`notification_events` and `INSERT` on `audit_events`, nothing else.
The dispatcher boots with `SET LOCAL ROLE
panorama_notification_dispatcher` instead of
`panorama_super_admin`. A compromised channel handler (supply-chain
attack, npm poisoning) can't exfiltrate from other tables — least
privilege applied at the DB layer.

Tenant-scoped queries from regular code run under `runInTenant` +
the existing RLS policy `tenantId = panorama_current_tenant() OR
tenantId IS NULL` which covers the table.

### 2. `NotificationService.enqueueWithin(tx, event)` + payload schema

The domain-side API. Mirrors `AuditService.recordWithin(tx, ...)` —
callers pass the transaction, event goes in with the domain write. On
transaction rollback the event disappears with it.

```typescript
interface NotificationEventInput {
  eventType: string;            // must be a registered schema key
  tenantId?: string | null;
  payload: Record<string, unknown>;
  dedupKey?: string;
  /** Delay first dispatch by ≥ N ms (reservation reminders). */
  delayMs?: number;
}
```

**Payload schema registry — enforced, not convention.** Every
`eventType` is registered with a Zod schema in a single
`notification-events.schema.ts` catalogue:

```typescript
export const NOTIFICATION_PAYLOAD_SCHEMAS = {
  'panorama.reservation.approved': z.object({
    reservationId: z.string().uuid(),
    assetId: z.string().uuid(),
    requesterUserId: z.string().uuid(),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    note: z.string().max(500).optional(),
  }),
  'panorama.reservation.rejected': z.object({ /* same shape + note */ }),
  // … others at their emit sites
} as const;
```

`enqueueWithin` does **three** things before INSERT:

1. **Reject unknown eventType** — 400 `unknown_event_type:<...>` so
   a typo fails fast at the emit site, not silently at dispatch.
2. **Run the payload through the Zod schema** — a validation
   failure is a programmer error (not caller-facing), surfaced as
   a logged 500 + audit `panorama.notification.payload_rejected`
   with the failing eventType. The event is NOT enqueued.
3. **Redaction sweep** — walks the payload recursively; any key
   matching `/token|secret|password|authorization/i` is replaced
   with `"<redacted>"` and an audit row
   `panorama.notification.payload_redacted` fires. The redaction
   runs even on schema-valid payloads so a future schema author
   can't accidentally whitelist a secret-shaped key.

The domain service's only contract is: "call `enqueueWithin` with
a transaction client; the dispatcher takes it from there". No
channel names, no transport details, no "did this ack" coupling.

Design note — cross-module coupling: `NotificationService` is a
shared *infrastructure* service (same tier as `AuditService`), not
a domain service. Services importing it do NOT trip ADR-0003's
cross-module-coupling rule; the invariant there bans reaching into
OTHER domain modules' services (e.g. `ReservationService` importing
`InvitationService`), which this isn't.

### 3. `NotificationDispatcher` — poll-based outbox worker

Polls `notification_events WHERE status IN (PENDING, FAILED) AND
availableAt <= now() ORDER BY availableAt LIMIT 32` every 2 s.

For each claimed batch:

1. **Optimistic claim**: `UPDATE … SET status=IN_PROGRESS,
   lastAttemptAt=now() WHERE id=any(:ids) AND status IN (PENDING,
   FAILED)`. Rows that lost the race (another dispatcher instance
   claimed first) aren't in the returned set.
2. **Per-event tenant scope**: for each claimed row, invoke the
   handler pipeline inside `prisma.runInTenant(event.tenantId,
   async (tx) => ...)`. A compromised or buggy handler making a
   Prisma call lands under that tenant's RLS; cross-tenant queries
   return empty. Cluster-wide events (tenantId IS NULL) run under
   `runAsSuperAdmin` with a structured-log breadcrumb.
3. **Handler invocation**: look up
   `ChannelRegistry.handlersFor(eventType)`; invoke each handler
   with `(event, payload)`. Each handler's outcome (dispatched /
   failed / skipped-breaker-open) is recorded in
   `channelResults[channelName]`. Handler errors do NOT bubble out —
   they're recorded per channel so one broken channel doesn't
   poison sibling channels' retry budgets.
4. **Terminal evaluation**: after all handlers run:
   - Every handler acked → `status=DISPATCHED`, `dispatchedAt=now`,
     audit `panorama.notification.dispatched` with
     `channelResults` attached.
   - Any handler failed AND `dispatchAttempts + 1 < 5`:
     `dispatchAttempts++`, `status=FAILED`,
     `availableAt=now + backoff(attempts)`,
     `lastError=<firstFailedChannel>:<message>`, append to
     `errorHistory`.
   - Any handler failed AND `dispatchAttempts + 1 >= 5`:
     `status=DEAD` + audit `panorama.notification.dead` with
     `{ eventType, tenantId, channelResults, errorHistory, attempts
     }`. The dead payload is the full retry history — compliance
     can answer "why" in one query.

Backoff: `exponential(base=60 s)` — 1 m, 2 m, 4 m, 8 m, 16 m. Matches
the invitation-email retry schedule so ops learn one pattern.

**Stuck-IN_PROGRESS rescue (hourly maintenance job).** A dispatcher
process that crashes between claim (step 1) and terminal update (step
4) strands the row at `status=IN_PROGRESS`. The rescue sweep runs
every 60 s alongside the dispatcher itself:

```sql
UPDATE notification_events
   SET status = 'FAILED',
       "lastError" = 'stuck_in_progress_rescued'
 WHERE status = 'IN_PROGRESS'
   AND "lastAttemptAt" < now() - interval '60 seconds';
```

Rescued rows emit `panorama.notification.rescued` so the recovery
isn't silent. Matches the invitation-email maintenance worker
(`invitation-email.queue.ts:191–228`) so ops learn one rescue
pattern. Threshold 60 s = one invocation of the maintenance sweep;
tuneable at 0.4 via tenant config if we see false positives.

**Poll-based, not BullMQ**, despite the invitation queue using BullMQ:

- The outbox table IS the durable queue. Adding BullMQ between
  would require bridge code that moves `PENDING` rows into BullMQ
  and flips statuses — two sources of truth, reconciliation edge
  cases. The invitation flow uses a BullMQ rescue sweep precisely
  to paper over that gap; we skip it at the cost of ~2 s dispatch
  latency.
- Polling a table with a B-tree on `(status, availableAt)` is cheap
  — at 0.3 scale (100 events/minute worst case), the dispatcher
  query is sub-millisecond.
- Trade-off documented; revisit if throughput changes the math.
- The invitation flow stays on BullMQ because it predates this ADR
  and migrating isn't worth the churn; this ADR does NOT promise
  to rewrite it.

Dispatcher **does not run** when `NODE_ENV=test` unless a test
explicitly starts one (same gating as the invitation worker). Tests
that need dispatch exercise it via a direct call.

**Circuit breaker (channel auto-disable — scaffolded now, enabled in
0.4 with the first external-delivery channels).** Per-channel state
in Redis (`notification:channel:{name}:breaker`): open if the
channel has failed N times (default 10) in the last T minutes
(default 5). While open, the dispatcher skips the channel with
`channelResults.<name>="skipped_breaker_open"` and emits
`panorama.notification.channel_breaker_opened` once per open-close
cycle. Scope intentional: 0.3 has only the email channel where
transient SMTP failures aren't expected to form a pattern; webhook +
Slack channels land with the breaker active.

### 4. `ChannelRegistry`

A `Map<string, ChannelHandler[]>` built at module bootstrap. Each
`ChannelHandler` implements:

```typescript
interface ChannelHandler {
  name: string;                 // 'email' | 'slack' | 'webhook' | 'inapp'
  supports(eventType: string): boolean; // prefix or exact match
  dedupKeyFor?(event): string | null;   // optional
  handle(event): Promise<void>;
}
```

Handlers register via `ChannelRegistry.register(handler)`. The
dispatcher iterates matching handlers for each event. An event with
zero matching handlers is marked DISPATCHED immediately — "no one
cares about this event type today" isn't an error condition.

At 0.3 the only shipped handler is `EmailChannel` (`panorama.
reservation.approved`, `.rejected`). Enterprise / 0.4 can add
`SlackChannel`, `WebhookChannel`, `InAppNotificationChannel` without
touching core.

### 5. Observability

- **Audit events** — terminal and tamper-state transitions:
  - `panorama.notification.enqueued` — one per `enqueueWithin` call
  - `panorama.notification.dispatched` — row reached terminal success
    (metadata includes `channelResults` so "what did each channel
    actually do" is one query)
  - `panorama.notification.dead` — retry budget exhausted (metadata
    includes full `errorHistory[]` + `channelResults`)
  - `panorama.notification.rescued` — stuck-IN_PROGRESS sweep reset
    a row; non-zero count here is an alert-worthy ops signal
  - `panorama.notification.status_tampered` — DB trigger, fires on
    disallowed UPDATE transitions (PENDING→DISPATCHED,
    DEAD→anything, DISPATCHED→anything). Addresses the "compromised
    super-admin flips status to DISPATCHED to suppress a real
    notification" attack; the row change can't avoid the audit
  - `panorama.notification.channel_breaker_opened` / `.closed` —
    circuit breaker state transitions (0.4)
  - `panorama.notification.payload_redacted` — `enqueueWithin`
    stripped a secret-shaped key; emit site has a bug to fix
  - `panorama.notification.payload_rejected` — Zod schema rejected
    the payload; emit site has a bug to fix
- Intermediate retry attempts are NOT individual audit events (too
  noisy); the full retry history lives in `errorHistory` on the
  row. A compliance ask "show me every retry and why" is one JSON
  query on that column.
- **Logs** — structured, per-attempt, through the Nest `Logger`.
  **Handlers MUST NOT log the raw `payload`** — id + eventType +
  channel name only. Enforced via a lint rule in the ChannelHandler
  base class (handler-level logger is a child logger that strips
  the `payload` key).
- **Metrics** (Enterprise / 0.4) — Prometheus counters for enqueue /
  dispatch / dead / rescued, histograms for dispatch latency.
  Scaffolded in the `NotificationDispatcher` as named counters so
  the Prom exporter plumbing in 0.4 wires in without a rewrite.

## Alternatives considered

### Pure in-process EventEmitter

`service.emit('panorama.reservation.approved', event)` with direct
listeners. Simplest possible.

Rejected: crash-lossy. A domain tx commits, the event fires, the
listener throws / the process exits → the "approved but never
notified" window is silent. No way to replay.

### BullMQ without an outbox table

Push directly from domain services into BullMQ queues; skip the DB
table. Aligns with the invitation-email pattern.

Rejected: the DB commit + `queue.add` pair is non-atomic. Crash
between them = lost notification. The invitation pattern survives this
with a periodic rescue sweep; we'd end up rebuilding the outbox
anyway. Better to start with the outbox.

### Per-tenant dispatcher workers

Each tenant gets its own dispatcher process for isolation.

Rejected for 0.3: operational complexity (N processes per
tenant) without a concrete noisy-neighbour problem. The dispatcher
processes one tenant's events at a time; one slow-responding webhook
doesn't hold the others up (parallel handler execution within a
batch). Revisit if we see tenant-B's webhook starving tenant-A in
practice.

### Kafka / Redis Streams

Industry standard for high-throughput event buses.

Rejected as premature. The operational cost (Kafka cluster, schema
registry) dwarfs the benefit at 0.3 volumes. Postgres + a polling
worker does this job and surfaces in the same observability stack as
everything else.

### Native Postgres LISTEN/NOTIFY

Could drive a push-based dispatcher.

Rejected: payload size capped at ~8 kB, no durability — if no
listener is connected when NOTIFY fires, the event is lost.

## Consequences

### Positive

- **Event emitted iff committed** — the outbox INSERT lives in the
  same tx as the domain write. No rollback→"but we sent the email"
  scenarios.
- **Transport decoupling** — domain services call `enqueueWithin`
  and move on. Slack / webhook / future channels added without
  editing the emit site.
- **Retry + dead-letter without extra infra** — the row IS the
  queue; retries update the row; dead-letter is `status=DEAD` +
  audit.
- **Tenant isolation at the data layer** — `tenantId` on the row,
  RLS policy, dispatcher filters. No per-channel leak risk.
- **Audit-complete** — the three terminal-state audit events answer
  the compliance question "did we notify X about Y?" with one query.

### Negative

- **Dispatcher latency** — ≤ 2 s worst case (one poll cycle). Not
  suitable for synchronous "send now, block caller" flows (none in
  0.3).
- **Table growth** — successful events sit at `status=DISPATCHED`
  forever. A companion sweep job prunes `DISPATCHED` rows older
  than 90 d by default; a per-tenant override column
  (`Tenant.notificationRetentionDays: Int?`) ships in migration
  0011 so a Q3 data-governance audit doesn't trigger a scramble.
  Default-fallback 90 d when the column is NULL.
- **Handler error budget is shared across handlers** in the sense
  that retry attempts count per-EVENT, not per-channel. But
  `channelResults` on each row records which channel(s) succeeded,
  so a "Slack dead but email succeeded" audit tells the truth —
  the DEAD status means "at least one channel exhausted retries",
  not "customer got nothing". Per-channel independent retry
  budgets ship in 0.4 if we see pathologically-uneven channel
  reliability.
- **Bootstrap-time channel registration only** — plugin-sdk in
  0.3+ will need a registry-rebuild API. Not a blocker for 0.3;
  explicit follow-up so a future contributor doesn't discover it
  the hard way.

### Neutral

- The notification bus is additive — nothing in the 0.2 domain services
  depends on it. Rollout lands subscriber by subscriber.
- `FEATURE_NOTIFICATION_BUS` gates dispatcher registration in
  `AppModule.forRoot` — disable to silence all outbound notifications
  without a DB rollback.

## Execution order

1. **This ADR** — accepted (tech-lead + security-reviewer APPROVE
   after v2 revisions closing all pre-code blockers).
2. **Migration 0011** — `notification_events` table + status enum
   + partial unique index on `(tenantId, eventType, dedupKey)` +
   payload size CHECK constraint + tamper-detection trigger +
   `panorama_notification_dispatcher` DB role with narrow grants
   + `Tenant.notificationRetentionDays: Int?` column + rls.sql +
   ROLLBACK.md.
3. **NotificationService + enqueueWithin** — service-side API with
   the payload schema registry (Zod per eventType) and redaction
   sweep. Unknown eventType → 500 + audit
   `panorama.notification.payload_rejected`.
4. **ChannelRegistry + NotificationDispatcher** — poll-based
   worker + stuck-IN_PROGRESS rescue sweep + per-event
   `runInTenant` wrapper + per-channel outcome tracking in
   `channelResults`. Dispatcher binds to the
   `panorama_notification_dispatcher` role, NOT super-admin.
5. **Audit hooks** — emit all `panorama.notification.*` events
   listed in §Observability. Tamper audit lands via DB trigger
   (step 2); service-layer audit events land via `audit.record`.
6. **First subscriber** — `EmailChannel` for
   `panorama.reservation.approved` / `.rejected`. Renders via
   EmailService; no new template pipeline (reuse
   `invitation-email.templates` pattern).
7. **Retention sweep** — Per-tenant configurable (default 90 d)
   prune of `DISPATCHED` rows via a maintenance job. Reuses the
   invitation-maintenance worker's cron hook.
8. **Integration test** — approve a reservation → notification
   row appears in `PENDING` → dispatcher ticks → row reaches
   `DISPATCHED` with populated `channelResults.email="dispatched"`
   → email send call observable in test double. Plus negative
   tests: unknown eventType rejected, payload with
   `{ tokenPlaintext }` redacted, cross-tenant handler call
   blocked by RLS, tamper-trigger fires on direct SQL status flip.

**Future-facing commitments** recorded here so 0.4 contributors
don't re-open the ADR:

- **Webhook channel SSRF defence** — `WebhookChannel` (0.4) MUST
  validate target URLs against an allowlist and REJECT
  `169.254.169.254/*` (AWS IMDS), `127.0.0.0/8`, `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (link-local),
  `.internal` DNS suffixes. Test cases shipped with the webhook
  handler.
- **Per-channel retry budgets** — add `channelResults` with
  per-channel `attempts` sub-field; split global
  `dispatchAttempts` into per-channel when a second channel ships.
- **Circuit breaker live** — Redis-backed breaker enabled for
  webhook + Slack channels at 0.4. Email channel keeps shared
  retry because transient SMTP failures aren't expected to form a
  pattern worth opening a breaker on.
- **Plugin-SDK dynamic registration** — ChannelRegistry grows a
  `register(handler, { afterBootstrap: true })` API that updates
  the in-memory map + rebuilds the event-type index. Not in 0.3.

Each step lands as its own commit, gated by the agent review team.
