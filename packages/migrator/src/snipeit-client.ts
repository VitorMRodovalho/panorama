/**
 * Minimal Snipe-IT API client for migration.
 * Read-only; no tokens are required with write scope.
 *
 * Design choices:
 *   * Native fetch + explicit pagination loop — no axios/got, smaller deps
 *   * Retries with exponential backoff on 429/5xx; honours Retry-After
 *     (same defect we just patched in SnipeScheduler-FleetManager)
 *   * No redirects followed (SSRF hardening at the client level)
 *   * Logs timing + status per call via a pino child logger
 */
import pino from 'pino';

export interface SnipeItClientOptions {
  baseUrl: string;
  token: string;
  verifySsl?: boolean;
  logger?: pino.Logger;
  pageSize?: number;
  maxRetries?: number;
}

export class SnipeItApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `Snipe-IT API ${endpoint} returned ${status}`);
    this.name = 'SnipeItApiError';
  }
}

export class SnipeItClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly log: pino.Logger;
  private readonly pageSize: number;
  private readonly maxRetries: number;

  constructor(opts: SnipeItClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${opts.token}`,
    };
    this.log = opts.logger ?? pino({ level: 'info' });
    this.pageSize = opts.pageSize ?? 100;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async get<T = unknown>(
    endpoint: string,
    params?: Record<string, string | number | boolean>,
  ): Promise<T> {
    // Narrowed from `unknown` so `String(v)` here is safe — non-primitive
    // values would have stringified to "[object Object]" and produced a
    // silent garbage URL. ESLint `no-base-to-string` would catch the
    // unknown-typed variant.
    const url = new URL(this.baseUrl + '/api/v1/' + endpoint.replace(/^\/+/, ''));
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, String(v));
      }
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const start = Date.now();
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: this.headers,
          redirect: 'manual', // SSRF hygiene
        });
        const ms = Date.now() - start;
        this.log.debug({ url: url.toString(), status: res.status, ms, attempt }, 'snipeit_get');

        if (res.status === 429 || res.status >= 500) {
          const retryAfter = this.parseRetryAfter(res.headers.get('retry-after'));
          const wait = Math.min(Math.max(retryAfter, Math.pow(2, attempt)), 60) * 1000;
          this.log.warn({ status: res.status, wait }, 'snipeit_backoff');
          if (attempt < this.maxRetries) {
            await delay(wait);
            continue;
          }
        }

        const body = await res.json().catch(() => null);
        if (!res.ok) {
          throw new SnipeItApiError(res.status, endpoint, body);
        }
        return body as T;
      } catch (err) {
        lastError = err;
        if (err instanceof SnipeItApiError) throw err;
        if (attempt < this.maxRetries) {
          const wait = Math.pow(2, attempt) * 1000;
          this.log.warn({ err: String(err), wait }, 'snipeit_transport_retry');
          await delay(wait);
          continue;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Snipe-IT request failed');
  }

  /** Fetch every page of a paginated endpoint. Uses the Snipe-IT shape {total, rows}. */
  async fetchAll<T = unknown>(
    endpoint: string,
    extraParams: Record<string, string | number | boolean> = {},
  ): Promise<T[]> {
    const collected: T[] = [];
    let offset = 0;
    while (true) {
      const params = { ...extraParams, limit: this.pageSize, offset };
      const res = await this.get<{ rows?: unknown[]; total?: number }>(endpoint, params);
      const rows = (res.rows ?? []) as T[];
      collected.push(...rows);
      const total = typeof res.total === 'number' ? res.total : collected.length;
      if (collected.length >= total || rows.length === 0) break;
      offset += this.pageSize;
      if (offset > 100_000) throw new Error(`refusing to paginate past 100k rows on ${endpoint}`);
    }
    return collected;
  }

  /** Light-weight count probe — reads one page with limit=1 and returns the `total`. */
  async count(
    endpoint: string,
    extraParams: Record<string, string | number | boolean> = {},
  ): Promise<number> {
    const res = await this.get<{ total?: number }>(endpoint, {
      ...extraParams,
      limit: 1,
      offset: 0,
    });
    return typeof res.total === 'number' ? res.total : 0;
  }

  private parseRetryAfter(header: string | null): number {
    if (!header) return 0;
    if (/^\d+$/.test(header)) return parseInt(header, 10);
    const ts = Date.parse(header);
    if (!Number.isNaN(ts)) return Math.max(0, Math.ceil((ts - Date.now()) / 1000));
    return 0;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
