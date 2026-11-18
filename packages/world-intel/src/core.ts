/** Bounded public-source transport. No credentials, redirects, arbitrary origins or implicit stale data. */
export type Source = 'usgs' | 'noaa' | 'worldbank';
export interface Provenance {
  source: Source;
  url: string;
  fetchedAt: string;
  cacheAgeMs: number;
  stale: boolean;
  warnings: string[];
}
export interface Observation<T> { data: T; provenance: Provenance }
export interface QueryOptions { allowStale?: boolean }
export interface ClientOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  ttlMs?: number;
  maxStaleMs?: number;
  maxEntries?: number;
}
interface CacheEntry { data: unknown; fetchedAt: number }
const ENDPOINTS: Record<Source, { origin: string; path: RegExp }> = {
  usgs: { origin: 'https://earthquake.usgs.gov', path: /^\/fdsnws\/event\/1\/query$/ },
  noaa: { origin: 'https://api.weather.gov', path: /^\/alerts\/active$/ },
  worldbank: { origin: 'https://api.worldbank.org', path: /^\/v2\/country\/[A-Z]{2}\/indicator\/[A-Z0-9.]{1,64}$/ },
};
function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer in ${min}..${max}`);
  return value;
}
export class SourceError extends Error {
  constructor(readonly source: Source, message: string) { super(message); this.name = 'SourceError'; }
}
export class JsonClient {
  private readonly transport: typeof globalThis.fetch;
  readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly maxStaleMs: number;
  private readonly maxEntries: number;
  private readonly cache = new Map<string, CacheEntry>();
  constructor(options: ClientOptions = {}) {
    this.transport = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = bounded(options.timeoutMs ?? 10_000, 1, 60_000, 'timeoutMs');
    this.maxBytes = bounded(options.maxBytes ?? 2_000_000, 1, 10_000_000, 'maxBytes');
    this.ttlMs = bounded(options.ttlMs ?? 300_000, 0, 86_400_000, 'ttlMs');
    this.maxStaleMs = bounded(options.maxStaleMs ?? 3_600_000, 0, 604_800_000, 'maxStaleMs');
    this.maxEntries = bounded(options.maxEntries ?? 100, 1, 1000, 'maxEntries');
  }
  clearCache(): void { this.cache.clear(); }
  async get(source: Source, input: URL, options: QueryOptions = {}): Promise<Observation<unknown>> {
    const url = new URL(input.href);
    const endpoint = ENDPOINTS[source];
    if (!endpoint || url.origin !== endpoint.origin || !endpoint.path.test(url.pathname) || url.username || url.password || url.hash || url.href.length > 2048) {
      throw new SourceError(source, 'URL is outside the fixed public-source allowlist');
    }
    const key = `${source}:${url.href}`;
    const entry = this.cache.get(key);
    const age = entry ? Math.max(0, this.now() - entry.fetchedAt) : Infinity;
    if (entry && age < this.ttlMs) return this.observation(source, url, entry, false);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Promise.race bounds even injected transports that ignore AbortSignal.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new SourceError(source, 'Public source request timed out')); }, this.timeoutMs);
    });
    try {
      const data = await Promise.race([this.readJson(source, url, controller.signal), timeout]);
      const fresh = { data, fetchedAt: this.now() };
      this.cache.delete(key);
      if (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, fresh);
      return this.observation(source, url, fresh, false);
    } catch (error) {
      if (entry && options.allowStale === true && Math.max(0, this.now() - entry.fetchedAt) <= this.ttlMs + this.maxStaleMs) {
        return this.observation(source, url, entry, true, ['Source refresh failed. Serving explicitly requested stale cached data; do not treat it as current.']);
      }
      throw error instanceof SourceError ? error : new SourceError(source, 'Public source request failed or returned invalid JSON');
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  private observation(source: Source, url: URL, entry: CacheEntry, stale: boolean, warnings: string[] = []): Observation<unknown> {
    return {
      data: structuredClone(entry.data),
      provenance: { source, url: url.href, fetchedAt: new Date(entry.fetchedAt).toISOString(), cacheAgeMs: Math.max(0, this.now() - entry.fetchedAt), stale, warnings },
    };
  }
  private async readJson(source: Source, url: URL, signal: AbortSignal): Promise<unknown> {
    const response = await this.transport(url, {
      signal, redirect: 'error', credentials: 'omit',
      headers: { Accept: 'application/geo+json, application/json', 'User-Agent': 'metaharness-world-intel/0.1.0 (public data research)' },
    });
    if (!response.ok) { await response.body?.cancel(); throw new SourceError(source, `Public source returned HTTP ${response.status}`); }
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > this.maxBytes) { await response.body?.cancel(); throw new SourceError(source, 'Public source response exceeds byte limit'); }
    const reader = response.body?.getReader();
    if (!reader) throw new SourceError(source, 'Public source response has no body');
    const abortReader = (): void => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', abortReader, { once: true });
    let bytes = 0;
    const parts: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > this.maxBytes) { await reader.cancel(); throw new SourceError(source, 'Public source response exceeds byte limit'); }
        parts.push(value);
      }
    } finally { signal.removeEventListener('abort', abortReader); reader.releaseLock(); }
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) { combined.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined));
  }
}
