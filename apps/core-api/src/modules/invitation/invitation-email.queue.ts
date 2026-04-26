import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, QueueEvents, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailService } from '../email/email.service.js';
import { InvitationService } from './invitation.service.js';
import { InvitationConfigService } from './invitation.config.js';
import {
  renderInvitationEmail,
  type SupportedLocale,
} from './invitation-email.templates.js';
import type { InvitationQueuePort } from './invitation.queue.js';

/**
 * BullMQ-backed implementation of the invitation email pipeline.
 *
 * Two named queues + workers run out of this module:
 *
 *   * `invitation-email` — per-invitation job that fetches the row,
 *     renders the trilingual email, sends via EmailService, then calls
 *     back into InvitationService to record outbox state + audit. Up
 *     to 5 attempts with exponential backoff matching the ADR.
 *
 *   * `invitation-maintenance` — repeatable hourly job that
 *        (a) emits `panorama.invitation.expired` audit events for any
 *            invitations past expiresAt
 *        (b) rescues invitations stuck in `emailQueuedAt != null,
 *            emailSentAt == null, emailAttempts == 0` — cases where
 *            the initial enqueue was lost (crash between tx commit
 *            and the in-process `queue.add`). Rescue rotates the
 *            token because plaintext was never durably stored.
 */

const EMAIL_QUEUE = 'invitation-email';
const MAINTENANCE_QUEUE = 'invitation-maintenance';
const MAINTENANCE_JOB = 'sweep';

interface InvitationEmailJobData {
  invitationId: string;
  /**
   * Tenant the invitation belongs to. Threaded through the payload so
   * the worker callbacks (`markEmailSent`, `markEmailFailed`,
   * `rotateTokenForRescue`) can run under `runInTenant` instead of
   * `runAsSuperAdmin` — closes a #56 follow-up (issue #115).
   *
   * Old-shape jobs queued before this field landed are tolerated:
   * `runEmailJob` falls back to a privileged read for tenantId
   * resolution when this field is absent. Pre-pilot we have no
   * persistent queue volume; this fallback exists so a rolling deploy
   * doesn't drop in-flight jobs.
   */
  tenantId?: string;
  /** Plaintext token — present only for the duration of the job. */
  plaintextToken: string;
}

@Injectable()
export class BullMqInvitationQueue
  implements InvitationQueuePort, OnModuleInit, OnModuleDestroy
{
  private readonly log = new Logger('BullMqInvitationQueue');
  private emailQueue!: Queue<InvitationEmailJobData>;
  private maintenanceQueue!: Queue<Record<string, never>>;
  private emailWorker!: Worker<InvitationEmailJobData>;
  private maintenanceWorker!: Worker<Record<string, never>>;
  private emailQueueEvents!: QueueEvents;
  private connections: Redis[] = [];

  constructor(
    private readonly invitations: InvitationService,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly invitationCfg: InvitationConfigService,
  ) {}

  // --- InvitationQueuePort -------------------------------------------

  async enqueueDelivery(
    invitationId: string,
    tenantId: string,
    plaintextToken: string,
  ): Promise<void> {
    await this.emailQueue.add(
      'send',
      { invitationId, tenantId, plaintextToken },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 60_000 }, // 1m, 2m, 4m, 8m, 16m
        removeOnComplete: { age: 60 * 60, count: 500 },
        removeOnFail: { age: 24 * 60 * 60, count: 500 },
      },
    );
  }

  // --- Lifecycle ------------------------------------------------------

  async onModuleInit(): Promise<void> {
    const connection = this.makeConnection();
    this.emailQueue = new Queue(EMAIL_QUEUE, { connection });
    this.maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection });
    this.emailQueueEvents = new QueueEvents(EMAIL_QUEUE, {
      connection: this.makeConnection(),
    });

    this.emailWorker = new Worker<InvitationEmailJobData>(
      EMAIL_QUEUE,
      async (job) => this.runEmailJob(job),
      { connection: this.makeConnection(), concurrency: 4 },
    );
    this.emailWorker.on('failed', (job, err) => {
      const attemptsMade = job?.attemptsMade ?? 0;
      const attemptsAllowed = job?.opts?.attempts ?? 5;
      const terminal = attemptsMade >= attemptsAllowed;
      const invitationId = (job?.data)?.invitationId;
      const tenantId = (job?.data)?.tenantId;
      if (!invitationId) return;
      // Resolve a tenantId for old-shape jobs that landed before #115.
      const resolveTenantId = tenantId
        ? Promise.resolve(tenantId)
        : this.lookupTenantId(invitationId);
      resolveTenantId
        .then((tid) => {
          if (!tid) {
            this.log.warn(
              { invitationId },
              'markEmailFailed_skipped_missing_tenantid',
            );
            return undefined;
          }
          return this.invitations.markEmailFailed(
            invitationId,
            tid,
            String(err?.message ?? err ?? 'unknown_error'),
            terminal,
          );
        })
        .catch((markErr: unknown) =>
          this.log.warn({ invitationId, err: String(markErr) }, 'markEmailFailed_error'),
        );
    });

    this.maintenanceWorker = new Worker<Record<string, never>>(
      MAINTENANCE_QUEUE,
      async () => this.runMaintenance(),
      { connection: this.makeConnection() },
    );

    // Hourly maintenance. BullMQ dedupes on jobId so a restart doesn't
    // spawn parallel schedulers.
    await this.maintenanceQueue.add(MAINTENANCE_JOB, {}, {
      repeat: { every: 60 * 60 * 1000 },
      jobId: MAINTENANCE_JOB,
    });
  }

  async onModuleDestroy(): Promise<void> {
    const closers: Array<Promise<unknown>> = [];
    if (this.emailWorker) closers.push(this.emailWorker.close());
    if (this.maintenanceWorker) closers.push(this.maintenanceWorker.close());
    if (this.emailQueueEvents) closers.push(this.emailQueueEvents.close());
    if (this.emailQueue) closers.push(this.emailQueue.close());
    if (this.maintenanceQueue) closers.push(this.maintenanceQueue.close());
    await Promise.allSettled(closers);
    for (const conn of this.connections) {
      try {
        await conn.quit();
      } catch (err) {
        this.log.debug({ err: String(err) }, 'connection_quit_error');
      }
    }
    this.connections = [];
  }

  // --- Job runners ---------------------------------------------------

  private async runEmailJob(job: Job<InvitationEmailJobData>): Promise<void> {
    const { invitationId, plaintextToken } = job.data;

    // tenantId rides in the payload now (#115). For backward compat
    // with jobs queued by the prior shape (no rolling-deploy job loss),
    // resolve it from the row when missing.
    let tenantId = job.data.tenantId;
    if (!tenantId) {
      const fallback = await this.lookupTenantId(invitationId);
      if (!fallback) {
        this.log.warn({ invitationId }, 'invitation_missing_skipping');
        return;
      }
      tenantId = fallback;
      this.log.warn(
        { invitationId, tenantId },
        'invitation_email_legacy_payload_shape_resolved_tenantid',
      );
    }

    const invitation = await this.prisma.runInTenant(tenantId, (tx) =>
      tx.invitation.findUnique({
        where: { id: invitationId },
        include: {
          tenant: { select: { displayName: true, locale: true } },
          invitedBy: { select: { displayName: true, email: true } },
        },
      }),
    );
    if (!invitation) {
      this.log.warn({ invitationId, tenantId }, 'invitation_missing_skipping');
      return;
    }
    if (invitation.revokedAt || invitation.acceptedAt) {
      this.log.debug(
        { invitationId, state: invitation.revokedAt ? 'revoked' : 'accepted' },
        'invitation_no_longer_pending',
      );
      return;
    }
    if (invitation.emailSentAt) {
      // Idempotent: email already sent (job replay / retry post-success).
      return;
    }

    const locale = normalizeLocale(invitation.tenant.locale);
    const acceptUrl = `${this.invitationCfg.acceptBaseUrl}?t=${encodeURIComponent(plaintextToken)}`;
    const rendered = renderInvitationEmail({
      locale,
      recipientEmail: invitation.email,
      tenantDisplayName: invitation.tenant.displayName,
      inviterDisplayName: invitation.invitedBy.displayName,
      role: invitation.role,
      acceptUrl,
      expiresAt: invitation.expiresAt,
    });

    await this.email.send({
      to: invitation.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });

    await this.invitations.markEmailSent(invitation.id, tenantId);
  }

  /**
   * Cluster-wide invitation -> tenantId lookup. Used only as a fallback
   * for legacy-shape BullMQ jobs that landed before #115 wired tenantId
   * into the payload. The cross-tenant read justifies `runAsSuperAdmin`
   * — same architectural escape pattern the inspection-maintenance
   * sweep uses.
   */
  private async lookupTenantId(invitationId: string): Promise<string | null> {
    return this.prisma.runAsSuperAdmin(
      async (tx) => {
        const row = await tx.invitation.findUnique({
          where: { id: invitationId },
          select: { tenantId: true },
        });
        return row?.tenantId ?? null;
      },
      { reason: `invitation-email:lookup-tenantid:${invitationId}` },
    );
  }

  private async runMaintenance(): Promise<void> {
    const expired = await this.invitations.sweepExpired();
    if (expired > 0) this.log.log({ expired }, 'maintenance_swept');

    // Rescue stuck-at-queued invitations. These are rows where the
    // initial `queue.add` never landed (crash between tx commit and
    // enqueue). Only pick rows created more than 60s ago so we don't
    // race the happy-path enqueue in-flight.
    // Cluster-wide rescue scan — legitimate cross-tenant read for the
    // maintenance sweep, same architectural escape pattern as
    // inspection-maintenance. Per-row rescue work below runs under
    // `runInTenant` with the tenantId pulled out of this query.
    const stuck = await this.prisma.runAsSuperAdmin(
      (tx) =>
        tx.invitation.findMany({
          where: {
            acceptedAt: null,
            revokedAt: null,
            emailQueuedAt: { not: null },
            emailSentAt: null,
            emailAttempts: 0,
            createdAt: { lt: new Date(Date.now() - 60_000) },
          },
          select: { id: true, tenantId: true },
          take: 100,
        }),
      { reason: 'invitation-email:rescue-query' },
    );
    let rescued = 0;
    for (const row of stuck) {
      try {
        const rotated = await this.invitations.rotateTokenForRescue(row.id, row.tenantId);
        if (rotated) {
          await this.enqueueDelivery(row.id, row.tenantId, rotated.plaintext);
          rescued++;
        }
      } catch (err) {
        this.log.warn({ invitationId: row.id, err: String(err) }, 'rescue_enqueue_failed');
      }
    }
    if (rescued > 0) this.log.log({ rescued }, 'maintenance_rescued');
  }

  private makeConnection(): Redis {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379/0';
    const conn = new Redis(url, {
      lazyConnect: false,
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    });
    this.connections.push(conn);
    return conn;
  }
}

function normalizeLocale(locale: string | undefined): SupportedLocale {
  const l = (locale ?? 'en').toLowerCase();
  if (l.startsWith('pt')) return 'pt-br';
  if (l.startsWith('es')) return 'es';
  return 'en';
}
