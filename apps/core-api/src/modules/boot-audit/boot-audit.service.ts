/**
 * Boot-time audit emitter (ADR-0015 §4).
 *
 * Per the security-reviewer ADR-0013 review concern: a deploy that
 * accidentally points the appClient at a privileged URL (or vice
 * versa) silently breaks the v2 trust boundary. Auditing the
 * connection identity at boot lets ops detect the misconfiguration
 * from the audit chain — `panorama.boot.db_pool_configured` records
 * which Postgres role each client connected as. **Never logs the URL
 * or password — only the role + host + port.**
 *
 * `panorama.boot.redis_configured` does the same for the Redis
 * connection so `rediss://` (TLS) vs `redis://` (plaintext) is
 * visible from the audit stream — security-reviewer wanted
 * verify-full TLS for the egress to Upstash, this audit pins it.
 *
 * Skipped in NODE_ENV=test to keep the audit_events table clean for
 * test assertions; the service has no other side-effects so a test
 * skip is safe.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { URL } from 'node:url';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

@Injectable()
export class BootAuditService implements OnModuleInit {
  private readonly log = new Logger('BootAuditService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    // Reference the prisma field so the linter doesn't flag it as
    // unused — we depend on PrismaModule being initialised before we
    // emit audits (the audit-write path itself uses PrismaService),
    // which is what this constructor injection enforces.
    void this.prisma;
  }

  async onModuleInit(): Promise<void> {
    if (process.env['NODE_ENV'] === 'test') {
      // Skip — keeps audit_events table clean for test assertions.
      return;
    }
    try {
      await this.recordDbPoolAudits();
    } catch (err) {
      this.log.warn({ err: String(err) }, 'db_pool_boot_audit_failed');
    }
    try {
      await this.recordRedisAudit();
    } catch (err) {
      this.log.warn({ err: String(err) }, 'redis_boot_audit_failed');
    }
  }

  // ----------------------------------------------------------------

  private async recordDbPoolAudits(): Promise<void> {
    const appUrl = process.env['DATABASE_URL'];
    const privUrl = process.env['DATABASE_PRIVILEGED_URL'];

    if (appUrl) {
      const meta = parsePostgresUrl(appUrl);
      await this.audit.record({
        action: 'panorama.boot.db_pool_configured',
        resourceType: 'db_pool',
        resourceId: 'app',
        tenantId: null,
        actorUserId: null,
        metadata: {
          client: 'app',
          role: meta.user,
          host: meta.host,
          port: meta.port,
          // Never include URL or password — security-reviewer hard-rule.
        },
      });
    }

    if (privUrl) {
      // Even when privUrl === appUrl (dev fallback), record the second
      // boot row so the audit chain shows BOTH pools. In prod the
      // PrismaService boot guard refuses identical URLs.
      const meta = parsePostgresUrl(privUrl);
      await this.audit.record({
        action: 'panorama.boot.db_pool_configured',
        resourceType: 'db_pool',
        resourceId: 'privileged',
        tenantId: null,
        actorUserId: null,
        metadata: {
          client: 'privileged',
          role: meta.user,
          host: meta.host,
          port: meta.port,
          sameAsAppClient: privUrl === appUrl,
        },
      });
    }
  }

  private async recordRedisAudit(): Promise<void> {
    const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379/0';
    const u = new URL(url);
    const scheme = u.protocol.replace(':', '');
    await this.audit.record({
      action: 'panorama.boot.redis_configured',
      resourceType: 'redis',
      resourceId: null,
      tenantId: null,
      actorUserId: null,
      metadata: {
        scheme,
        host: u.hostname,
        port: u.port || (scheme === 'rediss' ? '6379' : '6379'),
        tlsMode: scheme === 'rediss' ? 'tls' : 'plaintext',
        // Production check: surface a flag so an alert can fire on
        // plaintext-Redis-in-production deploys.
        warnPlaintextInProd:
          scheme === 'redis' && process.env['NODE_ENV'] === 'production',
      },
    });
  }
}

/**
 * Best-effort URL parse. Works for `postgres://`, `postgresql://`,
 * and most managed-Postgres connection strings. Returns sentinels
 * if the URL is malformed — never throws (boot path).
 */
function parsePostgresUrl(raw: string): { user: string; host: string; port: string } {
  try {
    const u = new URL(raw);
    return {
      user: decodeURIComponent(u.username) || 'unknown',
      host: u.hostname || 'unknown',
      port: u.port || '5432',
    };
  } catch {
    return { user: 'unparseable', host: 'unparseable', port: 'unparseable' };
  }
}
