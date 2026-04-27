import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import {
  NOTIFICATION_PAYLOAD_SCHEMAS,
  isRegisteredEventType,
} from './notification-events.schema.js';

/**
 * Notification bus emit-side API (ADR-0011).
 *
 * `enqueueWithin(tx, event)` — the only public emit path. Takes a
 * transaction client so the notification row commits with the
 * domain write. Three mandatory safeguards before INSERT:
 *
 *   1. eventType must be in NOTIFICATION_PAYLOAD_SCHEMAS; unknown
 *      types emit `panorama.notification.payload_rejected` and are
 *      dropped. A 500 surfaces so the caller sees the bug.
 *   2. payload is Zod-parsed against the registered schema. Zod
 *      failure = programmer error; the payload_rejected audit
 *      captures it.
 *   3. redaction pass strips any key matching the sensitive-field
 *      regex — defence in depth against a schema author
 *      accidentally whitelisting a secret-shaped key. Every hit
 *      emits `panorama.notification.payload_redacted` so the bug
 *      is visible.
 */

const SENSITIVE_FIELD_RE = /token|secret|password|authorization/i;
const REDACTED = '<redacted>';

export interface NotificationEventInput {
  eventType: string;
  tenantId?: string | null;
  payload: Record<string, unknown>;
  dedupKey?: string;
  /** Delay first dispatch by at least N ms. */
  delayMs?: number;
}

@Injectable()
export class NotificationService {
  private readonly log = new Logger('NotificationService');

  constructor(private readonly audit: AuditService) {}

  /**
   * Persist an event in the same transaction as the domain write.
   * Idempotency via `dedupKey` is enforced at the DB layer by the
   * partial unique index `notification_events_dedup_terminal`; a
   * 23505 collision is treated as a successful dedup skip.
   */
  async enqueueWithin(
    tx: Prisma.TransactionClient,
    event: NotificationEventInput,
  ): Promise<void> {
    // Validation failures land audit events in a FRESH transaction
    // via audit.record() — the outer tx is about to throw and roll
    // back, so audit.recordWithin would roll back with it and the
    // signal would disappear. The audit for "your domain write
    // tried to enqueue a bogus event" MUST survive the rollback.
    if (!isRegisteredEventType(event.eventType)) {
      await this.audit.record({
        action: 'panorama.notification.payload_rejected',
        resourceType: 'notification_event',
        resourceId: null,
        tenantId: event.tenantId ?? null,
        actorUserId: null,
        metadata: {
          reason: 'unknown_event_type',
          eventType: event.eventType,
        },
      });
      throw new Error(`unknown_event_type:${event.eventType}`);
    }

    const schema = NOTIFICATION_PAYLOAD_SCHEMAS[event.eventType];
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success) {
      await this.audit.record({
        action: 'panorama.notification.payload_rejected',
        resourceType: 'notification_event',
        resourceId: null,
        tenantId: event.tenantId ?? null,
        actorUserId: null,
        metadata: {
          reason: 'schema_validation_failed',
          eventType: event.eventType,
          zodIssues: parsed.error.issues,
        },
      });
      throw new Error(`payload_schema_failed:${event.eventType}`);
    }

    const { redacted, redactedKeys } = redactSensitive(
      parsed.data,
    );
    if (redactedKeys.length > 0) {
      this.log.warn(
        { eventType: event.eventType, redactedKeys },
        'notification_payload_redacted',
      );
      await this.audit.recordWithin(tx, {
        action: 'panorama.notification.payload_redacted',
        resourceType: 'notification_event',
        resourceId: null,
        tenantId: event.tenantId ?? null,
        actorUserId: null,
        metadata: {
          eventType: event.eventType,
          redactedKeys,
        },
      });
    }

    const availableAt = new Date(Date.now() + Math.max(0, event.delayMs ?? 0));

    try {
      const row = await tx.notificationEvent.create({
        data: {
          tenantId: event.tenantId ?? null,
          eventType: event.eventType,
          payload: redacted as Prisma.InputJsonValue,
          availableAt,
          dedupKey: event.dedupKey ?? null,
        },
      });
      await this.audit.recordWithin(tx, {
        action: 'panorama.notification.enqueued',
        resourceType: 'notification_event',
        resourceId: row.id,
        tenantId: row.tenantId,
        actorUserId: null,
        metadata: {
          eventType: row.eventType,
          dedupKey: row.dedupKey,
          availableAt: row.availableAt.toISOString(),
        },
      });
    } catch (err) {
      // 23505 = unique_violation on the partial dedup index →
      // idempotency guarantee, treat as success.
      if (isUniqueViolation(err)) {
        this.log.debug(
          { eventType: event.eventType, dedupKey: event.dedupKey },
          'notification_dedup_skipped',
        );
        return;
      }
      throw err;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; meta?: { code?: unknown } };
  return e.code === 'P2002' || e.meta?.code === '23505';
}

/**
 * Walk the payload recursively and redact values whose KEY matches
 * the sensitive pattern. Returns the redacted copy and the list of
 * top-level key paths where redaction fired (for the audit row).
 * EXPORTED for unit tests.
 */
export function redactSensitive(
  input: Record<string, unknown>,
): { redacted: Record<string, unknown>; redactedKeys: string[] } {
  const redactedKeys: string[] = [];
  const walk = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) {
      return value.map((v, i) => walk(v, `${path}[${i}]`));
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key;
        if (SENSITIVE_FIELD_RE.test(key)) {
          redactedKeys.push(childPath);
          out[key] = REDACTED;
        } else {
          out[key] = walk(val, childPath);
        }
      }
      return out;
    }
    return value;
  };
  const redacted = walk(input, '') as Record<string, unknown>;
  return { redacted, redactedKeys };
}
