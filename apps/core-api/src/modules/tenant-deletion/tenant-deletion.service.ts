import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PanoramaAuditAction } from '../audit/audit-actions.js';
import { EmailService } from '../email/email.service.js';
import { TenantDeletionConfigService } from './tenant-deletion.config.js';
import {
  renderDeletionRequestEmail,
  type DeletionRequestEmailContext,
} from './tenant-deletion.templates.js';

/**
 * Tenant deletion domain service (ADR-0020 §7).
 *
 * Four state transitions on a `Tenant` row's
 * `deletionScheduledAt` column:
 *
 *   - request: mint a one-time confirmation token, fan email out to
 *     every active Owner of the tenant, audit-emit
 *     `TenantDeleteRequested`. The Tenant.deletionScheduledAt stays
 *     NULL — the cool-off only starts on confirm.
 *   - confirm: consume the token, set Tenant.deletionScheduledAt to
 *     T+coolOffDays, capture deletionRequestedByUserId, audit-emit
 *     `TenantDeleteConfirmed`.
 *   - cancel: clear Tenant.deletionScheduledAt + the requester
 *     reference; idempotent — second cancel against an already-
 *     cancelled tenant is a no-op. Audit-emit `TenantDeleteCancelled`
 *     exactly once (the precondition check prevents double-emit per
 *     ADR §7 race C).
 *   - veto: identical post-condition to cancel BUT requires the
 *     vetoing Owner to NOT be the original requester (peer-Owner
 *     safety net per §7 race B). Audit-emit `TenantDeleteVeto` with
 *     `vetoSource: 'peer_owner'`. Platform-maintainer veto path
 *     (admin console) is out of scope for PR 3.
 *
 * Cron purge (`runPurgeBatch`):
 *   - find tenants where deletionScheduledAt <= NOW()
 *   - per-tenant, runAsSuperAdmin tx:
 *       1. emit `TenantDeleted` audit row (BEFORE the cascade so the
 *          row's tenantId carries the per-tenant strand head)
 *       2. capture systemActorUserId
 *       3. UPDATE tenant SET systemActorUserId = NULL (migration
 *          0024 made the column nullable; this clears the FK so the
 *          system user can be dropped without triggering the
 *          ON DELETE RESTRICT)
 *       4. DELETE the system user (FKs in tenant_membership /
 *          inspection / maintenance / etc. CASCADE; tenant
 *          membership row tied to the system user goes away here)
 *       5. DELETE the tenant (CASCADE drops every remaining
 *          tenant-scoped row including any unconsumed deletion
 *          tokens and email_verifications)
 *   - the audit_events table has no FK to tenants, so the
 *     TenantDeleted row at step 1 survives the cascade and the
 *     strand's tail is the deletion marker itself.
 *
 * All paths route through runAsSuperAdmin because the deletion flow
 * crosses the tenant boundary — most directly at purge time when
 * the tenant row is going away, but also at request time because
 * the cron + the request paths share a service layer that lives
 * outside any single tenant's RLS scope.
 */

export type RequestResult =
  | { kind: 'ok'; tokenKeyPrefix: string; ownerCount: number }
  | { kind: 'already_scheduled' }
  | { kind: 'duplicate_request' };

export type ConfirmResult =
  | { kind: 'ok'; scheduledAt: Date }
  | { kind: 'missing' }
  | { kind: 'expired' }
  | { kind: 'already_consumed' }
  | { kind: 'tenant_already_scheduled' }
  | { kind: 'tenant_mismatch' };

export type CancelResult =
  | { kind: 'ok'; previouslyScheduledAt: Date }
  | { kind: 'noop' };

export type VetoResult =
  | { kind: 'ok'; previouslyScheduledAt: Date }
  | { kind: 'noop' }
  | { kind: 'requester_self_veto_refused' };

@Injectable()
export class TenantDeletionService {
  private readonly log = new Logger('TenantDeletionService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: EmailService,
    private readonly cfg: TenantDeletionConfigService,
  ) {}

  /**
   * §7 step 1 — POST /tenants/:id/delete-request.
   *
   * Refuses if the tenant already has a scheduled deletion
   * (`deletionScheduledAt IS NOT NULL`) — the Owner must cancel
   * before requesting again. Also refuses on duplicate-request
   * (an unconsumed token already exists for this tenant) — the
   * Owner should consume / cancel the prior token first.
   *
   * Email fan-out goes to ALL active Owners. SMTP failure is
   * logged but does NOT roll back the token row (the operator
   * fallback is to read the audit row + resend manually). One
   * token row per request — every Owner's email references the
   * same token, ANY Owner consumes.
   */
  async request(input: {
    tenantId: string;
    requestedByUserId: string;
  }): Promise<RequestResult> {
    const { plaintext, tokenHash } = this.generateToken();
    const expiresAt = new Date(
      Date.now() + this.cfg.config.tokenTtlHours * 60 * 60 * 1000,
    );

    const result = await this.prisma.runAsSuperAdmin(
      async (tx) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: input.tenantId },
          select: {
            id: true,
            displayName: true,
            deletionScheduledAt: true,
          },
        });
        if (!tenant) return { kind: 'duplicate_request' as const };
        if (tenant.deletionScheduledAt !== null) {
          return { kind: 'already_scheduled' as const };
        }
        const pending = await tx.tenantDeletionToken.findFirst({
          where: {
            tenantId: input.tenantId,
            consumedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        });
        if (pending) return { kind: 'duplicate_request' as const };

        await tx.tenantDeletionToken.create({
          data: {
            tenantId: input.tenantId,
            requestedByUserId: input.requestedByUserId,
            tokenHash,
            expiresAt,
          },
        });

        const owners = await tx.tenantMembership.findMany({
          where: {
            tenantId: input.tenantId,
            role: 'owner',
            status: 'active',
          },
          select: {
            userId: true,
            user: { select: { email: true, displayName: true } },
          },
        });
        const requester = await tx.user.findUnique({
          where: { id: input.requestedByUserId },
          select: { email: true, displayName: true },
        });

        await this.audit.recordWithin(tx, {
          action: PanoramaAuditAction.TenantDeleteRequested,
          resourceType: 'tenant',
          resourceId: input.tenantId,
          tenantId: input.tenantId,
          actorUserId: input.requestedByUserId,
          metadata: {
            requestedByUserId: input.requestedByUserId,
            ownerCount: owners.length,
            tokenKeyPrefix: tokenHash.slice(0, 8),
          },
        });

        return {
          kind: 'ok' as const,
          tokenKeyPrefix: tokenHash.slice(0, 8),
          ownerCount: owners.length,
          tenantDisplayName: tenant.displayName,
          owners,
          requester: requester ?? { email: 'unknown', displayName: 'Unknown' },
        };
      },
      { reason: `tenant-deletion:request:${input.tenantId}` },
    );

    if (result.kind !== 'ok') return result;

    // Email fan-out happens AFTER the tx commits — a tx that holds
    // an SMTP roundtrip is fragile. Per-recipient send is best-
    // effort; a partial fan-out logs each failure but does not
    // unwind the request.
    for (const owner of result.owners) {
      if (!owner.user) continue;
      const ctx: DeletionRequestEmailContext = {
        recipientEmail: owner.user.email,
        recipientDisplayName: owner.user.displayName,
        tenantDisplayName: result.tenantDisplayName,
        requesterDisplayName: result.requester.displayName,
        requesterEmail: result.requester.email,
        token: plaintext,
        manageUrlBase: this.cfg.config.manageUrlBase,
        tenantId: input.tenantId,
        expiresAt,
        coolOffDays: this.cfg.config.coolOffDays,
      };
      const rendered = renderDeletionRequestEmail(ctx);
      try {
        await this.mail.send({
          to: owner.user.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        });
      } catch (err) {
        // Log the recipient as a sha256 prefix so operator can
        // correlate without leaking the raw email into log
        // aggregators (mirrors PR 2's `email-verification.service.ts`
        // log shape — security-reviewer PR 3 review).
        this.log.error(
          {
            err: String(err),
            recipientHash: createHash('sha256').update(owner.user.email).digest('hex').slice(0, 8),
          },
          'tenant_deletion_email_dispatch_failed',
        );
      }
    }
    return {
      kind: 'ok',
      tokenKeyPrefix: result.tokenKeyPrefix,
      ownerCount: result.ownerCount,
    };
  }

  /**
   * §7 step 2 — POST /tenants/:id/delete-confirm.
   *
   * Atomic tx: validate + mark consumed + set scheduledAt.
   * Race A (ADR §7) — concurrent confirm + cancel — resolves as
   * last-writer-wins on the `deletionScheduledAt` column; this
   * function is the WRITE for the confirm side.
   */
  async confirm(input: {
    tenantId: string;
    actorUserId: string;
    token: string;
  }): Promise<ConfirmResult> {
    if (!input.token || typeof input.token !== 'string') {
      return { kind: 'missing' };
    }
    const tokenHash = hashToken(input.token);
    return this.prisma.runAsSuperAdmin(
      async (tx) => {
        const row = await tx.tenantDeletionToken.findUnique({
          where: { tokenHash },
        });
        if (!row) return { kind: 'missing' } as const;
        if (row.tenantId !== input.tenantId) {
          return { kind: 'tenant_mismatch' } as const;
        }
        if (row.consumedAt !== null) {
          return { kind: 'already_consumed' } as const;
        }
        if (row.expiresAt.getTime() <= Date.now()) {
          return { kind: 'expired' } as const;
        }

        const tenant = await tx.tenant.findUnique({
          where: { id: row.tenantId },
          select: { deletionScheduledAt: true },
        });
        if (!tenant) return { kind: 'missing' } as const;
        if (tenant.deletionScheduledAt !== null) {
          return { kind: 'tenant_already_scheduled' } as const;
        }

        const scheduledAt = new Date(
          Date.now() + this.cfg.config.coolOffDays * 24 * 60 * 60 * 1000,
        );
        await tx.tenantDeletionToken.update({
          where: { id: row.id },
          data: { consumedAt: new Date() },
        });
        await tx.tenant.update({
          where: { id: row.tenantId },
          data: {
            deletionScheduledAt: scheduledAt,
            deletionRequestedByUserId: input.actorUserId,
          },
        });

        await this.audit.recordWithin(tx, {
          action: PanoramaAuditAction.TenantDeleteConfirmed,
          resourceType: 'tenant',
          resourceId: row.tenantId,
          tenantId: row.tenantId,
          actorUserId: input.actorUserId,
          metadata: {
            confirmedByUserId: input.actorUserId,
            scheduledAt: scheduledAt.toISOString(),
            tokenKeyPrefix: row.tokenHash.slice(0, 8),
          },
        });

        return { kind: 'ok' as const, scheduledAt };
      },
      { reason: `tenant-deletion:confirm:${input.tenantId}` },
    );
  }

  /**
   * §7 cancel path — POST /tenants/:id/delete-cancel.
   * Idempotent: a cancel against an already-cancelled tenant
   * returns `noop` and does NOT emit a duplicate
   * `TenantDeleteCancelled` audit row (§7 race C).
   */
  async cancel(input: {
    tenantId: string;
    actorUserId: string;
  }): Promise<CancelResult> {
    return this.prisma.runAsSuperAdmin(
      async (tx) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: input.tenantId },
          select: { deletionScheduledAt: true },
        });
        if (!tenant || tenant.deletionScheduledAt === null) {
          return { kind: 'noop' as const };
        }
        const previouslyScheduledAt = tenant.deletionScheduledAt;
        await tx.tenant.update({
          where: { id: input.tenantId },
          data: {
            deletionScheduledAt: null,
            deletionRequestedByUserId: null,
          },
        });
        await this.audit.recordWithin(tx, {
          action: PanoramaAuditAction.TenantDeleteCancelled,
          resourceType: 'tenant',
          resourceId: input.tenantId,
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          metadata: {
            cancelledByUserId: input.actorUserId,
            previouslyScheduledAt: previouslyScheduledAt.toISOString(),
          },
        });
        return { kind: 'ok' as const, previouslyScheduledAt };
      },
      { reason: `tenant-deletion:cancel:${input.tenantId}` },
    );
  }

  /**
   * §7 veto path — POST /tenants/:id/delete-veto.
   *
   * Peer-Owner only in PR 3 (the platform-maintainer admin console
   * surface is deferred). Refuses if the vetoing Owner IS the
   * original requester — the requester cancels via /delete-cancel,
   * not by self-vetoing their own request. The peer-Owner check
   * is the §7 race B mitigation that surfaces compromised-credential
   * recovery in the audit trail with a distinct action label.
   */
  async veto(input: {
    tenantId: string;
    actorUserId: string;
  }): Promise<VetoResult> {
    return this.prisma.runAsSuperAdmin(
      async (tx) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: input.tenantId },
          select: {
            deletionScheduledAt: true,
            deletionRequestedByUserId: true,
          },
        });
        if (!tenant || tenant.deletionScheduledAt === null) {
          return { kind: 'noop' as const };
        }
        if (tenant.deletionRequestedByUserId === input.actorUserId) {
          return { kind: 'requester_self_veto_refused' as const };
        }
        const previouslyScheduledAt = tenant.deletionScheduledAt;
        await tx.tenant.update({
          where: { id: input.tenantId },
          data: {
            deletionScheduledAt: null,
            deletionRequestedByUserId: null,
          },
        });
        await this.audit.recordWithin(tx, {
          action: PanoramaAuditAction.TenantDeleteVeto,
          resourceType: 'tenant',
          resourceId: input.tenantId,
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          metadata: {
            vetoedByUserId: input.actorUserId,
            vetoSource: 'peer_owner',
            previouslyScheduledAt: previouslyScheduledAt.toISOString(),
          },
        });
        return { kind: 'ok' as const, previouslyScheduledAt };
      },
      { reason: `tenant-deletion:veto:${input.tenantId}` },
    );
  }

  /**
   * Cron purge entry. Finds tenants past their cool-off and
   * processes them serially. Bounded by `circuitBreaker` to avoid
   * an unbounded loop if many tenants come due at once.
   */
  async runPurgeBatch(circuitBreaker = 50): Promise<{ purged: number }> {
    const due = await this.prisma.runAsSuperAdmin(
      (tx) =>
        tx.tenant.findMany({
          where: { deletionScheduledAt: { lte: new Date() } },
          select: { id: true, slug: true, displayName: true },
          take: circuitBreaker,
        }),
      { reason: 'tenant-deletion:purge:list' },
    );
    let purged = 0;
    for (const tenant of due) {
      try {
        await this.purgeOne(tenant);
        purged += 1;
      } catch (err) {
        this.log.error(
          { tenantId: tenant.id, err: String(err) },
          'tenant_purge_failed',
        );
      }
    }
    return { purged };
  }

  private async purgeOne(tenant: {
    id: string;
    slug: string;
    displayName: string;
  }): Promise<void> {
    await this.prisma.runAsSuperAdmin(
      async (tx) => {
        // The cascade delete on `tenants` cascades into
        // `tenant_membership` (CASCADE FK), which would otherwise
        // fire the enforce_at_least_one_owner trigger (migration
        // 0005) — the trigger refuses any DELETE that takes the
        // active-owner count to zero. The §7 purge is the
        // legitimate "everything goes" path, so we set the trigger
        // bypass GUC inside this tx only (LOCAL → scoped to the tx
        // commit/rollback, no leak to other connections).
        await tx.$executeRawUnsafe(
          "SET LOCAL panorama.bypass_owner_check = 'on'",
        );

        const fresh = await tx.tenant.findUnique({
          where: { id: tenant.id },
          select: {
            id: true,
            slug: true,
            displayName: true,
            deletionScheduledAt: true,
            deletionRequestedByUserId: true,
            systemActorUserId: true,
          },
        });
        if (!fresh) return;
        if (
          fresh.deletionScheduledAt === null ||
          fresh.deletionScheduledAt.getTime() > Date.now()
        ) {
          // Tenant was cancelled/vetoed/rescheduled between the
          // list scan and this tx. Skip.
          return;
        }

        // Emit BEFORE the cascade so the row carries
        // tenantId = <the tenant about to disappear>. audit_events
        // has no FK to tenants, so the row survives the DELETE.
        await this.audit.recordWithin(tx, {
          action: PanoramaAuditAction.TenantDeleted,
          resourceType: 'tenant',
          resourceId: fresh.id,
          tenantId: fresh.id,
          actorUserId: fresh.deletionRequestedByUserId,
          metadata: {
            slug: fresh.slug,
            displayName: fresh.displayName,
            scheduledAt: fresh.deletionScheduledAt.toISOString(),
            requestedByUserId: fresh.deletionRequestedByUserId,
          },
        });

        // §7 cascade ordering. The schema has TWO classes of FK that
        // a single `DELETE tenant` cascade does NOT untangle on its
        // own:
        //
        //   (a) USER-SIDE RESTRICT (table.createdByUserId → users
        //       ON DELETE RESTRICT) — asset_maintenances,
        //       inspection_templates, blackout_slots. These block
        //       a direct `DELETE user` if the rows still exist.
        //   (b) INTRA-TENANT RESTRICT (table.fkColumn → otherTable
        //       inside the same tenant) — asset_models.categoryId
        //       → categories ON DELETE RESTRICT (migration 0001).
        //       Even though both tables CASCADE-delete from
        //       `tenants(id)`, PostgreSQL's cascade walker does not
        //       topologically sort the per-row deletes within ONE
        //       cascade pass, so the RESTRICT fires while the
        //       asset_models row still references the category
        //       row PG is trying to drop.
        //
        // Resolution — issue explicit `deleteMany` calls in reverse-
        // dependency order BEFORE the `DELETE tenant`, then null
        // systemActorUserId, then DELETE tenant, then DELETE user.
        // This is the same approach `resetTestDb` uses for the test
        // teardown; the ordering is a load-bearing invariant that
        // future tenant-scoped tables MUST extend here.
        const systemActorUserId = fresh.systemActorUserId;
        const tenantId = fresh.id;

        // Reverse-dependency delete inside the same tenant.
        // - Inspection chain: photos → responses → inspections →
        //   template_items → templates.
        // - Maintenance chain: photos → asset_maintenances.
        // - Reservation chain: reservations (depend on assets +
        //   users, but tenant-scoped).
        // - Asset chain: assets → asset_models → manufacturers →
        //   categories (asset_models.categoryId RESTRICT is the
        //   intra-tenant FK this ordering exists to satisfy).
        // - Domain: blackouts, invitations, PATs, notification
        //   events, memberships, signup/deletion artefacts.
        // audit_events stays — it's append-only with no FK to
        // tenants(id) and survives the purge intentionally (the
        // TenantDeleted row written above is part of that strand).
        await tx.inspectionPhoto.deleteMany({ where: { tenantId } });
        await tx.inspectionResponse.deleteMany({ where: { tenantId } });
        await tx.inspection.deleteMany({ where: { tenantId } });
        await tx.inspectionTemplateItem.deleteMany({ where: { tenantId } });
        await tx.inspectionTemplate.deleteMany({ where: { tenantId } });
        await tx.maintenancePhoto.deleteMany({ where: { tenantId } });
        await tx.assetMaintenance.deleteMany({ where: { tenantId } });
        await tx.reservation.deleteMany({ where: { tenantId } });
        await tx.asset.deleteMany({ where: { tenantId } });
        await tx.assetModel.deleteMany({ where: { tenantId } });
        await tx.manufacturer.deleteMany({ where: { tenantId } });
        await tx.category.deleteMany({ where: { tenantId } });
        await tx.blackoutSlot.deleteMany({ where: { tenantId } });
        await tx.invitation.deleteMany({ where: { tenantId } });
        await tx.personalAccessToken.deleteMany({ where: { tenantId } });
        await tx.notificationEvent.deleteMany({ where: { tenantId } });
        await tx.emailVerification.deleteMany({ where: { tenantId } });
        await tx.tenantDeletionToken.deleteMany({ where: { tenantId } });
        await tx.tenantMembership.deleteMany({ where: { tenantId } });

        if (systemActorUserId !== null) {
          // (a) drop the User→Tenant RESTRICT pointer so the system
          // user can be deleted after the tenant goes.
          await tx.tenant.update({
            where: { id: tenantId },
            data: { systemActorUserId: null },
          });
        }
        // With every tenant-scoped row gone, the tenant DELETE
        // succeeds. The remaining CASCADE FKs back from
        // tenant-orphan rows (none should exist after the loop
        // above) are a no-op.
        await tx.tenant.delete({ where: { id: tenantId } });
        if (systemActorUserId !== null) {
          // The system user's tenant_membership row was wiped in
          // the membership deleteMany above. With no remaining
          // RESTRICT FK referencing the user, the delete succeeds.
          await tx.user.delete({ where: { id: systemActorUserId } });
        }
      },
      { reason: `tenant-deletion:purge:${tenant.id}` },
    );
  }

  private generateToken(): { plaintext: string; tokenHash: string } {
    const plaintext = randomBytes(32).toString('base64url');
    return { plaintext, tokenHash: hashToken(plaintext) };
  }
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}
