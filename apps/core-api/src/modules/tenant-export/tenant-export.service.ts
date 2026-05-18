import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PanoramaAuditAction } from '../audit/audit-actions.js';
import { EmailService } from '../email/email.service.js';
import { RateLimiter, type RateLimitDecision } from '../redis/rate-limiter.js';
import { ObjectStorageService } from '../object-storage/object-storage.service.js';
import { tenantExportKey } from '../object-storage/object-storage.keys.js';
import { TenantExportConfigService } from './tenant-export.config.js';
import {
  exportToJsonString,
  serializeTenantExport,
} from './tenant-export.serializer.js';
import { renderExportReadyEmail } from './tenant-export.templates.js';

/**
 * Tenant-data export service (ADR-0020 §8).
 *
 *   - `checkRateLimit` — 1 export per tenant per 24h, fail-closed.
 *   - `enqueue` — atomic write: insert `tenant_exports` row (status
 *     queued) + emit `TenantExportRequested` audit. Returns the
 *     jobId; the BullMQ worker picks up from there.
 *   - `runJob` — worker entrypoint: serialize → gzip → upload → mint
 *     signed URL → send email → flip status + emit
 *     `TenantExported`. SMTP failure is logged but does NOT
 *     rollback the row (the audit row preserves the objectKey so
 *     operators can re-mint the signed URL).
 *
 * The §8 contract on the audit-row content is non-negotiable: the
 * row records `objectKey` + recipient hash + TTL, NEVER the signed
 * URL itself (which embeds AWS credentials in query params).
 */

const RATE_LIMIT_LIMIT = 1;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_KEY_PREFIX = 'panorama:export:tenant:';

export type EnqueueResult =
  | { kind: 'ok'; jobId: string }
  | { kind: 'rate_limited' };

@Injectable()
export class TenantExportService {
  private readonly log = new Logger('TenantExportService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: EmailService,
    private readonly storage: ObjectStorageService,
    private readonly limiter: RateLimiter,
    private readonly cfg: TenantExportConfigService,
  ) {}

  /**
   * Per-tenant 1/24h budget. Fail-closed.
   */
  async checkRateLimit(tenantId: string): Promise<RateLimitDecision> {
    return this.limiter.consume(
      RATE_LIMIT_KEY_PREFIX + tenantId,
      RATE_LIMIT_LIMIT,
      RATE_LIMIT_WINDOW_MS,
    );
  }

  /**
   * Enqueue an export job. The caller is responsible for the rate-
   * limit check via `checkRateLimit` first (so a refused request
   * emits its own `rate_limit_tripped`-style audit if that becomes
   * a future requirement; today we just refuse with 429 from the
   * controller).
   */
  async enqueue(input: {
    tenantId: string;
    requestedByUserId: string;
  }): Promise<EnqueueResult> {
    const jobId = await this.prisma.runAsSuperAdmin(
      async (tx) => {
        const row = await tx.tenantExport.create({
          data: {
            tenantId: input.tenantId,
            requestedByUserId: input.requestedByUserId,
            status: 'queued',
          },
        });
        await this.audit.recordWithin(tx, {
          action: PanoramaAuditAction.TenantExportRequested,
          resourceType: 'tenant',
          resourceId: input.tenantId,
          tenantId: input.tenantId,
          actorUserId: input.requestedByUserId,
          metadata: {
            jobId: row.id,
            requestedByUserId: input.requestedByUserId,
          },
        });
        return row.id;
      },
      { reason: `tenant-export:enqueue:${input.tenantId}` },
    );
    return { kind: 'ok', jobId };
  }

  /**
   * Worker entrypoint — runs the actual export. Splits into
   * smaller helpers for testability without exposing the BullMQ
   * dependency.
   */
  async runJob(jobId: string): Promise<void> {
    const job = await this.prisma.runAsSuperAdmin(
      (tx) => tx.tenantExport.findUnique({ where: { id: jobId } }),
      { reason: `tenant-export:run:${jobId}:fetch` },
    );
    if (!job) {
      this.log.warn({ jobId }, 'tenant_export_job_missing');
      return;
    }
    if (job.status !== 'queued') {
      // Re-runs (cron retry / BullMQ replay) hit this branch — the
      // first attempt already advanced past `queued`. Idempotent
      // no-op.
      this.log.log({ jobId, status: job.status }, 'tenant_export_job_not_queued');
      return;
    }

    // Mark processing in a separate tx so concurrent workers can
    // see the transition and back off. We could use a row-level
    // lock instead but BullMQ already serialises by job id; this
    // is belt-and-suspenders.
    await this.prisma.runAsSuperAdmin(
      (tx) =>
        tx.tenantExport.update({
          where: { id: jobId },
          data: { status: 'processing' },
        }),
      { reason: `tenant-export:run:${jobId}:processing` },
    );

    let result;
    try {
      result = await this.executeExport(job.tenantId, jobId);
      await this.markCompleted(jobId, result);
    } catch (err) {
      const errKind = err instanceof Error ? err.name : 'Unknown';
      this.log.error({ err: String(err), jobId }, 'tenant_export_run_failed');
      await this.markFailed(jobId, errKind);
      return;
    }

    // Email dispatch lives outside the export-failure catch (issue
    // #228). Before this fix, a throw from `lookupJobIdByObjectKey`
    // or any other path inside `dispatchEmail` that bypassed its own
    // inner try/catch would propagate up to the outer catch and call
    // `markFailed` — overwriting a `completed` row even though the
    // export file was already uploaded to S3. The tenant would see
    // "failed" in the UI while the file sat in the bucket with no
    // surface to retrieve it.
    //
    // After this fix, an email-side error logs a warn and emits the
    // already-existing `tenant_export_email_dispatch_failed` audit
    // row (per `dispatchEmail`'s inner catch). The row stays
    // `completed`; the tenant can still download the export.
    try {
      const refetched = await this.prisma.runAsSuperAdmin(
        (tx) => tx.tenantExport.findUnique({ where: { id: jobId } }),
        { reason: `tenant-export:run:${jobId}:refetch` },
      );
      if (refetched) {
        await this.dispatchEmail(refetched, result);
      }
    } catch (err) {
      this.log.warn(
        { err: String(err), jobId },
        'tenant_export_email_failed_but_completed',
      );
    }
  }

  private async executeExport(
    tenantId: string,
    jobId: string,
  ): Promise<{
    objectKey: string;
    objectSizeBytes: number;
    expiresAt: Date;
    recipientEmail: string;
    recipientDisplayName: string;
    tenantDisplayName: string;
  }> {
    // Snapshot-consistent read of every tenant-scoped table.
    const doc = await this.prisma.runAsSuperAdmin(
      (tx) => serializeTenantExport(tx, tenantId, this.log),
      { reason: `tenant-export:serialize:${tenantId}` },
    );
    const json = exportToJsonString(doc);
    const gzipped = gzipSync(Buffer.from(json, 'utf8'));
    const sha256 = createHash('sha256').update(gzipped).digest('base64');
    const objectKey = tenantExportKey(tenantId, jobId);

    await this.storage.put(objectKey, gzipped, {
      contentType: 'application/gzip',
      sha256,
      tenantId,
    });

    const expiresAt = new Date(
      Date.now() + this.cfg.config.windowSeconds * 1000,
    );

    // Resolve the recipient — the requestedBy user OR a fallback if
    // the row's user was deleted between request and run. The
    // tenant's display name comes from the snapshot the serializer
    // already loaded.
    const recipient = await this.prisma.runAsSuperAdmin(
      async (tx) => {
        const row = await tx.tenantExport.findUnique({
          where: { id: jobId },
          select: {
            requestedBy: { select: { email: true, displayName: true } },
            tenant: { select: { displayName: true } },
          },
        });
        return {
          email: row?.requestedBy?.email ?? '',
          displayName: row?.requestedBy?.displayName ?? 'Owner',
          tenantDisplayName: row?.tenant?.displayName ?? 'your tenant',
        };
      },
      { reason: `tenant-export:recipient:${jobId}` },
    );

    return {
      objectKey,
      objectSizeBytes: gzipped.byteLength,
      expiresAt,
      recipientEmail: recipient.email,
      recipientDisplayName: recipient.displayName,
      tenantDisplayName: recipient.tenantDisplayName,
    };
  }

  private async markCompleted(
    jobId: string,
    result: {
      objectKey: string;
      objectSizeBytes: number;
      expiresAt: Date;
      recipientEmail: string;
    },
  ): Promise<void> {
    await this.prisma.runAsSuperAdmin(
      async (tx) => {
        const row = await tx.tenantExport.update({
          where: { id: jobId },
          data: {
            status: 'completed',
            objectKey: result.objectKey,
            objectSizeBytes: BigInt(result.objectSizeBytes),
            expiresAt: result.expiresAt,
            completedAt: new Date(),
          },
        });
        await this.audit.recordWithin(tx, {
          action: PanoramaAuditAction.TenantExported,
          resourceType: 'tenant',
          resourceId: row.tenantId,
          tenantId: row.tenantId,
          actorUserId: row.requestedByUserId,
          // §8 contract: objectKey + TTL + recipient hash; NEVER the
          // signed URL (which embeds AWS credentials).
          metadata: {
            jobId,
            objectKey: result.objectKey,
            objectSizeBytes: result.objectSizeBytes,
            windowSeconds: this.cfg.config.windowSeconds,
            recipientHash: result.recipientEmail
              ? createHash('sha256').update(result.recipientEmail).digest('hex').slice(0, 8)
              : 'no-recipient',
          },
        });
      },
      { reason: `tenant-export:complete:${jobId}` },
    );
  }

  private async markFailed(jobId: string, errKind: string): Promise<void> {
    await this.prisma.runAsSuperAdmin(
      async (tx) => {
        const row = await tx.tenantExport.update({
          where: { id: jobId },
          data: { status: 'failed', failedReason: errKind },
        });
        await this.audit.recordWithin(tx, {
          action: PanoramaAuditAction.TenantExportFailed,
          resourceType: 'tenant',
          resourceId: row.tenantId,
          tenantId: row.tenantId,
          actorUserId: row.requestedByUserId,
          metadata: { jobId, errKind },
        });
      },
      { reason: `tenant-export:fail:${jobId}` },
    );
  }

  private async dispatchEmail(
    job: {
      tenantId: string;
      requestedByUserId: string | null;
      objectKey: string | null;
      expiresAt: Date | null;
      objectSizeBytes: bigint | null;
    },
    result: {
      objectKey: string;
      objectSizeBytes: number;
      expiresAt: Date;
      recipientEmail: string;
      recipientDisplayName: string;
      tenantDisplayName: string;
    },
  ): Promise<void> {
    if (!result.recipientEmail) {
      this.log.warn(
        { tenantId: job.tenantId },
        'tenant_export_email_skipped_no_recipient',
      );
      return;
    }
    // §8 PR 4 amendment — email links to the Panorama download
    // endpoint, NOT a presigned S3 URL. Middlebox prefetch will hit
    // 401 (no session) and cache that, not the file bytes.
    const jobIdForUrl = await this.lookupJobIdByObjectKey(result.objectKey);
    if (!jobIdForUrl) {
      // Defensive — the row must exist by this point. Log + skip
      // rather than throw, so the caller's tx-completion state
      // doesn't get unwound.
      this.log.error(
        { tenantId: job.tenantId, objectKey: result.objectKey },
        'tenant_export_email_skipped_no_job_id',
      );
      return;
    }
    const downloadUrl =
      `${this.cfg.config.manageUrlBase}/tenants/${job.tenantId}` +
      `/exports/${jobIdForUrl}/download`;
    const rendered = renderExportReadyEmail({
      recipientEmail: result.recipientEmail,
      recipientDisplayName: result.recipientDisplayName,
      tenantDisplayName: result.tenantDisplayName,
      downloadUrl,
      expiresAt: result.expiresAt,
      objectSizeBytes: result.objectSizeBytes,
    });
    try {
      await this.mail.send({
        to: result.recipientEmail,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
    } catch (err) {
      // Audit the dispatch failure so SIEM + tenant admins can spot
      // the "uploaded but never delivered" state without grepping
      // logs. The recipient is HASHED in both the audit row and
      // the log line (PRs 2 + 3 pattern).
      const errKind = err instanceof Error ? err.name : 'Unknown';
      const recipientHash = createHash('sha256')
        .update(result.recipientEmail)
        .digest('hex')
        .slice(0, 8);
      this.log.error(
        { err: String(err), recipientHash },
        'tenant_export_email_dispatch_failed',
      );
      try {
        await this.audit.record({
          action: PanoramaAuditAction.TenantExportEmailDispatchFailed,
          resourceType: 'tenant',
          resourceId: job.tenantId,
          tenantId: job.tenantId,
          actorUserId: job.requestedByUserId,
          metadata: { jobId: jobIdForUrl, errKind, recipientHash },
        });
      } catch (auditErr) {
        this.log.error(
          { err: String(auditErr) },
          'tenant_export_email_dispatch_failed_audit_write_failed',
        );
      }
    }
  }

  private async lookupJobIdByObjectKey(objectKey: string): Promise<string | null> {
    const row = await this.prisma.runAsSuperAdmin(
      (tx) =>
        tx.tenantExport.findFirst({
          where: { objectKey },
          select: { id: true },
        }),
      { reason: `tenant-export:lookup-job-id` },
    );
    return row?.id ?? null;
  }

  /**
   * Internal helper used by the download endpoint: mint a short-
   * lived presigned URL (60s) for the actual S3 GET. Called only
   * AFTER the controller has verified the Owner session, the job
   * is `completed`, and `expiresAt > now()`. The 60s TTL is just
   * long enough for the browser to follow the 302; never enters
   * email, audit, or log.
   */
  async mintDownloadUrl(input: {
    tenantId: string;
    objectKey: string;
    filename: string;
  }): Promise<string> {
    return this.storage.getSignedUrl(input.objectKey, {
      tenantId: input.tenantId,
      expiresIn: this.cfg.config.downloadUrlTtlSeconds,
      responseContentType: 'application/gzip',
      responseContentDisposition: `attachment; filename="${input.filename}"`,
    });
  }

  /**
   * Look up a completed export for the session-gated download
   * endpoint. Returns the row only when it is still within the
   * `windowSeconds` budget — past `expiresAt`, the email's link
   * stops resolving and operators must re-request.
   */
  async getDownloadable(
    tenantId: string,
    jobId: string,
  ): Promise<{ objectKey: string; objectSizeBytes: number | null } | null> {
    return this.prisma.runAsSuperAdmin(
      async (tx) => {
        const row = await tx.tenantExport.findUnique({ where: { id: jobId } });
        if (!row) return null;
        if (row.tenantId !== tenantId) return null;
        if (row.status !== 'completed') return null;
        if (row.objectKey === null) return null;
        if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
        return {
          objectKey: row.objectKey,
          objectSizeBytes:
            row.objectSizeBytes !== null ? Number(row.objectSizeBytes) : null,
        };
      },
      { reason: `tenant-export:get-downloadable:${jobId}` },
    );
  }
}
