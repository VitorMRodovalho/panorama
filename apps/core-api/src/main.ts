import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { resolveTrustProxyHops } from './bootstrap/trust-proxy-hops.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // Trust N proxy hops in front of core-api. Default 1 matches the
  // hosted instance (Fly edge → app). Self-hosters running behind
  // additional layers (CDN + LB + app) MUST set TRUST_PROXY_HOPS to
  // the exact hop count — see docs/runbooks/secrets-inventory.md.
  //
  // Without a correct value, req.ip resolves to the wrong layer and
  // the ThrottlerGuard buckets every request from one IP — fail-
  // united, not fail-closed. ADR-0020 §4 makes this contract explicit
  // because the self-serve signup endpoint relies on per-IP buckets.
  app.set('trust proxy', resolveTrustProxyHops(process.env));

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'connect-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
        },
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  new Logger('bootstrap').log(`Panorama core-api listening on :${port}`);
}

bootstrap().catch((err) => {
   
  console.error('Panorama core-api failed to start', err);
  process.exit(1);
});
