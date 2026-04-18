import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';

/**
 * Lazy-connected ioredis singleton. Connection URL comes from
 * `REDIS_URL` (e.g. `redis://localhost:6379/0`).
 *
 * `enableReadyCheck: false` and `maxRetriesPerRequest: null` are the
 * BullMQ-recommended defaults — keeping them here means a single client
 * pattern works for both worker and app-side usage. We do NOT share the
 * same Redis instance between queue producers and queue workers;
 * BullMQ constructs its own (see invitation queue module).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly log = new Logger('RedisService');
  private _client: Redis | null = null;

  get client(): Redis {
    if (this._client) return this._client;
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379/0';
    const opts: RedisOptions = {
      lazyConnect: false,
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    };
    const client = new Redis(url, opts);
    client.on('error', (err: Error) => this.log.warn({ err: String(err) }, 'redis_error'));
    this._client = client;
    return client;
  }

  /** Close the connection on shutdown. Idempotent. */
  async onModuleDestroy(): Promise<void> {
    if (!this._client) return;
    try {
      await this._client.quit();
    } catch (err) {
      this.log.warn({ err: String(err) }, 'redis_quit_error');
    } finally {
      this._client = null;
    }
  }
}
