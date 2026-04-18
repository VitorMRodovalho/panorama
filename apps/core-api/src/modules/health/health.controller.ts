import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness + readiness in one endpoint.
   * - `ok`: server is up
   * - `db`: Prisma can round-trip a `SELECT 1`
   * - `uptime_s`: seconds since this process started
   *
   * Kept deliberately cheap — no tenant context, no DB migrations check.
   * A Kubernetes liveness probe should target `/health`; a readiness
   * probe should target `/health/ready` (to be added with migrations check).
   */
  @Get()
  async check(): Promise<{
    ok: boolean;
    db: 'up' | 'down';
    uptime_s: number;
    version: string;
  }> {
    let db: 'up' | 'down' = 'down';
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      db = 'up';
    } catch {
      // intentionally swallow — the response itself reports "down"
    }
    return {
      ok: db === 'up',
      db,
      uptime_s: Math.floor((Date.now() - this.startedAt) / 1000),
      version: process.env.APP_VERSION ?? '0.0.0-dev',
    };
  }
}
