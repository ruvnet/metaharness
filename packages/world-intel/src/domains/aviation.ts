// SPDX-License-Identifier: MIT
// Native port of aviation.py, marc-shade/world-intel-mcp fdebf9a8.
import { MarketTransport, pyRound, type MarketOptions } from "./markets.js";
import type { DomainHandlers } from "../domain-runtime.js";
const _FAA_STATUS_URL: any = "https://soa.smext.faa.gov/asws/api/airport/status";
const _MAJOR_AIRPORTS: any = ["ATL", "LAX", "ORD", "DFW", "DEN", "JFK", "SFO", "SEA", "LAS", "MCO", "EWR", "CLT", "PHX", "IAH", "MIA", "BOS", "MSP", "FLL", "DTW", "PHL"];
const _OPENSKY_STATES_URL: any = "https://opensky-network.org/api/states/all";
const _AIR_REGIONS: any = { "north_america": [15, -170, 72, -50], "europe": [35, -25, 72, 45], "east_asia": [15, 95, 55, 155], "middle_east": [12, 25, 42, 65], "south_asia": [5, 60, 40, 100], "africa": [-35, -20, 37, 55], "south_america": [-56, -82, 15, -34], "oceania": [-50, 110, 0, 180] };
const _COMMERCIAL_PREFIXES: any = ["UAL", "AAL", "DAL", "SWA", "JBU", "ASA", "NKS", "FFT", "SKW", "BAW", "EZY", "RYR", "DLH", "AFR", "KLM", "SAS", "AUA", "TAP", "QFA", "ANZ", "JST", "VOZ", "CPA", "SIA", "THA", "ANA", "JAL", "CES", "CSN", "CCA", "HDA", "AIC", "UAE", "ETH", "SAA", "RAM", "TAM", "GLO", "AZU", "AVA", "LAN", "THY", "TRK", "SHT"];
type RecordValue = Record<string, any>;
const record = (x: unknown): x is RecordValue => x !== null && typeof x === 'object' && !Array.isArray(x);
export interface AviationTransport {
    json(url: URL, ttlSeconds?: number): Promise<unknown>;
}
/** An injected transport can provide approved OpenSky authentication; no credentials are read from env. */
export interface AviationOptions extends MarketOptions {
    transport?: AviationTransport;
}
export function parseAirportStatus(code: string, data: RecordValue): RecordValue {
    let delay = data.Delay ?? false;
    if (typeof delay === 'string')
        delay = delay.toLowerCase() === 'true';
    const statuses = Array.isArray(data.Status) ? data.Status : record(data.Status) ? [data.Status] : [];
    return { code, name: data.Name ?? code, delay, status: statuses.filter(record).map(item => ({ type: item.Type ?? '', reason: item.Reason ?? '', avg_delay: item.AvgDelay ?? '', closure_begin: item.ClosureBegin ?? '', closure_end: item.ClosureEnd ?? '' })) };
}
export function classifyAirRegion(lat: number | null, lon: number | null): string {
    if (lat === null || lon === null)
        return 'unknown';
    for (const [name, bounds] of Object.entries(_AIR_REGIONS)) {
        const [la, lo, ha, ho] = bounds as number[];
        if (la <= lat && lat <= ha && lo <= lon && lon <= ho)
            return name;
    }
    return 'other';
}
export function summarizeDomesticFlights(data: unknown, timestamp: string): RecordValue {
    if (!record(data))
        return { total_aircraft: 0, by_region: {}, busiest_origins: [], error: 'OpenSky API unavailable', source: 'opensky-domestic', timestamp };
    const regions: RecordValue = Object.fromEntries([...Object.keys(_AIR_REGIONS), 'other', 'unknown'].map(r => [r, { count: 0, commercial: 0, general: 0 }]));
    const origins = new Map<string, number>();
    let total = 0;
    const sampled: RecordValue[] = [];
    const states = Array.isArray(data.states) ? data.states : [];
    states.forEach((s, idx) => {
        if (!Array.isArray(s) || s.length < 15 || s[8])
            return;
        total++;
        const lat = s[6] ?? null, lon = s[5] ?? null, callsign = String(s[1] ?? '').trim(), origin = String(s[2] || 'Unknown');
        const region = classifyAirRegion(lat, lon), commercial = _COMMERCIAL_PREFIXES.some((p: string) => callsign.toUpperCase().startsWith(p));
        regions[region].count++;
        regions[region][commercial ? 'commercial' : 'general']++;
        origins.set(origin, (origins.get(origin) ?? 0) + 1);
        if (idx % 10 === 0 && lat !== null && lon !== null)
            sampled.push({ lat: pyRound(lat, 2), lon: pyRound(lon, 2), callsign: callsign || null, origin, alt: s[7] ? pyRound(s[7]) : null, commercial });
    });
    return { total_aircraft: total, by_region: Object.fromEntries(Object.entries(regions).filter(([, v]) => v.count > 0)), busiest_origins: [...origins].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([country, count]) => ({ country, count })), positions: sampled, source: 'opensky-domestic', timestamp };
}
export function createAviationHandlers(options: AviationOptions = {}): DomainHandlers {
    const transport = options.transport ?? new MarketTransport(options), now = options.now ?? Date.now, stamp = () => new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const json = async (url: URL, ttl: number) => { try {
        return await transport.json(url, ttl);
    }
    catch {
        return null;
    } };
    return {
        intel_airport_delays: async () => {
            const results = await Promise.all((_MAJOR_AIRPORTS as string[]).map(async (code) => ({ code, data: await json(new URL(`${_FAA_STATUS_URL}/${code}`), 300) })));
            const delayed: RecordValue[] = [];
            let errors = 0;
            for (const { code, data } of results) {
                if (!record(data)) {
                    errors++;
                    continue;
                }
                const parsed = parseAirportStatus(code, data);
                if (parsed.delay)
                    delayed.push(parsed);
            }
            return { delayed, delayed_count: delayed.length, total_checked: _MAJOR_AIRPORTS.length, errors, source: 'faa', timestamp: stamp() };
        },
        intel_aviation_domestic: async () => summarizeDomesticFlights(await json(new URL(_OPENSKY_STATES_URL), 120), stamp()),
    };
}
