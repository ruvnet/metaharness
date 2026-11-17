import { describe, it, expect, vi } from 'vitest';
import { WorldIntelClient } from '../src/sources.js';
const json = (data: unknown) => new Response(JSON.stringify(data));
const quake = { id: 'us123', properties: { mag: 4.6, place: 'Test', time: 1700000000000, url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us123' }, geometry: { coordinates: [10, 20, 30] } };
describe('native source adapters', () => {
  it('parses USGS GeoJSON with provenance and truncation warning', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ features: [quake] }));
    const client = new WorldIntelClient({ fetch, now: () => 1700000000000 });
    const result = await client.earthquakes({ limit: 1 });
    expect(result.data[0]).toMatchObject({ id: 'us123', magnitude: 4.6, latitude: 20, longitude: 10, depthKm: 30 });
    expect(result.provenance.source).toBe('usgs'); expect(result.provenance.warnings).toContain('Results are capped at 1; this is not an exhaustive event count.');
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get('limit')).toBe('1');
  });
  it('skips malformed quake records rather than inventing coordinates', async () => {
    const client = new WorldIntelClient({ fetch: vi.fn().mockResolvedValue(json({ features: [{ ...quake, geometry: { coordinates: [999, 20] } }] })) });
    const result = await client.earthquakes(); expect(result.data).toEqual([]); expect(result.provenance.warnings[0]).toContain('incomplete');
  });
  it('parses NWS alert data, bounding list and warning about geography', async () => {
    const client = new WorldIntelClient({ fetch: vi.fn().mockResolvedValue(json({ features: [{ id: 'alert', properties: { event: 'Flood', headline: 'Flood warning', severity: 'Severe', areaDesc: 'Test county', sent: '2026-01-01T00:00:00Z' } }] })) });
    const result = await client.weatherAlerts({ area: 'CA' }); expect(result.data[0].event).toBe('Flood'); expect(result.provenance.warnings[0]).toContain('not global');
  });
  it('preserves missing World Bank values as null and labels lagged data', async () => {
    const fetch = vi.fn().mockResolvedValue(json([{ pages: 1 }, [{ date: '2024', value: null, unit: '' }]]));
    const client = new WorldIntelClient({ fetch }); const result = await client.indicator({ country: 'CA', year: 2024 });
    expect(result.data[0].value).toBeNull(); expect(result.provenance.warnings[0]).toContain('lagged');
  });
  it('does not turn malformed source responses into quiet-world success', async () => {
    const client = new WorldIntelClient({ fetch: vi.fn().mockImplementation(() => Promise.resolve(json({ error: 'failed' }))) });
    await expect(client.earthquakes()).rejects.toThrow(); await expect(client.weatherAlerts()).rejects.toThrow(); await expect(client.indicator()).rejects.toThrow();
  });
  it('rejects malformed params, unknown keys, unsupported indicators without fetching', async () => {
    const fetch = vi.fn(); const client = new WorldIntelClient({ fetch });
    await expect(client.earthquakes({ limit: 101 })).rejects.toThrow();
    await expect(client.earthquakes({ minMagnitude: NaN })).rejects.toThrow();
    await expect(client.earthquakes({ url: 'http://localhost' } as never)).rejects.toThrow();
    await expect(client.weatherAlerts({ area: '../' })).rejects.toThrow();
    await expect(client.indicator({ country: '../secret' })).rejects.toThrow();
    await expect(client.indicator({ indicator: 'not-supported' })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
