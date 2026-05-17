import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { getRequestSession } from '../auth/session.middleware.js';
import type { PanoramaSession } from '../auth/session.types.js';
import { TenantExportService } from './tenant-export.service.js';
import { TenantExportQueue } from './tenant-export.queue.js';

/**
 * ADR-0020 §8 — POST /tenants/:tenantId/export.
 *
 * Owner-only. Per-tenant rate-limit 1/24h via
 * `TenantExportService.checkRateLimit`. Trip returns 429 — the
 * caller is an authenticated Owner, so leaking rate-limit existence
 * via a 429 has operational value (vs the anonymous attacker
 * surface on /auth/signup where 429 leaks reconnaissance).
 *
 * Method is POST (not GET as ADR §8 says) because the action is
 * state-changing: every request enqueues a job, persists a
 * `tenant_exports` row, and emits an audit event. The ADR's
 * `GET` wording dates from an early sketch where the export was
 * synchronous; the async-via-queue amendment turned it into a
 * write. (Matches PR-3 deletion endpoints all using POST for the
 * same reason.)
 */

@Controller('tenants/:tenantId')
export class TenantExportController {
  private readonly log = new Logger('TenantExportController');

  constructor(
    private readonly exports: TenantExportService,
    private readonly queue: TenantExportQueue,
  ) {}

  @Post('export')
  @HttpCode(202)
  async export(
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
  ): Promise<unknown> {
    const session = this.requireOwner(req, tenantId);

    const rate = await this.exports.checkRateLimit(tenantId);
    if (!rate.allowed) {
      throw new HttpException(
        { error: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const enqueue = await this.exports.enqueue({
      tenantId,
      requestedByUserId: session.userId,
    });
    if (enqueue.kind !== 'ok') {
      // The rate-limit branch is the only refusal path today.
      // Reserved for future shapes (e.g. tenant locked).
      this.log.warn({ tenantId, kind: enqueue.kind }, 'tenant_export_enqueue_unexpected');
      throw new HttpException(
        { error: 'enqueue_failed' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // BullMQ enqueue is best-effort — if the queue isn't running
    // (e.g. test mode), the job stays in `queued` status and the
    // caller's e2e test invokes `runJob` directly. Production
    // failure surfaces as a logged warning + the job staying
    // queued; the next worker restart picks it up.
    try {
      await this.queue.enqueue({ jobId: enqueue.jobId });
    } catch (err) {
      this.log.warn(
        { jobId: enqueue.jobId, err: String(err) },
        'tenant_export_queue_enqueue_skipped',
      );
    }

    return {
      ok: true,
      jobId: enqueue.jobId,
      status: 'queued',
    };
  }

  /**
   * §8 PR-4 amendment — session-gated download. The completion
   * email links HERE (not directly to the S3 URL); this endpoint
   * verifies the Owner session, mints a short-lived (60s) presigned
   * URL, and 302-redirects. Middlebox-class adversaries (Mimecast,
   * link-preview bots) that GET the link unauthenticated hit 401
   * and cache that, never the file. The Owner's browser carries the
   * session cookie and follows the redirect transparently.
   */
  @Get('exports/:jobId/download')
  async download(
    @Param('tenantId') tenantId: string,
    @Param('jobId') jobId: string,
    @Req() req: Request,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    this.requireOwner(req, tenantId);
    const row = await this.exports.getDownloadable(tenantId, jobId);
    if (!row) {
      throw new NotFoundException('export_not_found_or_expired');
    }
    const filename = `panorama-export-${jobId}.json.gz`;
    const signedUrl = await this.exports.mintDownloadUrl({
      tenantId,
      objectKey: row.objectKey,
      filename,
    });
    // 302 to the freshly-minted presigned URL — TTL 60s, enough for
    // the browser to follow the redirect once. The URL never enters
    // any persistence path.
    res.redirect(302, signedUrl);
  }

  private requireOwner(req: Request, tenantId: string): PanoramaSession {
    const session = getRequestSession(req);
    if (!session) throw new UnauthorizedException('authentication_required');
    if (session.currentTenantId !== tenantId) {
      throw new UnauthorizedException('tenant_mismatch');
    }
    if (session.currentRole !== 'owner') {
      throw new ForbiddenException('owner_role_required');
    }
    return session;
  }
}
