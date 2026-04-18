import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service.js';
import { RateLimiter } from './rate-limiter.js';

/**
 * Thin Redis wrapper reused across the app — BullMQ uses its own
 * ioredis client under the hood, but rate limiting and other ad-hoc
 * caches share this singleton.
 *
 * Marked @Global so invitation / future modules don't need to import
 * the module chain; the two providers are small and dependency-free.
 */
@Global()
@Module({
  providers: [RedisService, RateLimiter],
  exports: [RedisService, RateLimiter],
})
export class RedisModule {}
