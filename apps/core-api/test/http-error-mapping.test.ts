import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Body, Controller, Module, Post, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import { AllExceptionsFilter } from '../src/shared/observability/all-exceptions.filter.js';

/**
 * How body-parser errors reach the global AllExceptionsFilter.
 *
 * Errors raised by Express middleware (body-parser) are handed to Nest's
 * error handler, which maps them through the HTTP adapter before the
 * filters run. On Nest 11 only SyntaxError / URIError were mapped (to a
 * 400); an `http-errors` 4xx such as body-parser's 413 reached our
 * `@Catch()` filter as a plain Error and was answered as a 500 (and
 * forwarded to Sentry). Since @nestjs/platform-express 12.3 the adapter
 * maps every `http-errors` 4xx to an HttpException with its own status.
 *
 * No database: a throwaway controller behind the same global pipe and
 * filter that main.ts registers.
 */

class EchoDto {
  @IsString()
  name!: string;
}

@Controller('echo')
class EchoController {
  @Post()
  echo(@Body() body: EchoDto): { name: string } {
    return { name: body.name };
  }
}

@Module({ controllers: [EchoController] })
class EchoModule {}

describe('HTTP adapter error mapping through AllExceptionsFilter', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [EchoModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function post(body: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it('accepts a valid body', async () => {
    const res = await post(JSON.stringify({ name: 'ok' }));
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ name: 'ok' });
  });

  it('answers malformed JSON with a 400 that carries ref', async () => {
    const res = await post('{"name": ');
    expect(res.status).toBe(400);
    expect(res.json['statusCode']).toBe(400);
    expect(res.json).toHaveProperty('ref');
  });

  it('answers a body over the JSON limit with a 413, not a 500', async () => {
    // body-parser's default JSON limit is 100kb; main.ts does not raise it.
    const res = await post(JSON.stringify({ name: 'x'.repeat(200 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.json['statusCode']).toBe(413);
    expect(res.json['message']).toBe('request entity too large');
    expect(res.json).toHaveProperty('ref');
  });

  it('rejects a property outside the DTO with a 400', async () => {
    const res = await post(JSON.stringify({ name: 'ok', role: 'admin' }));
    expect(res.status).toBe(400);
  });
});
