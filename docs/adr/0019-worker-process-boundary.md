# ADR-0019: Worker process boundary (photo pipeline defer-with-trigger)

- Status: Accepted (2026-05-16). Drafted from the Wave 0 6-agent scan
  on the same date; accepted by maintainer in the same session.
- Date: 2026-05-16
- Deciders: Vitor Rodovalho (maintainer)
- Reviewers (Wave 0 scan, 2026-05-16):
  - tech-lead → BLOCK on splitting the photo-pipeline into a worker
    process for Wave 0 without an ADR codifying the trigger condition
    (B3 in the scan). This ADR is the codification.
  - data-architect → no objection (no schema impact)
  - security-reviewer → no objection (no new attack surface; existing
    BullMqInvitationQueue convention is preserved)
- Related: [ADR-0011 Notification event bus](./0011-notification-event-bus.md)
  (existing co-located producer + worker convention),
  [ADR-0012 Inspection checklists + photo evidence pipeline](./0012-inspection-photo-pipeline.md)
  (the photo-pipeline service this ADR scopes)

## Context

The handoff from 2026-05-09 listed "BullMQ + Redis worker process —
photo-pipeline isn't wired as a worker; synchronous handling of any
queued work blocks request threads. Latent risk under load." as a
Wave 0 candidate. The Wave 0 tech-lead scan on 2026-05-16 surfaced
the architectural cost of splitting NOW versus later, and asked for
this ADR to either codify the split or codify the trigger that would
force it.

The decision is to **defer the split** for Wave 0 and codify a
specific trigger condition.

## Decision

The photo-pipeline (`apps/core-api/src/modules/photo-pipeline/photo-pipeline.service.ts`)
**stays in-process** for the public preview launch. A separate worker
process is deferred until one of two trigger conditions fires:

### Trigger A — latency

p95 photo-upload handler latency exceeds **2 seconds for 10
consecutive minutes** (measured from the observability stack
established in ADR-0018). Sustained 2s p95 means the request thread
is blocking on photo work and degrading unrelated requests.

### Trigger B — concurrency

Concurrent inspection-photo uploads exceed **N simultaneous** (where
N is the per-instance Fly machine's CPU count × 2, or 4 — whichever
is greater). At that point the in-process model degenerates into
serial processing under load.

When either trigger fires, the response is to write an ADR-0019
amendment (or supersede this ADR) that:

1. Designates the worker topology (separate Fly process group with
   shared Redis queue + S3 access)
2. Migrates BOTH the photo-pipeline AND the existing
   `BullMqInvitationQueue` (`apps/core-api/src/modules/invitation/invitation-email.queue.ts`)
   to the same topology — see Reasoning §B below
3. Defines the deploy unit (Fly process group config)
4. Defines the failure modes (worker dead but web alive serving 200s
   on uploads that never persist)

## Reasoning

### A. Public-preview load profile justifies in-process

Wave 0's load expectations: 1–3 design partners in the first 60 days,
each with low concurrent activity. The photo-pipeline's CPU
intensity (sharp resize + EXIF strip + S3 upload) is real but the
request-thread cost is bounded by partner concurrency. Splitting now
optimizes for a load profile we don't have and may never reach.

### B. Splitting one queue without splitting all creates two conventions

The existing `BullMqInvitationQueue`
(`apps/core-api/src/modules/invitation/invitation-email.queue.ts`)
co-locates worker + producer in one process today. That's the
convention. Breaking it for photo-pipeline first creates **two
conventions** — when the trigger fires, the right move is to migrate
BOTH queues to the new topology in a single ADR amendment, not to
incrementally fork the architecture.

### C. New failure mode introduced by the split

In-process work has one failure mode: the request crashes, the user
sees 5xx. A separated worker introduces a second failure mode:
worker dead, web alive serving 200s on uploads that the user thinks
succeeded but that never persist. This is a real footgun and the
mitigation (worker health-check + queue-depth alerting + dead-worker
detection) is its own multi-day implementation. Don't pay that cost
without the trigger that justifies it.

## Alternatives considered

### A) Split now in Wave 0

Rejected per §A above. The load profile doesn't justify the cost; the
new failure mode introduces operational complexity we don't yet have
the runbooks for; the convention split creates churn in the
invitation queue surface that has no reason to change.

### B) Defer with no trigger codified ("we'll know when it's a problem")

Rejected. Implicit triggers become "let's not bother" decisions that
drift indefinitely. Codifying p95 latency + concurrency thresholds
gives the maintainer (and future contributors) a clear
"this-is-when-we-act" signal that doesn't require re-arguing the
decision under load pressure.

### C) Adopt a queue topology that's worker-ready from day one
   (e.g., Sidekiq-style with always-separate workers)

Rejected. Same architectural cost as splitting now, just framed as
"we built it to scale." The "build for the load you have, not the
load you imagine" principle (a non-negotiable from prior ADRs)
applies. When the trigger fires, the migration is not painful — it's
~1 day of work — but doing it now is unnecessary toil.

## Consequences

### Positive

- Wave 0 ships without a multi-day worker-topology project that
  doesn't pay off until load arrives.
- The trigger conditions (§A + §B) are observable from ADR-0018's
  observability stack — no separate instrumentation needed.
- When the trigger does fire, the migration scope is unambiguous
  (both queues, single ADR amendment) — no incremental fork.

### Negative

- Sustained heavy load before the trigger fires (e.g., a single
  partner doing a 100-photo inspection sweep) will degrade
  unrelated requests on the same Fly instance. Mitigation: per-
  tenant throttler from Wave 0 backlog + Fly horizontal scaling if
  needed.
- The "no worker yet" framing in the public-preview honesty band
  must be honest: "photo uploads run synchronously today; under
  heavy load the request thread is busy" is what the band says, not
  "workers handle uploads in the background."

### Neutral / locked-in

- The trigger conditions are observable; if they don't fire in 90
  days of public preview, the in-process pattern stays as the
  default. If they fire, the migration is unblocked.
- Future queue work (e.g., audit-event archival, scheduled
  reservation reminders) defaults to the same in-process pattern
  unless its own ADR argues for a worker — same trigger logic
  applies.

## Implementation notes

Nothing ships from this ADR directly. It is a **defer-with-condition**
decision that:

- Closes the Wave 0 tech-lead scan B3 block
- Cites ADR-0018's observability stack as the source of the trigger
  measurement
- Provides the maintainer + future contributors with a clear gate
  for when to revisit

The honesty-band copy on the public homepage (Wave 0 deliverable)
should mention "photo uploads run synchronously today" as the
"what's rough" disclosure that pairs with this ADR.
