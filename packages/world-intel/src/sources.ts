import { JsonClient, SourceError, type ClientOptions, type Observation, type QueryOptions } from './core.js';

export interface Earthquake {
  id: string; magnitude: number | null; place: string; time: string | null;
  longitude: number; latitude: number; depthKm: number | null; url: string | null;
}
export interface WeatherAlert {
  id: string; event: string; headline: string; severity: string; area: string;
  sent: string | null; expires: string | null; description: string;
}
export interface IndicatorValue { country: string; indicator: string; year: string; value: number | null; unit: string }
export interface EarthquakeOptions extends QueryOptions { limit?: number; minMagnitude?: number; days?: number }
export interface WeatherOptions extends QueryOptions { area?: string; limit?: number }
export interface IndicatorOptions extends QueryOptions { country?: string; indicator?: string; year?: number }
const INDICATORS = ['NY.GDP.MKTP.CD', 'FP.CPI.TOTL.ZG', 'SP.POP.TOTL', 'SL.UEM.TOTL.ZS'] as const;
function object(input: unknown): Record<string, unknown> | null { return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null; }
function text(input: unknown, length = 2000): string { return typeof input === 'string' ? input.slice(0, length) : ''; }
function finite(input: unknown): number | null { return typeof input === 'number' && Number.isFinite(input) ? input : null; }
function instant(input: unknown): string | null {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const date = new Date(input); return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function number(input: number, min: number, max: number, key: string, integer = true): number {
  if (!Number.isFinite(input) || (integer && !Number.isInteger(input)) || input < min || input > max) throw new RangeError(`${key} must be ${integer ? 'an integer' : 'a number'} in ${min}..${max}`);
  return input;
}
function keys(input: unknown, allowed: string[]): void {
  const record = object(input);
  if (!record) throw new TypeError('Options must be an object');
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new TypeError(`Unknown option: ${key}`);
  const stale = (input as QueryOptions).allowStale;
  if (stale !== undefined && typeof stale !== 'boolean') throw new TypeError('allowStale must be boolean');
}
function citation(input: unknown, hostname: string): string | null {
  if (typeof input !== 'string') return null;
  try { const url = new URL(input); return url.protocol === 'https:' && url.hostname === hostname && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function mapped<T>(result: Observation<unknown>, data: T, warnings: string[] = []): Observation<T> {
  return { data, provenance: { ...result.provenance, warnings: [...result.provenance.warnings, ...warnings] } };
}
/** Three native TypeScript adapters; intentionally not a claim of upstream 160-tool parity. */
export class WorldIntelClient {
  readonly client: JsonClient;
  constructor(options: ClientOptions = {}) { this.client = new JsonClient(options); }
  async earthquakes(options: EarthquakeOptions = {}): Promise<Observation<Earthquake[]>> {
    keys(options, ['limit', 'minMagnitude', 'days', 'allowStale']);
    const limit = number(options.limit ?? 20, 1, 100, 'limit');
    const minMagnitude = number(options.minMagnitude ?? 4.5, -2, 10, 'minMagnitude', false);
    const days = number(options.days ?? 1, 1, 30, 'days');
    const url = new URL('https://earthquake.usgs.gov/fdsnws/event/1/query');
    // Minute quantization gives stable cache keys without pretending source event time is fetch time.
    const end = Math.floor(this.client.now() / 60_000) * 60_000;
    url.search = new URLSearchParams({ format: 'geojson', orderby: 'time', limit: String(limit), minmagnitude: String(minMagnitude), starttime: new Date(end - days * 86_400_000).toISOString() }).toString();
    const result = await this.client.get('usgs', url, options);
    const data = object(result.data);
    if (!data || !Array.isArray(data.features)) throw new SourceError('usgs', 'Invalid earthquake FeatureCollection');
    const records: Earthquake[] = [];
    let skipped = 0;
    for (const item of data.features.slice(0, limit)) {
      const feature = object(item); const properties = object(feature?.properties); const geometry = object(feature?.geometry);
      const coordinates = geometry?.coordinates;
      if (!feature || typeof feature.id !== 'string' || !properties || !Array.isArray(coordinates) || finite(coordinates[0]) === null || finite(coordinates[1]) === null || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) { skipped++; continue; }
      records.push({ id: text(feature.id, 200), magnitude: finite(properties.mag), place: text(properties.place), time: instant(properties.time), longitude: coordinates[0] as number, latitude: coordinates[1] as number, depthKm: finite(coordinates[2]), url: citation(properties.url, 'earthquake.usgs.gov') });
    }
    return mapped(result, records, [...(skipped ? [`Skipped ${skipped} malformed earthquake records; coverage is incomplete.`] : []), ...(data.features.length >= limit ? [`Results are capped at ${limit}; this is not an exhaustive event count.`] : [])]);
  }
  async weatherAlerts(options: WeatherOptions = {}): Promise<Observation<WeatherAlert[]>> {
    keys(options, ['area', 'limit', 'allowStale']);
    const limit = number(options.limit ?? 20, 1, 100, 'limit');
    if (options.area !== undefined && !/^[A-Z]{2}$/.test(options.area)) throw new TypeError('area must be a two-letter uppercase US state or territory code');
    const url = new URL('https://api.weather.gov/alerts/active');
    if (options.area) url.searchParams.set('area', options.area);
    const result = await this.client.get('noaa', url, options);
    const data = object(result.data);
    if (!data || !Array.isArray(data.features)) throw new SourceError('noaa', 'Invalid NWS alert FeatureCollection');
    const records: WeatherAlert[] = []; let skipped = 0;
    for (const item of data.features.slice(0, limit)) {
      const feature = object(item); const properties = object(feature?.properties);
      if (!feature || !properties || typeof feature.id !== 'string') { skipped++; continue; }
      records.push({ id: text(feature.id, 500), event: text(properties.event), headline: text(properties.headline), severity: text(properties.severity), area: text(properties.areaDesc), sent: instant(properties.sent), expires: instant(properties.expires), description: text(properties.description, 8000) });
    }
    return mapped(result, records, ['NWS alerts cover the United States and its territories, not global weather.', ...(data.features.length > limit ? [`Only the first ${limit} alerts returned; coverage is incomplete.`] : []), ...(skipped ? [`Skipped ${skipped} malformed alerts; coverage is incomplete.`] : [])]);
  }
  async indicator(options: IndicatorOptions = {}): Promise<Observation<IndicatorValue[]>> {
    keys(options, ['country', 'indicator', 'year', 'allowStale']);
    const country = options.country ?? 'US'; const indicator = options.indicator ?? 'NY.GDP.MKTP.CD';
    if (!/^[A-Z]{2}$/.test(country)) throw new TypeError('country must be a two-letter uppercase ISO code');
    if (!(INDICATORS as readonly string[]).includes(indicator)) throw new TypeError(`indicator must be one of ${INDICATORS.join(', ')}`);
    const year = number(options.year ?? new Date(this.client.now()).getUTCFullYear() - 1, 1960, new Date(this.client.now()).getUTCFullYear(), 'year');
    const url = new URL(`https://api.worldbank.org/v2/country/${country}/indicator/${indicator}`);
    url.search = new URLSearchParams({ format: 'json', date: String(year), per_page: '100' }).toString();
    const result = await this.client.get('worldbank', url, options);
    if (!Array.isArray(result.data) || result.data.length !== 2 || !object(result.data[0]) || !(Array.isArray(result.data[1]) || result.data[1] === null)) throw new SourceError('worldbank', 'Invalid World Bank indicator response');
    const metadata = object(result.data[0])!;
    if (Number(metadata.pages ?? 1) > 1) throw new SourceError('worldbank', 'Unexpected paginated response; complete coverage not established');
    const records: IndicatorValue[] = []; let skipped = 0;
    for (const row of (result.data[1] ?? []).slice(0, 100)) {
      const item = object(row);
      if (!item || typeof item.date !== 'string' || (item.value !== null && finite(item.value) === null)) { skipped++; continue; }
      records.push({ country, indicator, year: item.date, value: finite(item.value), unit: text(item.unit, 100) });
    }
    return mapped(result, records, ['Annual World Bank indicators are lagged and revisable, not real-time observations. Null values mean missing data, never zero.', ...(skipped ? [`Skipped ${skipped} malformed records; coverage is incomplete.`] : [])]);
  }
}
export { INDICATORS };
