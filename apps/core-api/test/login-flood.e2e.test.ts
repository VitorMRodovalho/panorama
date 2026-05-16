import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { resetTestDb } from './_reset-db.js';

/**
 * Synthetic-flood test (Wave 0 Round 2, ADR-0014 prerequisite per the
 * security-reviewer B1 finding in HANDOFF-2026-05-16-wave0-scan.md).
 *
 * Proves the auth-bucket ThrottlerGuard is actually wired — pre-Round 2
 * the ThrottlerModule was registered but no APP_GUARD provider existed,
 * so the documented `auth: 10/min` cap was fictional.
 *
 * Asserts: after 15 rapid POSTs to /auth/login with invalid credentials,
 * at least 3 return 429 (the throttler should fire on attempts 11+).
 * The exact count varies slightly with test timing; the floor of 3
 * proves wiring without making the test brittle on environment speed.
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('abuse: login flood (Wave 0 Round 2)', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'a'.repeat(32);
    process.env.DATABASE_URL = APP_URL;
    // Opt this test specifically into the throttler. Other e2e tests
    // share a cached AppModule, but skipIf is evaluated per-request,
    // so the env change here turns the guard on for our 15 POSTs.
    process.env['THROTTLER_ENABLED'] = '1';

    // Reset is needed because the throttler bucket persists across
    // tests within a process; an empty DB ensures the login lookups
    // return 401 quickly without depending on seeded state.
    const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(admin);
    await admin.$disconnect();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: ['error', 'warn'],
    });
    (app as NestExpressApplication).set('trust proxy', 1);
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    // Clear the opt-in so tests that run after this one don't get
    // surprise-throttled by an inherited env.
    delete process.env['THROTTLER_ENABLED'];
    await app?.close();
  });

  it('returns 429 once the auth bucket is exhausted', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await fetch(`${url}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `flood-${i}@invalid.example`,
          password: 'wrong',
        }),
      });
      statuses.push(res.status);
    }
    // First ~10 attempts: 401 (no such user) — auth-controller path.
    // Attempts 11+ from the same IP: 429 — ThrottlerGuard kicks in.
    const tooMany = statuses.filter((s) => s === 429).length;
    expect(tooMany).toBeGreaterThanOrEqual(3);
  });
});
