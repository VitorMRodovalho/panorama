import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SnipeItClient, SnipeItApiError } from '../src/snipeit-client.js';

describe('SnipeItClient', () => {
  const origFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it('GETs JSON and returns body for 200', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ total: 1, rows: [{ id: 42 }] }), { status: 200 }),
    );
    const c = new SnipeItClient({ baseUrl: 'https://snipe.example', token: 't' });
    const body = await c.get('users');
    expect(body).toEqual({ total: 1, rows: [{ id: 42 }] });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual', // SSRF hygiene
      }),
    );
  });

  it('throws SnipeItApiError on 404', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'not found' }), { status: 404 }),
    );
    const c = new SnipeItClient({ baseUrl: 'https://snipe.example', token: 't' });
    await expect(c.get('nope')).rejects.toBeInstanceOf(SnipeItApiError);
  });

  it('retries 5xx and succeeds on the second attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const c = new SnipeItClient({
      baseUrl: 'https://snipe.example',
      token: 't',
      maxRetries: 2,
    });
    const body = await c.get('healthcheck');
    expect(body).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours Retry-After on 429', async () => {
    const headers = new Headers();
    headers.set('Retry-After', '0');
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const c = new SnipeItClient({ baseUrl: 'https://snipe.example', token: 't' });
    const body = await c.get('rate');
    expect(body).toEqual({ ok: true });
  });

  it('paginates fetchAll until total is reached', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ total: 3, rows: [{ id: 1 }, { id: 2 }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ total: 3, rows: [{ id: 3 }] }), { status: 200 }),
      );
    const c = new SnipeItClient({
      baseUrl: 'https://snipe.example',
      token: 't',
      pageSize: 2,
    });
    const all = await c.fetchAll<{ id: number }>('users');
    expect(all.map((u) => u.id)).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('count() returns total without pulling rows', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ total: 42_000, rows: [{ id: 1 }] }), { status: 200 }),
    );
    const c = new SnipeItClient({ baseUrl: 'https://snipe.example', token: 't' });
    expect(await c.count('hardware')).toBe(42_000);
  });
});
