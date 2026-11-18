import { describe, it, expect, vi } from 'vitest';
import { JsonClient, SourceError } from '../src/core.js';
const url = new URL('https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson');
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
describe('bounded public-source transport', () => {
  it('rejects arbitrary origins, paths, credentials, fragments before fetch', async () => {
    const fetch = vi.fn(); const client = new JsonClient({ fetch });
    for (const input of ['http://earthquake.usgs.gov/fdsnws/event/1/query', 'https://127.0.0.1/fdsnws/event/1/query', 'https://earthquake.usgs.gov/private', 'https://user:pass@earthquake.usgs.gov/fdsnws/event/1/query', url.href + '#x']) {
      await expect(client.get('usgs', new URL(input))).rejects.toThrow('allowlist');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('omits credentials and refuses redirects; returns cloned cached data', async () => {
    let now = 1000; const fetch = vi.fn().mockResolvedValue(json({ count: 1 }));
    const client = new JsonClient({ fetch, now: () => now });
    const result = await client.get('usgs', url); (result.data as { count: number }).count = 99;
    now = 2000; const cached = await client.get('usgs', url);
    expect(cached.data).toEqual({ count: 1 }); expect(cached.provenance.cacheAgeMs).toBe(1000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
  });
  it('fails closed by default; stale fallback explicit and bounded', async () => {
    let now = 1000; const fetch = vi.fn().mockResolvedValueOnce(json({ count: 1 })).mockRejectedValue(new Error('network'));
    const client = new JsonClient({ fetch, now: () => now, ttlMs: 100, maxStaleMs: 100 });
    await client.get('usgs', url); now = 1150;
    await expect(client.get('usgs', url)).rejects.toBeInstanceOf(SourceError);
    const stale = await client.get('usgs', url, { allowStale: true });
    expect(stale.provenance.stale).toBe(true); expect(stale.provenance.warnings.length).toBe(1);
    now = 1201; await expect(client.get('usgs', url, { allowStale: true })).rejects.toThrow();
  });
  it('rejects HTTP errors, invalid JSON, declared and streamed oversized bodies', async () => {
    for (const response of [new Response('no', { status: 429 }), new Response('{'), new Response('{}', { headers: { 'content-length': '99' } }), new Response('{"payload":"oversized"}')]) {
      const client = new JsonClient({ fetch: vi.fn().mockResolvedValue(response), maxBytes: 10 });
      await expect(client.get('usgs', url)).rejects.toBeInstanceOf(SourceError);
    }
  });
  it('bounds hanging transport independently of AbortSignal compliance', async () => {
    const client = new JsonClient({ fetch: vi.fn().mockReturnValue(new Promise(() => {})), timeoutMs: 5 });
    await expect(client.get('usgs', url)).rejects.toThrow('timed out');
  });
  it('bounds body stream time and cancels stream', async () => {
    const cancel = vi.fn(); const body = new ReadableStream({ cancel });
    const client = new JsonClient({ fetch: vi.fn().mockResolvedValue(new Response(body)), timeoutMs: 5 });
    await expect(client.get('usgs', url)).rejects.toThrow('timed out');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('evicts old cache entries at configured bound', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json({}))); const client = new JsonClient({ fetch, maxEntries: 1 });
    await client.get('usgs', url); await client.get('usgs', new URL(url.href + '&limit=1')); await client.get('usgs', url);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
