import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Hash-chained audit log writer. Every row links to the previous row's
 * `selfHash`, so tampering with one event breaks the chain at the next
 * read (and downstream verification tooling, once it exists, can
 * detect it).
 *
 * The previous row is the row with the greatest `id`; in a
 * single-writer context this is the linear predecessor. Concurrent
 * writers may interleave — that's acceptable for an append-only
 * audit log since we only need *a* consistent predecessor pointer,
 * not a globally-total order. Verification tooling traverses the
 * id-ordered chain at audit time.
 */
export interface AuditEventInput {
  /** e.g. `panorama.invitation.created`. */
  action: string;
  /** Domain object type — `invitation`, `tenant_membership`, … */
  resourceType: string;
  /** Primary key of the domain object (string so UUID / BigInt / slug all fit). */
  resourceId?: string | null;
  /** Tenant the action belongs to. NULL for cluster-wide events. */
  tenantId?: string | null;
  actorUserId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuditService {
  private readonly log = new Logger('AuditService');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record an audit event outside any caller-held transaction. Use
   * `recordWithin(tx, event)` when you must atomically persist the
   * audit row alongside a domain write (which is almost always the
   * case — audit events emitted after a COMMIT drift from the data
   * they describe).
   */
  async record(event: AuditEventInput): Promise<void> {
    await this.prisma.runAsSuperAdmin(
      async (tx) => {
        await this.recordWithin(tx, event);
      },
      { reason: `audit:${event.action}` },
    );
  }

  /**
   * Emit an audit row inside an already-open transaction. Matches the
   * invariant that domain writes + their audit record commit together.
   */
  async recordWithin(
    tx: Prisma.TransactionClient,
    event: AuditEventInput,
  ): Promise<void> {
    const prev = await tx.auditEvent.findFirst({
      orderBy: { id: 'desc' },
      select: { selfHash: true },
    });
    const occurredAt = new Date();
    const payload = {
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId ?? null,
      tenantId: event.tenantId ?? null,
      actorUserId: event.actorUserId ?? null,
      metadata: event.metadata ?? null,
      occurredAt: occurredAt.toISOString(),
    };
    const hash = createHash('sha256');
    if (prev?.selfHash) hash.update(prev.selfHash);
    hash.update(JSON.stringify(payload));
    const selfHash = hash.digest();

    const data: Prisma.AuditEventCreateInput = {
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId ?? null,
      tenantId: event.tenantId ?? null,
      actorUserId: event.actorUserId ?? null,
      ipAddress: event.ipAddress ?? null,
      userAgent: event.userAgent ?? null,
      occurredAt,
      prevHash: prev?.selfHash ?? null,
      selfHash,
    };
    if (event.metadata !== undefined) {
      data.metadata = event.metadata as Prisma.InputJsonValue;
    }
    await tx.auditEvent.create({ data });
  }
}
