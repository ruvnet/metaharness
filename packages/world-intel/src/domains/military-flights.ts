// SPDX-License-Identifier: MIT
// Native port of military.py, marc-shade/world-intel-mcp fdebf9a8.
import { MarketTransport, pyRound, type MarketOptions } from "./markets.js";
import type { DomainHandlers } from "../domain-runtime.js";
const _OPENSKY_STATES_URL: any = "https://opensky-network.org/api/states/all";
const _ADSBLOL_MIL_URL: any = "https://api.adsb.lol/v2/mil";
const _HEXDB_BASE_URL: any = "https://hexdb.io/api/v1/aircraft";
const MILITARY_ICAO_PREFIXES: any = ["AE", "A8", "A9", "AA", "AB", "AC", "AD", "43C", "43D", "43E", "43F", "3F", "3A8", "3A9", "3AA", "3AB", "500", "501", "502", "70", "C0"];
const MILITARY_CALLSIGN_PREFIXES: any = ["RCH", "DUKE", "REACH", "EVAC", "JAKE", "TOPCAT", "BOXER", "IRON", "CASA", "NATO", "LAGR", "TEAL", "SAM", "EXEC", "SPAR", "VALOR", "BLADE"];
const _ICAO_COUNTRY: any = [["AE", "United States"], ["A8", "United States"], ["A9", "United States"], ["AA", "United States"], ["AB", "United States"], ["AC", "United States"], ["AD", "United States"], ["43C", "United Kingdom"], ["43D", "United Kingdom"], ["43E", "United Kingdom"], ["43F", "United Kingdom"], ["3F", "Germany"], ["3A8", "France"], ["3A9", "France"], ["3AA", "France"], ["3AB", "France"], ["500", "Israel"], ["501", "Israel"], ["502", "Israel"], ["70", "Pakistan"], ["C0", "Canada"], ["34", "Italy"], ["3C", "Germany"], ["E4", "Brazil"], ["71", "Turkey"], ["50", "Israel"], ["48", "Netherlands"], ["44", "Austria"], ["45", "Belgium"], ["46", "Bulgaria"], ["49", "Denmark"], ["4A", "Finland"], ["39", "France"], ["4B", "Greece"], ["4D", "Hungary"], ["4C", "Ireland"], ["30", "Italy"], ["73", "Japan"], ["78", "China"], ["7C", "Australia"], ["C8", "Australia"]];
const THEATERS: any = { "european": { "bbox": "35,-25,72,45", "desc": "NATO/Russia theater" }, "indo_pacific": { "bbox": "-10,95,55,155", "desc": "China/Taiwan/SCS" }, "middle_east": { "bbox": "10,25,45,65", "desc": "Persian Gulf/Red Sea" }, "arctic": { "bbox": "65,-180,90,180", "desc": "Arctic region" }, "korean_peninsula": { "bbox": "33,124,43,132", "desc": "Korean DMZ" } };
type Obj = Record<string, any>;
type Box = [
    number,
    number,
    number,
    number
];
type FlightRead = {
    aircraft: Obj[];
    staleAge: number | null;
};
export interface MilitaryFlightOptions extends MarketOptions {
    transport?: {
        json(url: URL, ttlSeconds?: number): Promise<unknown>;
    };
    openskyAuth?: {
        clientId: string;
        clientSecret: string;
    };
}
const record = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
export function parseMilitaryBbox(value: unknown): Box | null {
    if (typeof value !== 'string')
        return null;
    const parts = value.split(',');
    if (parts.length !== 4 || parts.some(p => !p.trim()))
        return null;
    const n = parts.map(Number);
    if (n.some(v => !Number.isFinite(v)))
        return null;
    const [a, b, c, d] = n;
    if (!(-90 <= a && a < c && c <= 90 && -180 <= b && b < d && d <= 180))
        return null;
    return n as Box;
}
const inBox = (aircraft: Obj[], [a, b, c, d]: Box) => aircraft.filter(x => x.latitude !== null && x.longitude !== null && a <= x.latitude && x.latitude <= c && b <= x.longitude && x.longitude <= d);
function staleAge(d: Obj): number | null { if (!d._stale)
    return null; return typeof d._stale_age_seconds === 'number' && Number.isFinite(d._stale_age_seconds) ? Math.max(0, d._stale_age_seconds) : 0; }
const country = (icao: string) => ((_ICAO_COUNTRY as string[][]).slice().sort((a, b) => b[0].length - a[0].length).find(([prefix]) => icao.toUpperCase().startsWith(prefix)) ?? ['', ''])[1];
export function parseAdsbMilitary(data: unknown): FlightRead | null {
    if (!record(data))
        return null;
    const aircraft: Obj[] = [];
    for (const ac of Array.isArray(data.ac) ? data.ac : []) {
        if (!record(ac) || ac.lat == null || ac.lon == null)
            continue;
        const icao = String(ac.hex ?? '');
        aircraft.push({ icao24: icao, callsign: String(ac.flight ?? '').trim() || null, origin_country: country(icao), latitude: ac.lat, longitude: ac.lon, altitude_m: ac.alt_baro ?? null, velocity_ms: ac.gs ?? null, heading: ac.track ?? null, on_ground: ac.alt_baro === 'ground', squawk: ac.squawk ?? null, aircraft_type: ac.t ?? null, registration: ac.r ?? null });
    }
    return { aircraft, staleAge: staleAge(data) };
}
export function parseOpenSkyMilitary(data: unknown): FlightRead | null {
    if (!record(data))
        return null;
    const aircraft: Obj[] = [];
    for (const s of Array.isArray(data.states) ? data.states : []) {
        if (!Array.isArray(s) || s.length < 17)
            continue;
        const icao = String(s[0] ?? ''), callsign = String(s[1] ?? '');
        if (!(MILITARY_ICAO_PREFIXES as string[]).some(p => icao.toUpperCase().startsWith(p)) && !(MILITARY_CALLSIGN_PREFIXES as string[]).some(p => callsign.trim().toUpperCase().startsWith(p)))
            continue;
        aircraft.push({ icao24: s[0], callsign: s[1] ? String(s[1]).trim() : null, origin_country: s[2], latitude: s[6], longitude: s[5], altitude_m: s[7], velocity_ms: s[9], heading: s[10], on_ground: s[8], squawk: s[14] });
    }
    return { aircraft, staleAge: staleAge(data) };
}
export function createMilitaryFlightHandlers(options: MilitaryFlightOptions = {}): DomainHandlers {
    const fetcher = options.fetch ?? globalThis.fetch;
    const authenticatedFetch: typeof fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const headers = new Headers(init?.headers);
        if (options.openskyAuth && url.origin === 'https://opensky-network.org' && url.pathname === '/api/states/all')
            headers.set('Authorization', `Basic ${Buffer.from(`${options.openskyAuth.clientId}:${options.openskyAuth.clientSecret}`, 'utf8').toString('base64')}`);
        return fetcher(input, { ...init, headers });
    };
    const tr = options.transport ? null : new MarketTransport({ ...options,
        headersByOrigin:options.openskyAuth?{...options.headersByOrigin,'https://opensky-network.org':{...options.headersByOrigin?.['https://opensky-network.org'],Authorization:`Basic ${Buffer.from(`${options.openskyAuth.clientId}:${options.openskyAuth.clientSecret}`,'utf8').toString('base64')}`}}:options.headersByOrigin,
        fetch: options.openskyAuth ? authenticatedFetch : options.fetch }), transport = options.transport ?? tr!, now = options.now ?? Date.now, stamp = (value = now()) => new Date(value).toISOString().replace(/\.000Z$/, '+00:00').replace(/Z$/, '+00:00');
    const json = async (url: URL) => { let value: unknown = null; try {
        value = await transport.json(url, 300);
    }
    catch { } if (value !== null && value !== undefined)
        return value; const cached = tr?.stale(url); if (cached) {
        try {
            const d = JSON.parse(cached.text);
            if (record(d))
                return { ...d, _stale: true, _stale_age_seconds: Math.max(0, (now() - cached.time) / 1000) };
        }
        catch { }
    } return null; };
    return { intel_military_flights: async (args) => {
            let box: Box | null = null;
            if (args.bbox !== undefined && args.bbox !== null) {
                box = parseMilitaryBbox(args.bbox);
                if (!box)
                    return { aircraft: [], count: 0, bbox: args.bbox, source: 'none', timestamp: stamp(), error: `invalid bbox '${String(args.bbox)}': expected lamin,lomin,lamax,lomax as four comma-separated numbers, latitudes -90..90, longitudes -180..180, each minimum below its maximum (split a box that crosses the antimeridian in two)`, reason: 'invalid_bbox' };
            }
            const adsb = parseAdsbMilitary(await json(new URL(_ADSBLOL_MIL_URL))), adsbLive = adsb !== null && adsb.staleAge === null, adsbAny = !!adsb?.aircraft.length;
            if (adsb && box)
                adsb.aircraft = inBox(adsb.aircraft, box);
            if (adsbLive && adsbAny)
                return { aircraft: adsb!.aircraft, count: adsb!.aircraft.length, military_filter: 'adsblol_mil_endpoint', source: 'adsb.lol', timestamp: stamp() };
            const url = new URL(_OPENSKY_STATES_URL);
            if (box)
                ['lamin', 'lomin', 'lamax', 'lomax'].forEach((k, i) => url.searchParams.set(k, String(box![i])));
            const opensky = parseOpenSkyMilitary(await json(url));
            if (opensky && opensky.staleAge === null)
                return { aircraft: opensky.aircraft, count: opensky.aircraft.length, military_filter: 'icao_prefix+callsign', source: 'opensky', timestamp: stamp() };
            const detail = adsbLive ? 'adsb.lol returned no positioned aircraft and OpenSky failed' : 'adsb.lol and OpenSky both failed';
            const response: Obj = { aircraft: [], count: 0, military_filter: 'icao_prefix+callsign', source: 'none', timestamp: stamp(), error: `No military flight source available (${detail})`, degraded: true, reason: 'military_flights_unavailable', data_gaps: [] };
            const copies = ([['adsb.lol', adsb], ['opensky', opensky]] as [
                string,
                FlightRead | null
            ][]).filter((p): p is [
                string,
                FlightRead
            ] => p[1] !== null && p[1].staleAge !== null);
            if (copies.length) {
                const [name, read] = copies.find(([, r]) => r.aircraft.length) ?? copies[0], age = read.staleAge!, asOf = stamp(now() - age * 1000), rounded = pyRound(age).toFixed(0);
                response.stale_copy = { source: name, aircraft: read.aircraft, count: read.aircraft.length, as_of: asOf, age_seconds: age };
                response.stale_age_seconds = age;
                response.error = `No live military flight source (${detail}); only an expired cached copy from ${name}, ${rounded} s old, remains (stale_copy)`;
                response.data_gaps.push(`no live military flight source answered; the ${read.aircraft.length} aircraft in stale_copy are ${name}'s cached copy as of ${asOf} (${rounded} s old), not current positions, and are not counted`);
            }
            else
                response.data_gaps.push('no military flight source answered: the aircraft count is unknown, not zero');
            return response;
        } };
}
