import type { LoggerService, LogLevel } from '@nestjs/common';
import pino, { type Logger as PinoLogger } from 'pino';
import { currentContext } from '../../modules/tenant/tenant.context.js';

/**
 * Pino-backed Nest LoggerService per ADR-0018 §1.
 *
 * - Output: JSON to stdout in production; pino-pretty when
 *   `LOG_FORMAT=pretty` (dev only — pino-pretty is a devDependency,
 *   loaded dynamically via pino's transport mechanism).
 * - Mixin: every log line carries `requestId`, `tenantId`, `userId`
 *   read from the existing TenantContext ALS (extended in ADR-0018 §4).
 *   `actorEmail` is intentionally NOT included — it's PII; support
 *   joins userId → email via the admin UI when needed.
 * - Redact: defense-in-depth scrub paths for headers + secret-shaped
 *   keys so a future `this.log.info({ req })` accident doesn't leak.
 * - Levels: Nest's `log()` maps to pino's `info`; default
 *   level `info` in production, `debug` when `LOG_LEVEL=debug`. The
 *   existing 56 `new Logger('Foo')` call sites continue to work
 *   unchanged — pino is wired via `app.useLogger(new PinoLoggerService(...))`
 *   in main.ts and Nest routes its built-in Logger through us.
 */

function buildPinoLogger(): PinoLogger {
  const level = process.env['LOG_LEVEL'] ?? 'info';
  const format = process.env['LOG_FORMAT'];

  const baseOptions: pino.LoggerOptions = {
    level,
    mixin: () => {
      const ctx = currentContext();
      return {
        requestId: ctx.requestId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
      };
    },
    // pino's redact is depth-aware: `*.password` matches a
    // password key one level deep, not recursively. To catch
    // common shapes at depth 1-3 the list enumerates each level.
    // Freeform strings (Error.message, log-line message arg) can
    // still smuggle secrets through — that's the residual risk
    // documented in ADR-0018 (defense-in-depth, not seal).
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["set-cookie"]',
        'headers.authorization',
        'headers.cookie',
        'headers["set-cookie"]',
        'password',
        'token',
        'secret',
        'sessionSecret',
        'sessionSecretPrevious',
        'sessionPassword',
        'clientSecret',
        'client_secret',
        'apiKey',
        'api_key',
        'privateKey',
        'private_key',
        'dsn',
        'databaseUrl',
        '*.password',
        '*.token',
        '*.secret',
        '*.sessionSecret',
        '*.sessionSecretPrevious',
        '*.sessionPassword',
        '*.clientSecret',
        '*.client_secret',
        '*.apiKey',
        '*.api_key',
        '*.privateKey',
        '*.private_key',
        '*.dsn',
        '*.databaseUrl',
        '*.*.password',
        '*.*.token',
        '*.*.secret',
        '*.*.clientSecret',
        '*.*.client_secret',
        '*.*.apiKey',
        '*.*.api_key',
        '*.*.privateKey',
        '*.*.private_key',
      ],
      censor: '[REDACTED]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  if (format === 'pretty') {
    // pino-pretty is a devDependency; pino loads it via worker
    // transport so it stays out of the production import graph.
    return pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return pino(baseOptions);
}

const NEST_TO_PINO: Record<LogLevel, 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal'> = {
  log: 'info',
  error: 'error',
  warn: 'warn',
  debug: 'debug',
  verbose: 'trace',
  fatal: 'fatal',
};

export class PinoLoggerService implements LoggerService {
  private readonly logger: PinoLogger;

  constructor(logger?: PinoLogger) {
    this.logger = logger ?? buildPinoLogger();
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.emit('log', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.emit('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.emit('warn', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit('verbose', message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.emit('fatal', message, rest);
  }

  /**
   * Nest's Logger calls our methods with positional args that vary by
   * call site: `log('msg', 'Context')`, `error('msg', stack, 'Context')`,
   * `warn({ structured: true }, 'Context')`. Normalize into a single
   * `{ context?, stack?, ...obj }, msg` shape pino accepts.
   */
  private emit(level: LogLevel, message: unknown, rest: unknown[]): void {
    const pinoLevel = NEST_TO_PINO[level];
    const tail = rest.slice();
    let context: string | undefined;
    let stack: string | undefined;

    if (tail.length > 0 && typeof tail[tail.length - 1] === 'string') {
      context = tail.pop() as string;
    }
    if (level === 'error' && tail.length > 0 && typeof tail[0] === 'string') {
      stack = tail.shift() as string;
    }

    const meta: Record<string, unknown> = {};
    if (context !== undefined) meta['context'] = context;
    if (stack !== undefined) meta['stack'] = stack;

    if (typeof message === 'string') {
      this.logger[pinoLevel](meta, message);
    } else if (message instanceof Error) {
      this.logger[pinoLevel]({ ...meta, err: message }, message.message);
    } else if (message && typeof message === 'object') {
      this.logger[pinoLevel]({ ...meta, ...(message as Record<string, unknown>) });
    } else {
      this.logger[pinoLevel](meta, String(message));
    }
  }
}
