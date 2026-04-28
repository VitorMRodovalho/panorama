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
 *
 * --- Multi-strand semantics (#113 / RLS-01) ---
 *
 * The chain is **multi-strand**, not single-linear, because the
 * `findFirst` chain-head read is filtered by RLS at the role's
 * visibility:
 *
 *   * `recordWithin(tx, …)` called from `runInTenant(tenantA, …)`
 *     reads the latest row visible to tenantA (own rows + NULL-tenant
 *     rows per `audit_events_tenant_read`). Writes carry
 *     `tenantId = tenantA`.
 *   * `recordWithin(tx, …)` called from `runAsSuperAdmin(…)` (or the
 *     SECURITY DEFINER triggers post-#41) reads the global latest row.
 *     Writes typically carry `tenantId = NULL` for cluster-wide
 *     system events.
 *
 * This is by ADR-0003's least-privilege contract — `panorama_app`
 * cannot see other tenants' rows, so the chain head it reads is
 * tenant-scoped. The trade-off: a single global linear chain would
 * require every tenant write to escalate to super-admin for the
 * head read (a SECURITY DEFINER helper), which weakens the RLS
 * isolation property for an append-only verification benefit.
 *
 * **Verification tooling implications:**
 *
 *   1. Verify each tenant's strand independently — filter to
 *      `tenantId IN (tenant, NULL)`, order by `id`, walk prev/self hash.
 *      Cross-strand prev_hash links (a tenant linking forward to a
 *      NULL-tenant row visible to it) are normal and verify cleanly.
 *   2. Verify the global super-admin strand — no tenantId filter,
 *      order by `id`, walk the chain. The global strand sees every
 *      row but its `prev_hash` was written from the global head at
 *      write time, so it's coherent on its own.
 *   3. Cross-tenant timeline reconstruction uses `occurredAt`, NOT
 *      the prev_hash links — links are local to a strand.
 *
 * The `tenantId` column is the natural strand discriminator: NULL
 * for system / privileged-write events, the tenant uuid for
 * tenant-scoped writes.
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
