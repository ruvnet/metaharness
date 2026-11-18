// SPDX-License-Identifier: MIT
// Port of sources/prediction.py and kalshi.py, marc-shade/world-intel-mcp fdebf9a8.
// Read-only public market data. No trading/account endpoints or credentials.
import { MarketTransport, pyRound, type MarketOptions } from './markets.js';
import { matchPredictionMarkets } from './prediction-matching.js';
import type { DomainHandlers } from '../domain-runtime.js';
export type PredictionRecord = Record<string, any>;
type Obj = PredictionRecord;
export interface PredictionOptions extends MarketOptions {
    transport?: {
        json(url: URL, ttlSeconds?: number): Promise<unknown>;
    };
}
export const POLY_UNITS = { price: 'Polymarket prices are USDC per share paying 1 USDC (0.63 = 63% implied probability)', volume: 'USDC notional' };
export const KALSHI_UNITS = { price: 'Kalshi quotes YES contracts in US dollars per $1 payout (fields *_dollars, decimal strings); 0.63 means a 63% implied YES probability', volume: 'contracts (volume_fp, decimal strings); lifetime unless the field says 24h' };
const obj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
export const clipPredictionText = (v: unknown, n = 500) => { const s = v == null ? '' : String(v), chars = Array.from(s); return chars.length <= n ? s : chars.slice(0, n - 3).join('') + '...'; };
export const predictionNumber = (v: unknown): number | null => v === null || v === undefined || v === '' || typeof v === 'boolean' || !['string', 'number'].includes(typeof v) || !Number.isFinite(Number(v)) ? null : Number(v);
export const predictionPrice = (v: unknown): number | null => { const n = predictionNumber(v); return n !== null && n >= 0 && n <= 1 ? n : null; };
const volume = (v: unknown) => { if (v === null || v === undefined || v === '')
    return 0; const n = predictionNumber(v); return n !== null && n >= 0 ? n : null; };
const jsonList = (v: unknown): any[] => { if (Array.isArray(v))
    return v; if (typeof v !== 'string')
    return []; try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : [];
}
catch {
    return [];
} };
const repr = (v: unknown) => typeof v === 'string' ? `'${v}'` : v === true ? 'True' : v === false ? 'False' : v == null ? 'None' : String(v);
export function predictionCount(v: unknown, name: string, high: number): number { if (typeof v !== 'number' || !Number.isInteger(v))
    throw Error(`${name} must be a whole number from 1 to ${high} (got ${repr(v)})`); return Math.max(1, Math.min(v, high)); }
export const predictionEventUrl = (slug: unknown) => typeof slug === 'string' && /^[a-z0-9-]{1,200}$/.test(slug) ? `https://polymarket.com/event/${slug}` : '';
export const validKalshiSeries = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v);
export const validKalshiTicker = (v: unknown): v is string => typeof v === 'string' && /^[A-Z0-9][A-Z0-9._-]{0,99}$/.test(v);
export function normalizeGammaMarket(item: Obj): Obj | null {
    const outcomes = jsonList(item.outcomes).map(x => clipPredictionText(x, 100)), prices = jsonList(item.outcomePrices).map(predictionPrice);
    if (outcomes.length !== 2 || prices.length !== 2)
        return null;
    const bid = predictionPrice(item.bestBid), ask = predictionPrice(item.bestAsk), two = bid !== null && ask !== null && 0 < bid && bid <= ask && ask < 1, events = Array.isArray(item.events) ? item.events : [], event = obj(events[0]) ? events[0] : {}, slug = event.slug || item.slug || '';
    return { venue: 'polymarket', id: String(item.id || item.conditionId || slug), question: clipPredictionText(item.question || ''), context: event.title !== item.question ? clipPredictionText(event.title ?? '') : '', yes_side: '', outcomes, outcome_prices: prices, end_time: item.endDate ?? null, closed_time: item.closedTime ?? null, probability: two ? pyRound((bid! + ask!) / 2, 4) : prices[0] !== null ? pyRound(prices[0], 4) : null, price_basis: two ? 'bid_ask_midpoint' : prices[0] !== null ? 'gamma_outcome_price' : 'no_price', yes_bid: bid, yes_ask: ask, spread: two ? pyRound(ask! - bid!, 4) : null, last_price: predictionPrice(item.lastTradePrice), last_trade_time: null, volume: volume(item.volumeNum ?? item.volume), volume_24h: volume(item.volume24hr), token_ids: jsonList(item.clobTokenIds).map(String), event_id: String(event.id || ''), resolution_status: item.umaResolutionStatus ?? null, url: predictionEventUrl(slug) };
}
export function normalizeKalshiMarket(m: Obj, event: Obj = {}): Obj {
    const bid = predictionPrice(m.yes_bid_dollars), ask = predictionPrice(m.yes_ask_dollars), last = predictionPrice(m.last_price_dollars), two = bid !== null && ask !== null && 0 < bid && bid <= ask && ask < 1, eventTicker = m.event_ticker || event.event_ticker || '', series = event.series_ticker || (eventTicker ? eventTicker.split('-')[0] : ''), yes = m.yes_sub_title || '', title = m.title || '', stale = !!event._stale;
    return { venue: 'kalshi', id: m.ticker ?? '', question: clipPredictionText(title), context: clipPredictionText(event.title ?? ''), yes_side: yes.trim().toLowerCase() === title.trim().toLowerCase() ? '' : clipPredictionText(yes), outcomes: ['Yes', 'No'], end_time: m.expected_expiration_time || m.close_time || null, close_time: m.close_time ?? null, probability: two ? pyRound((bid! + ask!) / 2, 4) : last !== null && last > 0 ? pyRound(last, 4) : null, price_basis: two ? 'bid_ask_midpoint' : last !== null && last > 0 ? 'last_trade' : 'no_price', yes_bid: bid, yes_ask: ask, spread: two ? pyRound(ask! - bid!, 4) : null, last_price: last, last_trade_time: null, stale, stale_age_seconds: stale ? predictionNumber(event._stale_age_seconds) : null, volume: volume(m.volume_fp), volume_24h: volume(m.volume_24h_fp), open_interest: predictionNumber(m.open_interest_fp), event_ticker: eventTicker, series_ticker: series, category: event.category ?? null, status: m.status ?? null, url: validKalshiSeries(series) ? `https://kalshi.com/markets/${encodeURIComponent(series.toLowerCase())}` : '' };
}
const maxAge = (ages: (number | null)[]) => ages.some(x => x !== null) ? Math.max(...ages.filter((x): x is number => x !== null)) : null;
const staleGap = (what: string, ages: (number | null)[]) => { const age = maxAge(ages); return `${what}: ${ages.length} response(s) served from expired cache after a failed live fetch${age !== null ? `, the oldest ${(age / 3600).toFixed(1)} h old` : ''}`; };
const shape = (v: unknown) => Array.isArray(v) ? 'list' : v === null ? 'NoneType' : typeof v === 'object' ? 'dict' : typeof v === 'string' ? 'str' : typeof v === 'boolean' ? 'bool' : 'float';
export class PredictionClient {
    readonly now: () => number;
    private tr: MarketTransport | null;
    private transport: {
        json(url: URL, ttlSeconds?: number): Promise<unknown>;
    };
    constructor(options: PredictionOptions = {}) { this.now = options.now ?? Date.now; this.tr = options.transport ? null : new MarketTransport(options); this.transport = options.transport ?? this.tr!; }
    timestamp() { return new Date(this.now()).toISOString().replace(/\.000Z$/, '+00:00').replace(/Z$/, '+00:00'); }
    async read(base: string, params: Obj = {}, ttl = 300): Promise<{
        data: any;
        stale: boolean;
        age: number | null;
    }> { const u = new URL(base); for (const [k, v] of Object.entries(params))
        u.searchParams.set(k, String(v)); let data: unknown = null; try {
        data = await this.transport.json(u, ttl);
    }
    catch { } if (data !== null && data !== undefined)
        return { data, stale: obj(data) && !!data._stale, age: obj(data) && data._stale ? predictionNumber(data._stale_age_seconds) : null }; const old = this.tr?.stale(u); if (old) {
        try {
            return { data: JSON.parse(old.text), stale: true, age: Math.max(0, (this.now() - old.time) / 1000) };
        }
        catch { }
    } return { data: null, stale: false, age: null }; }
    async kalshi(path: string, params: Obj = {}, ttl = 300, ages?: (number | null)[]): Promise<any> { const r = await this.read(`https://api.elections.kalshi.com/trade-api/v2${path}`, params, ttl); if (r.stale) {
        ages?.push(r.age);
        if (obj(r.data))
            return { ...r.data, _stale: true, _stale_age_seconds: r.age };
    } return r.data; }
    async events(params: Obj, maxPages: number, ages: (number | null)[]): Promise<{
        events: Obj[];
        pages: number;
        exhaustive: boolean;
        error: string | null;
    }> { const events: Obj[] = []; let cursor = '', pages = 0; while (pages < maxPages) {
        const q = { ...params, limit: '200', with_nested_markets: 'true', ...(cursor ? { cursor } : {}) }, d = await this.kalshi('/events', q, 300, ages);
        if (!obj(d) || !Array.isArray(d.events))
            return { events, pages, exhaustive: false, error: `Kalshi /events page ${pages + 1} unavailable (no live or cached data)` };
        pages++;
        for (const e of d.events.filter(obj))
            events.push(d._stale ? { ...e, _stale: true, _stale_age_seconds: predictionNumber(d._stale_age_seconds) } : e);
        cursor = d.cursor || '';
        if (!cursor)
            return { events, pages, exhaustive: true, error: null };
    } return { events, pages, exhaustive: false, error: null }; }
    async topSeries(category: string, limit: number, ages: (number | null)[]): Promise<{
        series: Obj[];
        error: string | null;
    }> { const d = await this.kalshi('/series', { category, include_volume: 'true' }, 3600, ages); const rows = obj(d) && 'series' in d ? (d.series ?? []) : null; if (!Array.isArray(rows))
        return { series: [], error: `Kalshi /series?category=${category} unavailable (no live or cached data)` }; return { series: rows.filter(s => obj(s) && s.ticker && s.category === category).sort((a, b) => (predictionNumber(b.volume_fp) || 0) - (predictionNumber(a.volume_fp) || 0)).slice(0, limit), error: null }; }
    async kalshiOpen(a: Obj = {}): Promise<Obj> {
        const pages = predictionCount(a.pages ?? 3, 'pages', 25), seriesLimit = predictionCount(a.series_limit ?? 10, 'series_limit', 25), ages: (number | null)[] = [], errors: string[] = [], gaps: string[] = [], events: Obj[] = [];
        let scan: Obj;
        if (a.series) {
            const r = await this.events({ status: 'open', series_ticker: a.series }, 25, ages);
            events.push(...r.events);
            scan = { mode: 'series', series: a.series, pages_fetched: r.pages, exhaustive: r.exhaustive };
            if (r.error)
                errors.push(r.error);
        }
        else if (a.category) {
            const top = await this.topSeries(a.category, seriesLimit, ages);
            scan = { mode: 'category_top_series', category: a.category, series_ranked_by: 'lifetime series volume (contracts)', series_scanned: top.series.map(s => s.ticker), exhaustive: false };
            if (top.error)
                errors.push(top.error);
            else if (!top.series.length)
                gaps.push(`Kalshi lists no series in category '${a.category}'; category names are exact (e.g. 'Economics', 'Politics', 'Elections', 'Financials', 'Climate and Weather')`);
            const failed: string[] = [];
            for (const s of top.series) {
                const r = await this.events({ status: 'open', series_ticker: s.ticker }, 5, ages);
                events.push(...r.events);
                if (r.error)
                    failed.push(s.ticker);
            }
            if (failed.length)
                errors.push(`open events unavailable for series [${failed.map(repr).join(', ')}]`);
        }
        else {
            const r = await this.events({ status: 'open' }, pages, ages);
            events.push(...r.events);
            scan = { mode: 'open_events_pages', pages_fetched: r.pages, page_size: 200, exhaustive: r.exhaustive, api_order: 'events by close time, furthest out first' };
            if (r.error)
                errors.push(r.error);
            else if (!r.exhaustive)
                gaps.push(`scanned ${r.pages} page(s) of open events; more exist and were not read, so the ranking covers only the scanned events`);
        }
        const markets: Obj[] = [];
        let bad = 0;
        for (const ev of events) {
            if (a.category && ev.category && ev.category !== a.category)
                continue;
            for (const m of ev.markets ?? []) {
                if (!obj(m) || ![null, undefined, 'active', 'open'].includes(m.status))
                    continue;
                markets.push(normalizeKalshiMarket(m, ev));
                if (['yes_bid_dollars', 'yes_ask_dollars', 'last_price_dollars'].some(k => m[k] !== null && m[k] !== undefined && m[k] !== '' && predictionPrice(m[k]) === null))
                    bad++;
            }
        }
        scan.events_scanned = events.length;
        if (bad)
            gaps.push(`${bad} market(s) with a quote field that is not a price from 0 to 1 (left null; the price falls back or is missing)`);
        if (ages.length) {
            scan.stale_responses = ages.length;
            scan.stale_max_age_seconds = maxAge(ages);
            gaps.push(staleGap('Kalshi open markets', ages));
        }
        return { markets, scan, errors, data_gaps: [...errors, ...gaps], nothing_read: !events.length && !!errors.length, stale: !!ages.length };
    }
    async polymarketOpen(limit = 300): Promise<Obj> { limit = predictionCount(limit, 'limit', 2000); const rows: {
        item: Obj;
        age: number | null;
        stale: boolean;
    }[] = [], ages: (number | null)[] = []; let offset = 0, error: null | string = null; while (offset < limit) {
        const size = Math.min(100, limit - offset), r = await this.read('https://gamma-api.polymarket.com/markets', { limit: size, offset, active: 'true', closed: 'false', order: 'volume24hr', ascending: 'false' });
        if (!Array.isArray(r.data)) {
            error = r.data === null ? 'Polymarket Gamma API unavailable (no live or cached data)' : `Unexpected Polymarket response shape: ${shape(r.data)}`;
            break;
        }
        if (r.stale)
            ages.push(r.age);
        for (const item of r.data.filter(obj))
            rows.push({ item, age: r.age, stale: r.stale });
        if (r.data.length < size)
            break;
        offset += size;
    } const markets = rows.flatMap(r => { const m = normalizeGammaMarket(r.item); return m ? [{ ...m, stale: r.stale, stale_age_seconds: r.age }] : []; }); return { markets, requested: limit, rows_read: rows.length, non_binary_skipped: rows.length - markets.length, ...(error ? { error, degraded: true } : {}), ...(ages.length ? { stale: true, stale_max_age_seconds: maxAge(ages) } : {}) }; }
}
export function createPredictionHandlers(options: PredictionOptions = {}): DomainHandlers {
    const client = new PredictionClient(options);
    return {
        intel_prediction_compare: async (a) => fetchPredictionCompare(client, a),
        intel_prediction_settled: async (a) => fetchPredictionSettled(client, a),
        intel_prediction_markets: async (a) => { const limit = predictionCount(a.limit ?? 20, 'limit', 2000), r = await client.read('https://gamma-api.polymarket.com/markets', { limit, active: 'true', closed: 'false', order: 'volume24hr', ascending: 'false' }), base = { markets: [], count: 0, source: 'polymarket', timestamp: client.timestamp() }; if (!Array.isArray(r.data))
            return { ...base, error: r.data === null ? 'Polymarket Gamma API unavailable (no live or cached data)' : `Unexpected Polymarket response shape: ${shape(r.data)}, expected a list`, degraded: true }; let unpriced = 0; const markets: Obj[] = []; for (const item of r.data) {
            if (!obj(item))
                continue;
            let p = null;
            try {
                const prices = typeof item.outcomePrices === 'string' ? JSON.parse(item.outcomePrices) : null;
                if (Array.isArray(prices))
                    p = predictionPrice(prices[0]);
            }
            catch { }
            if (p === null) {
                unpriced++;
                continue;
            }
            markets.push({ question: clipPredictionText(item.question ?? ''), yes_probability: pyRound(p, 4), sentiment: p > .85 ? 'strong_yes' : p > .65 ? 'leaning_yes' : p < .15 ? 'strong_no' : p < .35 ? 'leaning_no' : 'uncertain', volume_24h: predictionNumber(item.volume24hr) ?? 0, total_volume: predictionNumber(item.volume) ?? 0, liquidity: predictionNumber(item.liquidity) ?? 0, category: item.category ?? '', url: predictionEventUrl(item.slug ?? '') });
        } markets.sort((a, b) => b.volume_24h - a.volume_24h); const gaps: string[] = []; if (r.stale)
            gaps.push('served from expired cache after a failed live fetch'); if (unpriced)
            gaps.push(`${unpriced} market(s) left out: outcome price missing, unreadable or outside 0..1`); return { ...base, markets, count: markets.length, ...(r.stale ? { stale: true, degraded: true } : {}), ...(gaps.length ? { data_gaps: gaps } : {}) }; },
        intel_kalshi_markets: async (a) => { let limit, pages, series_limit; try {
            limit = predictionCount(a.limit ?? 20, 'limit', 500);
            pages = predictionCount(a.pages ?? 3, 'pages', 25);
            series_limit = predictionCount(a.series_limit ?? 10, 'series_limit', 25);
        }
        catch (e) {
            return { error: (e as Error).message, degraded: true, source: 'kalshi', timestamp: client.timestamp() };
        } const raw = await client.kalshiOpen({ ...a, pages, series_limit }), readable = raw.markets.filter((m: Obj) => m.volume !== null && m.volume_24h !== null), unreadable = raw.markets.length - readable.length, untraded = readable.filter((m: Obj) => m.volume <= 0).length, markets = (a.include_untraded ? readable : readable.filter((m: Obj) => m.volume > 0)).sort((a: Obj, b: Obj) => b.volume_24h - a.volume_24h || b.volume - a.volume), gaps = [...raw.data_gaps]; if (unreadable)
            gaps.push(`${unreadable} market(s) left out: volume unreadable (not a finite contract count)`); return { markets: markets.slice(0, limit), count: Math.min(markets.length, limit), markets_considered: markets.length, untraded_excluded: a.include_untraded ? 0 : untraded, volume_unreadable_excluded: unreadable, source: 'kalshi', scan: raw.scan, units: KALSHI_UNITS, data_gaps: gaps, timestamp: client.timestamp(), ...(raw.errors.length || raw.stale ? { degraded: true } : {}), ...(raw.stale ? { stale: true } : {}), ...(raw.errors.length && raw.nothing_read ? { error: raw.errors[0] } : {}) }; },
    };
}
const SETTLED_COMPARABILITY = "Each venue is scored on its own sample of different markets; the Brier scores are not a head-to-head comparison of the same events. Markets of one event are correlated: n counts markets, distinct_events counts the venue's event ids behind them, and one real-world event can span several ids (Polymarket lists a match's result, halftime and totals markets as separate events). A strike ladder's far strikes trade near 0 or 1 and pull a Brier score down. Reference times differ by venue: Kalshi counts back from close_time, when trading actually ended (measured on 40 settled sports markets: 2.2 to 5.2 h before the expected expiration, settled 1.5 to 6.1 minutes later); Polymarket from the earlier of endDate (scheduled end; a game's start) and closedTime (closed after resolution), and Gamma publishes no time at which the outcome became known, so an early resolution can put an offset point after it. Each offset scores only the markets with a price inside the staleness limit at that offset, so samples differ by offset: compare n per offset.";
type History = [
    number,
    number
][];
const epoch = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Math.trunc(Date.parse(v) / 1000) : null;
function boundedNumber(v: unknown, name: string, lo: number, hi: number): number { if (typeof v !== 'number' || !Number.isFinite(v))
    throw Error(`${name} must be a finite number (got ${repr(v)})`); if (v < lo || v > hi)
    throw Error(`${name} must be from ${lo} to ${hi} (got ${repr(v)})`); return v; }
export function predictionOffsets(v: unknown): number[] { const raw = v == null || Array.isArray(v) && v.length === 0 ? [24, 168] : v; if (!Array.isArray(raw))
    throw Error(`offsets_hours must be a list of hours (got ${repr(v)})`); if (raw.length > 10)
    throw Error(`offsets_hours takes at most 10 values (got ${raw.length})`); for (const o of raw)
    if (typeof o !== 'number' || !Number.isFinite(o) || o > 8760)
        throw Error(`offsets_hours values must be numbers of hours up to 8760 (got ${repr(o)})`); if (!raw.some(o => o > 0))
    throw Error(`offsets_hours must contain at least one positive number of hours (got [${raw.join(', ')}])`); for (const o of raw)
    if (o <= 0)
        throw Error(`offsets_hours values must be above 0 hours (got ${repr(o)})`); return [...new Set(raw)].sort((a, b) => a - b); }
export function scorePredictionVenue(markets: Obj[], histories: Record<string, History | null>, offsets: number[], maxStaleness: number, staleIds = new Set<string>()): {
    scores: Obj;
    sample: Obj[];
} {
    const scores: Obj = {}, prices: Obj = Object.fromEntries(markets.map(m => [m.id, {}]));
    for (const off of offsets) {
        const label = `${off}h`, forecasts: [
            number,
            number
        ][] = [], events = new Set(), excluded: Obj = {};
        for (const m of markets) {
            const hist = histories[m.id];
            let p: number | null = null, key = '';
            if (hist == null || staleIds.has(m.id))
                key = hist == null ? 'price history unavailable' : 'price history served from expired cache';
            else {
                const target = m.reference_ts - Math.trunc(off * 3600), floor = target - Math.trunc(maxStaleness * 3600);
                let best: [
                    number,
                    number
                ] | null = null;
                for (const point of hist)
                    if (point[1] !== null && point[0] <= target && (!best || point[0] > best[0]))
                        best = point;
                if (!best)
                    key = 'no price at or before the offset';
                else if (best[0] < floor)
                    key = 'last price older than the staleness limit';
                else if (!Number.isFinite(best[1]) || best[1] < 0 || best[1] > 1)
                    key = 'price outside 0..1';
                else
                    p = best[1];
            }
            prices[m.id][label] = p;
            if (p === null) {
                excluded[key] = (excluded[key] ?? 0) + 1;
                continue;
            }
            forecasts.push([p, m.outcome]);
            events.add(m.event || m.id);
        }
        scores[label] = { n: forecasts.length, distinct_events: events.size, brier: forecasts.length ? pyRound(forecasts.reduce((sum, [p, o]) => sum + (p - o) ** 2, 0) / forecasts.length, 4) : null, yes_rate: forecasts.length ? pyRound(forecasts.reduce((s, [, o]) => s + o, 0) / forecasts.length, 4) : null, excluded };
    }
    return { scores, sample: markets.map(m => ({ id: m.id, event: m.event ?? null, question: m.question, yes_side: m.yes_side || null, outcome: m.outcome, result: m.result, volume: m.volume, settled_at: m.settled_at, reference: m.reference ?? null, price_before_reference: prices[m.id] })) };
}
function venueResult(markets: Obj[], histories: Record<string, History | null>, offsets: number[], max: number, errors: string[], staleIds: Set<string>): Obj { const unusable = markets.filter(m => histories[m.id] == null || staleIds.has(m.id)); if (markets.length && unusable.length === markets.length) {
    const stale = unusable.filter(m => histories[m.id] != null).length, reason = !stale ? 'price history unavailable for every market in the sample' : stale === markets.length ? 'price history served from expired cache for every market in the sample' : `price history unavailable or served from expired cache for every market in the sample (${stale} from expired cache)`;
    return { history_errors: errors, scored: false, not_scored_reason: reason, scores: null, sample: [] };
} return { history_errors: errors, scored: !!markets.length, ...scorePredictionVenue(markets, histories, offsets, max, staleIds), ...(!markets.length ? { not_scored_reason: 'no settled markets passed the selection' } : {}) }; }
export async function fetchPolymarketSettled(client: PredictionClient, limit: number, minVolume: number, minOpen: number): Promise<Obj> { const r = await client.read('https://gamma-api.polymarket.com/markets', { limit: 100, closed: 'true', order: 'closedTime', ascending: 'false', volume_num_min: minVolume }, 900); if (!Array.isArray(r.data))
    return { markets: [], listing_rows_read: 0, error: 'Polymarket closed-markets listing unavailable (no live or cached data)' }; const markets: Obj[] = []; let tooShort = 0, volumeSkipped = 0; for (const item of r.data) {
    if (!obj(item))
        continue;
    const m = normalizeGammaMarket(item);
    if (!m || m.resolution_status !== 'resolved' || !m.token_ids.length || JSON.stringify(m.outcome_prices.filter((p: any) => p !== null).sort()) !== '[0,1]')
        continue;
    const closed = epoch(m.closed_time);
    if (closed === null)
        continue;
    if (m.volume === null || m.volume < minVolume) {
        volumeSkipped++;
        continue;
    }
    const scheduled = epoch(m.end_time), ref = scheduled === null ? closed : Math.min(scheduled, closed), reference = scheduled === null ? 'closedTime (no endDate published)' : scheduled < closed ? 'endDate (scheduled end; the market closed later, after resolution)' : 'closedTime (closed at or before its scheduled endDate)', opened = epoch(item.startDate);
    if (minOpen && (opened === null || ref - opened < minOpen * 3600)) {
        tooShort++;
        continue;
    }
    markets.push({ venue: 'polymarket', id: m.id, question: m.question, yes_side: m.outcomes[0], event: m.event_id || m.id, outcome: m.outcome_prices[0] === 1 ? 1 : 0, result: m.outcomes[m.outcome_prices[0] === 1 ? 0 : 1], volume: m.volume, token_id: m.token_ids[0], reference_ts: ref, reference, settled_at: m.closed_time });
    if (markets.length >= limit)
        break;
} return { markets, listing_rows_read: r.data.length, open_too_briefly_skipped: tooShort, volume_skipped: volumeSkipped, error: null, ...(r.stale ? { stale: true, data_gaps: ['closed-markets listing served from expired cache after a failed live fetch'] } : {}) }; }
export async function fetchKalshiSettled(client: PredictionClient, a: Obj): Promise<Obj> {
    const candidates: Obj[] = [], skipped: Obj = { result: 0, volume: 0, too_short: 0 }, errors: string[] = [], gaps: string[] = [], ages: (number | null)[] = [];
    let invalid = 0, seen = 0, fetched = 0, scope: (string | null)[];
    if (a.series)
        scope = [a.series];
    else if (a.category) {
        const top = await client.topSeries(a.category, a.seriesLimit, ages);
        if (top.error)
            errors.push(top.error);
        else if (!top.series.length)
            gaps.push(`Kalshi lists no series in category '${a.category}'; category names are exact (e.g. 'Economics', 'Politics', 'Elections', 'Financials', 'Climate and Weather')`);
        scope = top.series.map(s => s.ticker);
    }
    else
        scope = [null];
    for (const tick of scope) {
        let cursor = '';
        for (let page = 0; page < (tick === null ? 10 : 3); page++) {
            const d = await client.kalshi('/markets', { status: 'settled', mve_filter: 'exclude', limit: 200, ...(tick ? { series_ticker: tick } : {}), ...(cursor ? { cursor } : {}) }, 900, ages);
            if (!obj(d) || !Array.isArray(d.markets)) {
                errors.push(`Kalshi settled markets unavailable for ${tick || 'the exchange listing'}`);
                break;
            }
            fetched++;
            for (const m of d.markets) {
                if (!obj(m))
                    continue;
                seen++;
                if (!validKalshiTicker(m.ticker)) {
                    invalid++;
                    continue;
                }
                const result = String(m.result || '').toLowerCase(), v = volume(m.volume_fp), ref = epoch(m.close_time), opened = epoch(m.open_time);
                let why = '';
                if (!['yes', 'no'].includes(result))
                    why = 'result';
                else if (v === null || v < a.minVolume)
                    why = 'volume';
                else if (ref === null)
                    why = 'result';
                else if (a.minOpen && (opened === null || ref - opened < a.minOpen * 3600))
                    why = 'too_short';
                if (why) {
                    skipped[why]++;
                    continue;
                }
                candidates.push({ venue: 'kalshi', id: m.ticker, question: clipPredictionText(m.title ?? ''), yes_side: clipPredictionText(m.yes_sub_title || ''), event: m.event_ticker || '', outcome: result === 'yes' ? 1 : 0, result, volume: v, open_ts: opened, reference_ts: ref, reference: 'close_time (trading end)', settled_at: m.settlement_ts ?? null });
            }
            cursor = d.cursor || '';
            if (!cursor || tick === null && candidates.length >= a.limit)
                break;
        }
    }
    candidates.sort((a, b) => String(b.settled_at || '').localeCompare(String(a.settled_at || '')));
    return { markets: candidates.slice(0, a.limit), scope: { series: a.series ?? null, category: a.category ?? null, series_read: scope.filter(Boolean) }, listing_rows_read: seen, skipped, open_too_briefly_skipped: skipped.too_short, invalid_ticker_skipped: invalid, pages_fetched: fetched, stale_responses: ages.length, stale_max_age_seconds: maxAge(ages), stale_gap: ages.length ? staleGap('Kalshi settled listing', ages) : null, error: errors.length && !candidates.length ? errors[0] : null, errors, data_gaps: gaps };
}
export async function fetchKalshiHistory(client: PredictionClient, markets: Obj[], windowStart: number, windowEnd: number): Promise<{
    histories: Record<string, History | null>;
    errors: string[];
    staleIds: Set<string>;
}> { const histories: Record<string, History | null> = {}, errors: string[] = [], staleIds = new Set<string>(), staleAges: (number | null)[] = []; let batch: {
    m: Obj;
    start: number;
    end: number;
}[] = []; const flush = async () => { if (!batch.length)
    return; const start = Math.min(...batch.map(x => x.start)), end = Math.max(...batch.map(x => x.end)), ages: (number | null)[] = [], data = await client.kalshi('/markets/candlesticks', { market_tickers: batch.map(x => x.m.id).join(','), start_ts: start, end_ts: end, period_interval: 60 }, 21600, ages); if (!obj(data) || !Array.isArray(data.markets))
    errors.push(`candlesticks unavailable for ${batch.length} market(s)`);
else {
    if (ages.length)
        for (const { m } of batch) {
            staleIds.add(m.id);
            staleAges.push(ages[0]);
        }
    for (const entry of data.markets) {
        if (!obj(entry))
            continue;
        const points: History = [];
        for (const c of entry.candlesticks ?? []) {
            const p = predictionNumber(c?.price?.close_dollars), ts = c?.end_period_ts;
            if (p !== null && Number.isInteger(ts))
                points.push([ts, p]);
        }
        histories[entry.market_ticker ?? ''] = points;
    }
} batch = []; }; for (const m of markets) {
    let start = m.reference_ts - Math.trunc(windowStart * 3600);
    if (m.open_ts)
        start = Math.max(start, m.open_ts);
    const end = m.reference_ts - Math.trunc(windowEnd * 3600);
    if (end <= start) {
        histories[m.id] = [];
        continue;
    }
    const ns = Math.min(start, ...batch.map(x => x.start)), ne = Math.max(end, ...batch.map(x => x.end)), cost = (Math.floor((ne - ns) / 3600) + 1) * (batch.length + 1);
    if (batch.length && cost > 9000)
        await flush();
    batch.push({ m, start, end });
} await flush(); if (staleIds.size) {
    const oldest = maxAge(staleAges);
    errors.push(`candlesticks for ${staleIds.size} market(s) served from expired cache after a failed live fetch${oldest !== null ? `, the oldest ${(oldest / 3600).toFixed(1)} h old` : ''}`);
} return { histories, errors, staleIds }; }
export async function fetchPredictionSettled(client: PredictionClient, a: Obj = {}): Promise<Obj> {
    let offsets: number[], limit: number, seriesLimit: number, kv: number, pv: number, max: number;
    try {
        offsets = predictionOffsets(a.offsets_hours);
        limit = predictionCount(a.limit ?? 25, 'limit', 100);
        seriesLimit = predictionCount(a.kalshi_series_limit ?? 10, 'kalshi_series_limit', 25);
        kv = boundedNumber(a.kalshi_min_volume ?? 1000, 'kalshi_min_volume', 0, 1e12);
        pv = boundedNumber(a.polymarket_min_volume ?? 10000, 'polymarket_min_volume', 0, 1e12);
        max = boundedNumber(a.max_staleness_hours ?? 168, 'max_staleness_hours', 0, 720);
    }
    catch (e) {
        return { error: (e as Error).message, degraded: true, source: 'kalshi+polymarket', timestamp: client.timestamp() };
    }
    const windowStart = Math.max(...offsets) + max, windowEnd = Math.min(...offsets), category = a.kalshi_series ? null : a.kalshi_category === undefined ? 'Economics' : a.kalshi_category, k = await fetchKalshiSettled(client, { limit, minVolume: kv, series: a.kalshi_series, category, seriesLimit, minOpen: windowEnd }), scope = a.kalshi_series ? `series ${a.kalshi_series}` : category ? `the ${k.scope.series_read.length} highest-lifetime-volume series in category '${category}': [${k.scope.series_read.map(repr).join(', ')}]` : 'the exchange-wide settled listing (intraday sports dominate it)';
    let selection = `most recently settled Kalshi markets (combos excluded) from ${scope}, with result yes/no, lifetime volume >= ${kv} contracts and open >= ${windowEnd}h before close; first ${limit} kept from ${k.listing_rows_read} listing rows read (${k.open_too_briefly_skipped} skipped as open too briefly)`;
    if (k.stale_responses)
        selection += `; ${k.stale_responses} listing response(s) served from expired cache`;
    const ke: Obj = { selection, reference_time: 'close_time (when trading ended; the actual close when a market closes early)', price_source: 'batch /markets/candlesticks, hourly, price.close_dollars (last trade in the hour)', settled_markets: k.markets.length }, listingGaps = k.stale_gap ? [k.stale_gap] : [];
    if (k.error && !k.markets.length)
        Object.assign(ke, { error: k.error, scored: false, scores: null, sample: [], history_errors: listingGaps });
    else {
        const h = await fetchKalshiHistory(client, k.markets, windowStart, windowEnd);
        Object.assign(ke, venueResult(k.markets, h.histories, offsets, max, [...h.errors, ...k.errors, ...listingGaps], h.staleIds));
        if (k.data_gaps.length && !k.markets.length)
            ke.not_scored_reason = k.data_gaps.join('; ');
    }
    const p = await fetchPolymarketSettled(client, limit, pv, windowEnd);
    let ps = `most recently closed Polymarket binary markets with volume >= ${pv} USDC, UMA status resolved, final prices exactly 1/0, open >= ${windowEnd}h before the reference time; first ${limit} kept from ${p.listing_rows_read} listing rows read (${p.open_too_briefly_skipped ?? 0} skipped as open too briefly${p.volume_skipped ? `, ${p.volume_skipped} below the volume floor or unreadable` : ''}); first outcome is the YES side`;
    if (p.stale)
        ps += '; the listing was served from expired cache';
    const pe: Obj = { selection: ps, reference_time: "the earlier of endDate (scheduled end; a game's start) and closedTime (closed after resolution); each sample entry names which", price_source: 'CLOB /prices-history, hourly fidelity, first outcome token', settled_markets: p.markets.length };
    if (p.error)
        Object.assign(pe, { error: p.error, scored: false, scores: null, sample: [] });
    else {
        const histories: Record<string, History | null> = {}, staleIds = new Set<string>(), ages: (number | null)[] = [];
        let failed = 0;
        for (const m of p.markets) {
            const r = await client.read('https://clob.polymarket.com/prices-history', { market: m.token_id, startTs: m.reference_ts - Math.trunc(windowStart * 3600), endTs: m.reference_ts - Math.trunc(windowEnd * 3600), fidelity: 60 }, 21600);
            if (!obj(r.data) || !Array.isArray(r.data.history)) {
                histories[m.id] = null;
                failed++;
                continue;
            }
            histories[m.id] = r.data.history.filter((x: any) => obj(x) && Number.isInteger(x.t) && predictionNumber(x.p) !== null).map((x: any) => [x.t, Number(x.p)]);
            if (r.stale) {
                staleIds.add(m.id);
                ages.push(r.age);
            }
        }
        const errors = failed ? [`price history unavailable for ${failed} market(s)`] : [];
        if (staleIds.size) {
            const oldest = maxAge(ages);
            errors.push(`price history for ${staleIds.size} market(s) served from expired cache after a failed live fetch${oldest !== null ? `, the oldest ${(oldest / 3600).toFixed(1)} h old` : ''}; not scored`);
        }
        Object.assign(pe, venueResult(p.markets, histories, offsets, max, [...errors, ...(p.data_gaps ?? [])], staleIds));
    }
    const venues = { kalshi: ke, polymarket: pe }, gaps: string[] = [];
    for (const [name, entry] of Object.entries(venues)) {
        if (entry.error)
            gaps.push(`${name}: ${entry.error}`);
        for (const e of entry.history_errors ?? [])
            gaps.push(`${name}: ${e}`);
        if (entry.scored === false && !entry.error)
            gaps.push(`${name}: not scored (${entry.not_scored_reason})`);
    }
    return { source: 'kalshi+polymarket', offsets_hours: offsets, max_staleness_hours: max, venues, comparability: SETTLED_COMPARABILITY, brier: 'mean of (price - outcome)^2 with outcome 1 for YES; 0 is perfect, always 0.5 scores 0.25', data_gaps: gaps, timestamp: client.timestamp(), ...(gaps.length ? { degraded: true } : {}) };
}
const MATCH_METHOD = "Deterministic: titles lowercased with a small synonym table (month names, cut/raise/hold verbs, above/below); quantities must be equal sets (a four-digit number is a year unless a $ sign, a thousands comma or a comparator makes it an amount; signs and ordinals are kept), except that a fractional threshold strict on one venue and inclusive on the other is accepted with a flag; years must intersect when both titles state one; negation, rate actions (cut, raise, hold) and directions (above, below) must agree; end dates within max(3 days, 15% of the horizon); the Kalshi YES side must be named in the Polymarket question or match exactly one Polymarket outcome. When both titles state them, clock times and days of the same month must be equal and months must overlap; quantity units ($, %, bps), 'to' vs 'by' and the order of two or more amounts must agree; opposite words (rise/fall, positive/negative, before/after, win/lose, approve/reject) must not conflict; a distinguishing name (capitalized, or a listed chamber, party, country or qualifier) on both venues but not shared rejects, and a listed one on one venue only rejects. match_confidence = title word overlap (Dice) x date factor (1.0 same day, 0.5 at the tolerance edge): an ordinal score for ranking candidate pairs, not a probability that two markets are the same event. One-to-one, greedy by confidence.";
const LOOKUP_STATUSES = { found: 'time and price of the latest trade, read live', found_in_expired_copy: 'time and price of the latest trade in an expired cached copy (age in last_trade_age_seconds)', no_trade: 'the venue lists no trade for the market', lookup_failed: 'the trades endpoint could not be read or its trade time was unreadable', not_looked_up_cap: 'beyond the first 10 last-trade pairs shown', not_looked_up_deadline: "the lookups' 10 s deadline passed first", not_looked_up_stale_listing: 'the price came from an expired listing copy, so a live trade time would not date it' };
const MATCH_RANKING = 'Pairs with comparable: true (both prices two-sided quote midpoints, spreads at most 0.10, no boundary flag) come first, largest absolute price gap first; flagged pairs follow, ranked the same way among themselves, because a gap taken from a last trade, a listed outcome price, a wide book or thresholds that differ at the boundary is not a like-for-like difference of live prices.';
async function lastPredictionTrades(client: PredictionClient, shown: Obj[]): Promise<string[]> {
    const sides = shown.filter(p => p.kalshi.price_basis === 'last_trade');
    if (!sides.length)
        return [];
    const live = sides.filter(p => !p.kalshi.stale), targets = live.slice(0, 10), times: Obj = {}, prices: Obj = {}, stale: Obj = {}, attempted = new Set(), deadline = Date.now() + 10000;
    let timedOut = false;
    for (const p of targets) {
        const ticker = p.kalshi.id;
        if (!validKalshiTicker(ticker)) {
            attempted.add(ticker);
            continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            timedOut = true;
            break;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = Symbol('timeout');
        const d = await Promise.race([client.kalshi('/markets/trades', { ticker, limit: 1 }, 300), new Promise<typeof timeout>(resolve => { timer = setTimeout(() => resolve(timeout), remaining); })]);
        if (timer)
            clearTimeout(timer);
        if (d === timeout) {
            timedOut = true;
            break;
        }
        attempted.add(ticker);
        if (!obj(d) || !Array.isArray(d.trades))
            continue;
        if (d._stale)
            stale[ticker] = predictionNumber(d._stale_age_seconds);
        if (!d.trades.length) {
            times[ticker] = null;
            prices[ticker] = null;
            continue;
        }
        const created = d.trades[0]?.created_time;
        if (typeof created !== 'string' || epoch(created) === null)
            continue;
        times[ticker] = created;
        prices[ticker] = predictionPrice(d.trades[0].yes_price_dollars);
    }
    const counts: Obj = {};
    for (const p of sides) {
        const side = p.kalshi, ticker = side.id, status = side.stale ? 'not_looked_up_stale_listing' : !targets.includes(p) ? 'not_looked_up_cap' : !attempted.has(ticker) ? 'not_looked_up_deadline' : !(ticker in times) ? 'lookup_failed' : times[ticker] === null ? 'no_trade' : ticker in stale ? 'found_in_expired_copy' : 'found';
        counts[status] = (counts[status] ?? 0) + 1;
        side.last_trade_lookup = status;
        side.last_trade_time = status.startsWith('found') ? times[ticker] : null;
        side.last_trade_price = status.startsWith('found') ? prices[ticker] ?? null : null;
        if (status === 'found_in_expired_copy')
            side.last_trade_age_seconds = stale[ticker];
        const traded = side.last_trade_price, listed = side.last_price;
        if (traded !== null && listed !== null && Math.abs(traded - listed) > 1e-9) {
            p.flags.push(`kalshi last trade at ${traded} (looked up separately) differs from the listing's last price ${listed}`);
            p.comparable = false;
        }
    }
    const gaps: string[] = [];
    if (counts.lookup_failed)
        gaps.push(`Kalshi last-trade time unavailable for ${counts.lookup_failed} market(s)`);
    if (Object.keys(stale).length)
        gaps.push(staleGap('Kalshi last-trade times', Object.values(stale)));
    if (counts.not_looked_up_cap)
        gaps.push(`last-trade time looked up for the first ${targets.length} of ${live.length} last-trade pairs shown; ${counts.not_looked_up_cap} not looked up (cap 10)`);
    if (timedOut)
        gaps.push(`last-trade lookups stopped at the 10 s deadline; ${counts.not_looked_up_deadline ?? 0} pair(s) not looked up`);
    if (counts.not_looked_up_stale_listing)
        gaps.push(`last-trade time not looked up for ${counts.not_looked_up_stale_listing} pair(s) priced from an expired listing copy`);
    return gaps;
}
export async function fetchPredictionCompare(client: PredictionClient, a: Obj = {}): Promise<Obj> { let pages: number, seriesLimit: number, polyLimit: number, limit: number, min: number; try {
    pages = predictionCount(a.kalshi_pages ?? 3, 'kalshi_pages', 25);
    seriesLimit = predictionCount(a.series_limit ?? 10, 'series_limit', 25);
    polyLimit = predictionCount(a.polymarket_limit ?? 300, 'polymarket_limit', 2000);
    limit = predictionCount(a.limit ?? 25, 'limit', 500);
    min = boundedNumber(a.min_confidence ?? .6, 'min_confidence', 0, 1);
}
catch (e) {
    return { error: (e as Error).message, degraded: true, source: 'kalshi+polymarket', timestamp: client.timestamp() };
} const kr = await client.kalshiOpen({ ...a, pages, series_limit: seriesLimit }), pr = await client.polymarketOpen(polyLimit), ks = kr.markets, ps = pr.markets, gaps = kr.data_gaps.map((g: string) => `kalshi: ${g}`); if (pr.error)
    gaps.push(`polymarket: ${pr.error}`); if (pr.stale) {
    gaps.push('polymarket: served from expired cache after a failed live fetch');
    if (pr.stale_max_age_seconds !== null)
        gaps.push(`polymarket: the oldest open-markets copy is ${(pr.stale_max_age_seconds / 3600).toFixed(1)} h old`);
} gaps.push(`polymarket: top ${pr.requested} open markets by 24h volume requested; ${pr.non_binary_skipped} non-binary rows skipped`); const out: Obj = { source: 'kalshi+polymarket', kalshi_scan: kr.scan, kalshi_markets_compared: ks.length, polymarket_markets_compared: ps.length, min_confidence: min, method: MATCH_METHOD, price_gap: 'kalshi YES probability minus polymarket probability of the same side', price_basis: "per side: bid_ask_midpoint (two-sided book), last_trade (Kalshi's last trade; its time and price are looked up for the first 10 such pairs shown, and last_trade_lookup says what a null last_trade_time means), gamma_outcome_price (Polymarket's listed outcome price; Gamma publishes no last-trade time) or no_price. A side priced from an expired cached copy carries stale: true and its age, and is flagged", last_trade_lookup: LOOKUP_STATUSES, ranking: MATCH_RANKING, units: { kalshi: KALSHI_UNITS, polymarket: POLY_UNITS }, timestamp: client.timestamp() }; const down: string[] = []; if (kr.nothing_read)
    down.push('kalshi'); if (pr.error && !ps.length)
    down.push('polymarket'); if (down.length)
    return { ...out, matched: [], matched_count: null, near_misses: [], unmatched_kalshi: down.includes('kalshi') ? null : ks.length, unmatched_polymarket: down.includes('polymarket') ? null : ps.length, error: `comparison not possible: ${down.join(', ')} unavailable`, degraded: true, data_gaps: gaps }; const r = matchPredictionMarkets(ks, ps, min, client.now()), matched = r.matched as Obj[]; matched.sort((a, b) => Number(a.price_gap === null) - Number(b.price_gap === null) || Number(!a.comparable) - Number(!b.comparable) || Math.abs(b.price_gap || 0) - Math.abs(a.price_gap || 0) || b.match_confidence - a.match_confidence); const shown = matched.slice(0, limit); gaps.push(...(await lastPredictionTrades(client, shown)).map(g => `kalshi: ${g}`)); return { ...out, matched: shown, matched_count: matched.length, comparable_count: matched.filter(p => p.comparable).length, near_misses: r.near_misses, pairs_scored: r.pairs_scored, unmatched_kalshi: r.unmatched_kalshi, unmatched_polymarket: r.unmatched_polymarket, data_gaps: gaps, ...(kr.errors.length || kr.stale || pr.error || pr.stale ? { degraded: true } : {}) }; }
