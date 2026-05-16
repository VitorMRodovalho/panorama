import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // Trust the first proxy hop (Fly edge → app, or LB → app on self-host).
  // Without this, req.ip resolves to the proxy IP and the ThrottlerGuard
  // sees every request as coming from one IP — fail-united, not
  // fail-closed. Single hop is the conservative choice; bump if you
  // run multiple LBs in front.
  app.set('trust proxy', 1);

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
