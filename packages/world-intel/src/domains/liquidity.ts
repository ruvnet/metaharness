// MIT port of marc-shade/world-intel-mcp at fdebf9a8. See THIRD_PARTY_NOTICES.md.
import { MarketTransport, pyRound, type MarketOptions, type MarketObject, type MarketHandler } from "./markets.js";
const _FRED_GRAPH_URL: any = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const _ECB_DATA_URL: any = "https://data-api.ecb.europa.eu/service/data/{dataset}/{key}";
const FRED_SOURCE: any = "fred-graph";
const ECB_SOURCE: any = "ecb-data-portal";
const _HEADERS: any = { "User-Agent": "world-intel-mcp (https://github.com/marc-shade/world-intel-mcp)" };
const _FRED_TTL: any = 3600;
const DEFAULT_LIMIT: any = 52;
const _MAX_ECB_SERIES: any = 50;
const FRED_SERIES: any = { "WALCL": { "label": "Federal Reserve total assets", "detail": "Total assets less eliminations from consolidation, Wednesday level", "units": "USD millions", "scale": 1000000, "frequency": "weekly, as of Wednesday", "seasonal_adjustment": "not seasonally adjusted", "measure": "amount_outstanding", "release": "H.4.1 Factors Affecting Reserve Balances", "max_age_days": 10 }, "WDTGAL": { "label": "Treasury General Account (Wednesday level)", "detail": "U.S. Treasury, General Account deposits with F.R. Banks, Wednesday level", "units": "USD millions", "scale": 1000000, "frequency": "weekly, as of Wednesday", "seasonal_adjustment": "not seasonally adjusted", "measure": "amount_outstanding", "release": "H.4.1 Factors Affecting Reserve Balances", "max_age_days": 10 }, "WTREGEN": { "label": "Treasury General Account (week average)", "detail": "U.S. Treasury, General Account deposits with F.R. Banks, average of the week ending Wednesday", "units": "USD millions", "scale": 1000000, "frequency": "weekly, ending Wednesday (week average)", "seasonal_adjustment": "not seasonally adjusted", "measure": "amount_outstanding", "release": "H.4.1 Factors Affecting Reserve Balances", "max_age_days": 10 }, "RRPONTSYD": { "label": "Fed overnight reverse repo", "detail": "Treasury securities sold by the Federal Reserve in overnight reverse repurchase operations; each matures the next business day, so a day's take-up is the amount outstanding overnight", "units": "USD billions", "scale": 1000000000, "frequency": "daily (business days)", "seasonal_adjustment": "not seasonally adjusted", "measure": "amount_outstanding", "release": "Temporary Open Market Operations", "max_age_days": 6 }, "M2SL": { "label": "US M2 money stock", "detail": "M2, monthly average", "units": "USD billions", "scale": 1000000000, "frequency": "monthly", "seasonal_adjustment": "seasonally adjusted", "measure": "amount_outstanding", "release": "H.6 Money Stock Measures", "max_age_days": 100 } };
const US_M3_NOTE: any = "US M3 is discontinued: the Federal Reserve stopped publishing it in 2006 (FRED M3SL ends at 2006-02-01). There is no current US M3 series.";
const NESTING_NOTE: any = "M1 is contained in M2 and M2 in M3: the aggregates nest, so they are never added together.";
const NET_LIQUIDITY_FORMULA: any = "net_liquidity = WALCL - WDTGAL - RRPONTSYD, in USD billions: WALCL and WDTGAL are USD millions divided by 1,000; RRPONTSYD is already USD billions";
const NET_LIQUIDITY_ALIGNMENT: any = "One point per WALCL Wednesday. WDTGAL must be reported for that same Wednesday. RRPONTSYD is taken from that Wednesday, or when that day is blank on or after 2013-09-23, from Tuesday only; before that date a blank Wednesday has no fallback. Each point names the RRP date used. Weeks without an aligned TGA or RRP value are skipped and counted, never filled with zero.";
const TGA_CHOICE_NOTE: any = "The Treasury General Account term is WDTGAL (Wednesday level), not WTREGEN (week average), so all three terms describe the same Wednesday.";
const TGA_WTREGEN_NOTE: any = "WTREGEN is not a drop-in replacement: subtracting a week average from Wednesday-level total assets mixes two different measures. WTREGEN is served on its own by intel_fed_liquidity_series.";
const BLOCKED_SOURCES: any = [{ "measure": "money market fund assets, weekly", "publisher": "ICI", "status": "blocked", "measured": "2026-10-17: HTTP 403 (Akamai 'Access Denied') on www.ici.org/research/stats/mmf and on /robots.txt" }, { "measure": "ETF net issuance, monthly actuals and weekly estimates", "publisher": "ICI", "status": "blocked", "measured": "2026-10-17: HTTP 403 (Akamai 'Access Denied') on www.ici.org/research/stats/etf and on /robots.txt" }, { "measure": "customer margin balances (debit and free credit), monthly", "publisher": "FINRA", "status": "blocked", "measured": "2026-10-17: the margin-statistics XLSX answers 200, but the finra.org Terms of Use (Restrictions d and e) forbid creating a database from the site and using data mining, scraping or harvesting tools, robots included" }, { "measure": "BLS series (for example CPI-U, nonfarm payrolls)", "publisher": "BLS", "status": "blocked", "measured": "2026-10-17: public API v1 answers 200 without a key, but api.bls.gov/robots.txt is 'Disallow: /' and the www.bls.gov terms page answers 403 to this server's User-Agent" }];
const _ECB_MONEY_KEY: any = "M.U2.Y.V.M10+M20+M30.X.1+4+I.U2.2300.Z01.E+A";
const _ECB_AGGREGATE_CODES: any = { "M10": "M1", "M20": "M2", "M30": "M3" };
const _ECB_EUROSYSTEM_KEY: any = "W.U2.C.T000000.Z5.Z01";
const ECB_DATASETS: any = { "BSI": "Balance sheet items of euro area monetary financial institutions (monetary aggregates)", "ILM": "Eurosystem weekly financial statement (internal liquidity management)" };
const _ECB_MAX_AGE_DAYS: any = { "M": 75, "W": 16, "D": 6, "Q": 200, "A": 500 };
const _ECB_KEY_MAX_LEN: any = 200;
const _ECB_KEY_PUNCTUATION: any = [".", "+", "_"];
const _ECB_KEY_DIMENSIONS: any = { "BSI": 11, "ILM": 6 };
const _FRED_GAP: any = "FRED's keyless CSV carries observation dates only: published_at is null, and units/frequency come from the server's series catalog, not the payload.";
const _ECB_NO_SERIES_DETAIL: any = "No Series was returned for the query";
const _ECB_GAP: any = "The ECB Data Portal response carries no release dates: published_at is null; observation status (normal / provisional) is per point.";
const _BOARD_FRED: any = [["fed_total_assets", "WALCL"], ["treasury_general_account", "WDTGAL"], ["reverse_repo", "RRPONTSYD"], ["us_m2", "M2SL"]];
const _BOARD_RANKING_RULES: any = { "biggest_move": "biggest_move ranks absolute changes in billions of each row currency; no FX conversion, and observation horizons differ. Percentage changes do not affect ranking.", "newest": "newest orders rows by the period end of their latest observation, newest first, and rows without a period end last; rows that tie are in reverse alphabetical order of indicator. Changes do not affect the order." };
export type FredRow = [
    string,
    number | null
];
const repr = (v: unknown) => typeof v === 'string' ? `'${v}'` : String(v);
function dateOnly(v: unknown): string { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v)
    throw Error(`start must be an ISO date YYYY-MM-DD, got ${repr(v)}`); return v; }
function parameters(a: MarketObject, def: number): [
    number,
    string | null
] { const n = a.limit ?? def; if (!Number.isInteger(n) || n < 0)
    throw Error(`limit must be a non-negative integer (0 = full history), got ${repr(n)}`); return [n, a.start === undefined || a.start === null || a.start === '' ? null : dateOnly(a.start)]; }
const endMonth = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).toISOString().slice(0, 10);
const change = (a: any, b: any, relative = true) => !a || !b ? null : { absolute: pyRound(a.value - b.value, 3), units: relative ? a.units ?? null : 'percentage points', pct: b.value && relative ? pyRound((a.value - b.value) / Math.abs(b.value) * 100, 4) : null, from: b.observed_at, to: a.observed_at, basis: 'vs previous observation' };
const fresh = (d: string | null, max: number, now: number) => ({ latest_age_days: d ? Math.floor(now / 86400000) - Math.floor(Date.parse(d) / 86400000) : null, expected_max_age_days: max, stale: d ? Math.floor(now / 86400000) - Math.floor(Date.parse(d) / 86400000) > max : null });
const staleGap = (name: string, s: any) => s.freshness.stale ? `${name}: newest observation ${s.latest.observed_at} is ${s.freshness.latest_age_days} days old, past the expected ${s.freshness.expected_max_age_days} (publisher delay, a served stale cache copy, or an outage)` : null;
/** Parse FRED CSV without turning blank observations into zero. */
export function parseFredCsv(text: string, id: string): FredRow[] { const lines = text.split(/\r?\n/).filter(Boolean), split = (s: string) => s.split(',').map(x => x.trim().replace(/^"(.*)"$/, '$1')); const header = split(lines.shift() ?? ''); if (header.length !== 2 || header[0] !== 'observation_date' || header[1] !== id)
    throw Error('unexpected header'); return lines.map(line => { const cells = split(line); if (cells.length !== 2)
    throw Error('unexpected row'); const day = dateOnly(cells[0]), raw = cells[1], value = raw === '' || raw === '.' ? null : Number(raw); if (value !== null && !Number.isFinite(value))
    throw Error('invalid numeric observation'); return [day, value]; }); }
function buildFred(id: string, rows: FredRow[], limit: number, start: string | null, now: number): MarketObject { const meta = FRED_SERIES[id], present = rows.filter((r): r is [
    string,
    number
] => r[1] !== null); if (!present.length)
    throw Error('no observations'); const point = ([d, v]: [
    string,
    number
]) => ({ observed_at: d, value: v, units: meta.units }), latest = point(present.at(-1)!), previous = present.length > 1 ? point(present.at(-2)!) : null; let points = present.filter(([d]) => !start || d >= start).reverse().map(point); if (limit)
    points = points.slice(0, limit); const { max_age_days, ...fields } = meta; return { series_id: id, dataset: `FRED ${id}`, ...fields, published_at: null, latest, previous, change: change(latest, previous), freshness: fresh(meta.frequency === 'monthly' ? endMonth(latest.observed_at) : latest.observed_at, max_age_days, now), first_observed_at: present[0][0], blank_observations: rows.length - present.length, order: 'newest_first', count: points.length, points }; }
export function computeNetLiquidity(walcl: FredRow[], tga: FredRow[], rrp: FredRow[]): {
    points: MarketObject[];
    skipped: string[];
} { const tg = new Map(tga.filter(r => r[1] !== null)), rp = new Map(rrp.filter(r => r[1] !== null)), points: MarketObject[] = [], skipped: string[] = []; for (const [day, assets] of walcl) {
    if (assets === null)
        continue;
    const t = tg.get(day);
    let rd: string | null = rp.has(day) ? day : null;
    if (!rd && day >= '2013-09-23') {
        const prior = new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10);
        if (rp.has(prior))
            rd = prior;
    }
    if (t === undefined || t === null || !rd) {
        skipped.push(day);
        continue;
    }
    const r = rp.get(rd)!;
    points.push({ observed_at: day, value: pyRound(assets / 1000 - t / 1000 - r!, 3), units: 'USD billions', fed_total_assets: pyRound(assets / 1000, 3), treasury_general_account: pyRound(t / 1000, 3), reverse_repo: pyRound(r!, 3), reverse_repo_observed_at: rd });
} return { points, skipped }; }
export function parseSdmxJson(data: MarketObject, dataset: string): MarketObject[] { const structure = data.structure, dims = structure.dimensions.series, periods = structure.dimensions.observation[0].values, defs = structure.attributes.series, obsdefs = structure.attributes.observation, statusPos = obsdefs.findIndex((x: any) => x.id === 'OBS_STATUS'), out: MarketObject[] = []; for (const [skey, raw] of Object.entries(data.dataSets[0].series ?? {})) {
    const body = raw as any, idx = skey.split(':').map(Number), dimension: MarketObject = {}, codes: string[] = [];
    idx.forEach((j, i) => { const code = dims[i].values[j].id; dimension[dims[i].id] = code; codes.push(code); });
    const attrs: MarketObject = {};
    (body.attributes ?? []).forEach((vi: any, pos: number) => { if (Number.isInteger(vi) && vi >= 0 && defs[pos]?.values?.[vi])
        attrs[defs[pos].id] = defs[pos].values[vi]; });
    const base = attrs.UNIT_INDEX_BASE, mult = attrs.UNIT_MULT ?? {}, unit = attrs.UNIT?.id ?? null, exponent = mult.id === undefined ? null : Number(mult.id);
    const scale = base ? 1 : exponent !== null && Number.isInteger(exponent) ? 10 ** exponent : null;
    const units = base ? `index (${base.name || base.id})` : unit === 'PCCH' ? 'percent' : unit && mult.name && mult.name.toLowerCase() !== 'units' ? `${unit} ${mult.name.toLowerCase()}` : unit;
    const measure = dataset === 'ILM' || dimension.DATA_TYPE === '1' ? 'amount_outstanding' : dimension.DATA_TYPE === '4' ? 'flow' : dimension.DATA_TYPE === 'I' ? dimension.BS_SUFFIX === 'A' ? 'growth_rate' : 'index' : 'unknown';
    const points: MarketObject[] = [];
    for (const [oi, obs] of Object.entries(body.observations ?? {})) {
        const ov = obs as any;
        if (!ov?.length || ov[0] === null)
            continue;
        const period = periods[Number(oi)], value = Number(ov[0]);
        if (!Number.isFinite(value))
            throw Error(`observation value for ${period.id} is not a finite number`);
        let end = null;
        try {
            end = dateOnly(period.end.slice(0, 10));
        }
        catch { }
        points.push({ observed_at: period.id, period_end: end, value, units, status: statusPos >= 0 ? obsdefs[statusPos].values?.[ov[statusPos + 1]]?.name ?? null : null });
    }
    points.sort((a, b) => (a.period_end ?? '').localeCompare(b.period_end ?? '') || a.observed_at.localeCompare(b.observed_at));
    out.push({ key: `${dataset}.${codes.join('.')}`, title: attrs.TITLE?.name ?? null, title_full: attrs.TITLE_COMPL?.name ?? null, dimensions: dimension, units, scale, measure, frequency: dimension.FREQ ?? null, points });
} return out.sort((a, b) => a.key.localeCompare(b.key)); }
function finishEcb(s: any, n: number, now: number): MarketObject { const pts = s.points, latest = pts.at(-1) ?? null, previous = pts.at(-2) ?? null; let points = [...pts].reverse(); if (n)
    points = points.slice(0, n); return { ...s, published_at: null, latest, previous, change: s.measure === 'flow' ? null : change(latest, previous, s.measure !== 'growth_rate'), freshness: fresh(latest?.period_end ?? null, _ECB_MAX_AGE_DAYS[s.frequency] ?? 75, now), order: 'newest_first', count: points.length, points }; }
export function createLiquidityHandlers(options: MarketOptions = {}): Record<string, MarketHandler> {
    const tr = new MarketTransport(options), stamp = () => tr.timestamp();
    const fred = async (id: string): Promise<{
        rows: FredRow[] | null;
        error: string | null;
    }> => { const t = await tr.text(tr.url(_FRED_GRAPH_URL, { id }), 3600); if (t === null)
        return { rows: null, error: `FRED graph CSV for ${id} unavailable: upstream fetch failed, no cached copy` }; try {
        const rows = parseFredCsv(t, id);
        if (!rows.some(r => r[1] !== null))
            return { rows: null, error: `FRED graph CSV for ${id} has no observations` };
        return { rows, error: null };
    }
    catch (e) {
        return { rows: null, error: `FRED graph CSV for ${id} not in the expected format (parse error: ${(e as Error).message})` };
    } };
    const ecb = async (ds: string, key: string, n: number, start: string | null): Promise<{
        series: MarketObject[] | null;
        error: string | null;
    }> => { const params: MarketObject = { format: 'jsondata' }; if (n)
        params.lastNObservations = n; if (start)
        params.startPeriod = start; const d = await tr.json(tr.url(`https://data-api.ecb.europa.eu/service/data/${ds}/${key}`, params), 10800); if (d === null)
        return { series: null, error: `ECB Data Portal returned no data for ${ds}/${key}: upstream fetch failed, no cached copy` }; try {
        const series = parseSdmxJson(d, ds);
        if (!series.some(s => s.points.length))
            return { series: null, error: `ECB Data Portal returned no observations for ${ds}/${key}` };
        return { series, error: null };
    }
    catch (e) {
        return { series: null, error: `ECB Data Portal response for ${ds}/${key} not in the expected SDMX-JSON shape (parse error: ${(e as Error).message})` };
    } };
    const handlers: Record<string, MarketHandler> = {
        intel_fed_liquidity_series: async (a) => { const sid = String(a.series_id ?? 'WALCL').trim().toUpperCase(); if (!FRED_SERIES[sid])
            return { error: `unknown series ${repr(a.series_id)}; choose one of ['M2SL', 'RRPONTSYD', 'WALCL', 'WDTGAL', 'WTREGEN']`, series_available: Object.keys(FRED_SERIES).sort(), timestamp: stamp() }; let n, start; try {
            [n, start] = parameters(a, 52);
        }
        catch (e) {
            return { error: (e as Error).message, timestamp: stamp() };
        } const { rows, error } = await fred(sid); if (!rows)
            return { error, series_id: sid, source: FRED_SOURCE, data_gaps: [error], timestamp: stamp() }; const s = buildFred(sid, rows, n, start, tr.now()), gaps = [_FRED_GAP], stale = staleGap(sid, s); if (stale)
            gaps.push(stale); if (s.blank_observations)
            gaps.push(`${s.blank_observations} blank ${sid} dates in the source (no value published) are omitted, not read as zero`); return { ...s, source: FRED_SOURCE, data_gaps: gaps, timestamp: stamp() }; },
        intel_net_liquidity: async (a) => { let n, start; try {
            [n, start] = parameters(a, 52);
        }
        catch (e) {
            return { error: (e as Error).message, timestamp: stamp() };
        } const ids = ['WALCL', 'WDTGAL', 'RRPONTSYD'], results = await Promise.all(ids.map(fred)), base = { source: FRED_SOURCE, formula: NET_LIQUIDITY_FORMULA, alignment: NET_LIQUIDITY_ALIGNMENT, method: structuredClone(NET_LIQUIDITY_METHOD), units: 'USD billions', measure: 'amount_outstanding', frequency: 'weekly, as of Wednesday' }, failed = ids.filter((_, i) => !results[i].rows); if (failed.length)
            return { ...base, error: `net liquidity not computed: missing component(s) ${failed.sort().join(', ')}; a missing term is never treated as zero`, components_failed: failed, data_gaps: results.filter(r => !r.rows).map(r => r.error), timestamp: stamp() }; const { points, skipped } = computeNetLiquidity(results[0].rows!, results[1].rows!, results[2].rows!); if (!points.length)
            return { ...base, error: 'net liquidity not computed: no week had all three components aligned', skipped_weeks: skipped.length, data_gaps: [`${skipped.length} WALCL weeks lacked an aligned TGA or RRP value`], timestamp: stamp() }; const latest = points.at(-1)!, previous = points.at(-2) ?? null; let window = points.filter(p => !start || p.observed_at >= start).reverse(); if (n)
            window = window.slice(0, n); const components: MarketObject = {}, gaps = [_FRED_GAP, TGA_CHOICE_NOTE]; ids.forEach((id, i) => { const s = buildFred(id, results[i].rows!, 1, null, tr.now()); components[id] = Object.fromEntries(['label', 'units', 'frequency', 'measure', 'release', 'latest', 'freshness'].map(k => [k, s[k]])); const stale = staleGap(id, s); if (stale)
            gaps.push(stale); }); if (skipped.length)
            gaps.push(`${skipped.length} of ${skipped.length + points.length} WALCL weeks skipped (no aligned TGA or RRP value), first ${skipped[0]}, last ${skipped.at(-1)}`); return { ...base, latest, previous, change: change(latest, previous), components, first_observed_at: points[0].observed_at, skipped_weeks: skipped.length, order: 'newest_first', count: window.length, points: window, published_at: null, data_gaps: gaps, timestamp: stamp() }; },
        intel_ecb_series: async (a) => { const ds = String(a.dataset ?? 'BSI').trim().toUpperCase(), key = String(a.key ?? 'M.U2.Y.V.M30.X.1.U2.2300.Z01.E').trim(); const err = (error: string) => ({ error, timestamp: stamp() }); if (!ECB_DATASETS[ds])
            return { ...err(`dataset must be one of ['BSI', 'ILM'], got ${repr(a.dataset)}`), datasets: ECB_DATASETS }; if (key.length > 200)
            return err(`key must be at most 200 characters, got ${key.length}`); if (!/^[A-Za-z0-9.+_]{1,200}$/.test(key))
            return err("key must be an SDMX series key: letters, digits, '.', '+' and '_' only"); const dims = key.split('.'); if (dims.length !== _ECB_KEY_DIMENSIONS[ds] || dims.some(d => d.split('+').some(c => !c)) || dims.reduce((n, d) => n * d.split('+').length, 1) > 50)
            return err(`key must specify every SDMX dimension (${_ECB_KEY_DIMENSIONS[ds]} for ${ds}) without wildcards and at most 50 series combinations`); let n, start; try {
            [n, start] = parameters(a, 24);
        }
        catch (e) {
            return err((e as Error).message);
        } const today = stamp().slice(0, 10); if (start && start > today)
            return err(`start must be on or before today (${today} UTC), got ${repr(a.start)}`); const { series, error } = await ecb(ds, key, n ? n + 1 : 0, start); if (!series)
            return { error, dataset: ds, key, source: ECB_SOURCE, data_gaps: [error], timestamp: stamp() }; const gaps = [_ECB_GAP]; if (series.length > 50)
            gaps.push(`${series.length} series matched; the first 50 by key are returned`); const finished = series.slice(0, 50).map(s => finishEcb(s, n, tr.now())); for (const s of finished) {
            if (s.measure === 'unknown')
                gaps.push(`${s.key}: measure type not recognized (not typed as stock or flow)`);
            if (s.latest) {
                const stale = staleGap(s.key, s);
                if (stale)
                    gaps.push(stale);
            }
        } return { dataset: ds, dataset_description: ECB_DATASETS[ds], key, source: ECB_SOURCE, series_count: finished.length, series: finished, data_gaps: gaps, timestamp: stamp() }; },
    };
    handlers.intel_money_supply = async (a) => { const reg = String(a.region ?? 'all').trim().toLowerCase(); if (!['all', 'us', 'euro_area'].includes(reg))
        return { error: `region must be all, us or euro_area, got ${repr(a.region)}`, timestamp: stamp() }; let n; try {
        [n] = parameters(a, 13);
    }
    catch (e) {
        return { error: (e as Error).message, timestamp: stamp() };
    } const us = reg !== 'euro_area', ea = reg !== 'us', gaps: any[] = [], out: MarketObject = { region: reg, note: NESTING_NOTE }; const [f, e] = await Promise.all([us ? fred('M2SL') : null, ea ? ecb('BSI', _ECB_MONEY_KEY, n ? n + 1 : 0, null) : null]); if (us) {
        out.us = { M3: { available: false, note: US_M3_NOTE } };
        if (!f?.rows) {
            out.us.M2 = { error: f?.error };
            gaps.push(f?.error);
        }
        else {
            const m = buildFred('M2SL', f.rows, n, null, tr.now());
            out.us.M2 = { ...m, source: FRED_SOURCE };
            gaps.push(_FRED_GAP);
            const stale = staleGap('M2SL', m);
            if (stale)
                gaps.push(stale);
        }
    } if (ea) {
        if (!e?.series) {
            out.euro_area = { error: e?.error };
            gaps.push(e?.error);
        }
        else {
            const aggregates: MarketObject = {};
            for (const s of e.series) {
                const name = _ECB_AGGREGATE_CODES[s.dimensions.BS_ITEM], role = ({ amount_outstanding: 'stock', flow: 'flow', growth_rate: 'annual_growth_rate' } as MarketObject)[s.measure];
                if (name && role)
                    (aggregates[name] ??= {})[role] = finishEcb(s, n, tr.now());
            }
            out.euro_area = { source: ECB_SOURCE, key: `BSI.${_ECB_MONEY_KEY}`, aggregates: Object.fromEntries(Object.keys(aggregates).sort().map(k => [k, aggregates[k]])), note: 'stock = outstanding amount at end of month; flow = transactions during the month (excludes reclassifications and revaluations, so stock changes differ from flows); annual_growth_rate = percent' };
            gaps.push(_ECB_GAP);
            for (const [name, roles] of Object.entries(aggregates))
                for (const [role, s] of Object.entries(roles as MarketObject)) {
                    if (s.latest) {
                        const stale = staleGap(`euro area ${name} ${role}`, s);
                        if (stale)
                            gaps.push(stale);
                    }
                }
            for (const name of Object.values(_ECB_AGGREGATE_CODES) as string[])
                for (const role of ['stock', 'flow', 'annual_growth_rate'])
                    if (!aggregates[name]?.[role]?.latest)
                        gaps.push(`euro area ${name} ${role}: missing observations from the ECB response`);
        }
    } if ((!us || out.us.M2.error) && (!ea || out.euro_area.error))
        out.error = 'money supply unavailable: ' + gaps.join('; '); return { ...out, data_gaps: gaps, timestamp: stamp() }; };
    handlers.intel_liquidity_board = async (a) => {
        const sort = String(a.sort ?? 'biggest_move').trim().toLowerCase();
        if (!_BOARD_RANKING_RULES[sort])
            return { error: `sort must be biggest_move or newest, got ${repr(sort)}`, timestamp: stamp() };
        const ids = _BOARD_FRED.map((x: any) => x[1]) as string[], results = await Promise.all(ids.map(fred)), [bsi, ilm] = await Promise.all([ecb('BSI', _ECB_MONEY_KEY, 2, null), ecb('ILM', _ECB_EUROSYSTEM_KEY, 2, null)]), rows: MarketObject[] = [], unavailable: MarketObject[] = [], gaps: any[] = [];
        const row = (indicator: string, label: string, dataset: string, source: string, measure: string, frequency: string, units: string | null, latest: any, previous: any, end: string | null, freshness: any) => { const c = change(latest, previous); return { indicator, label, dataset, source, measure, frequency, units, latest_value: latest?.value ?? null, status: latest?.status ?? null, observed_at: latest?.observed_at ?? null, period_end: end, previous_value: previous?.value ?? null, previous_observed_at: previous?.observed_at ?? null, change: c?.absolute ?? null, change_pct: c?.pct ?? null, change_basis: 'vs previous observation', freshness }; };
        ids.forEach((id, i) => { const indicator = _BOARD_FRED[i][0], r = results[i]; if (!r.rows) {
            unavailable.push({ indicator, dataset: `FRED ${id}`, error: r.error });
            gaps.push(r.error);
            return;
        } const s = buildFred(id, r.rows, 1, null, tr.now()); rows.push(row(indicator, s.label, s.dataset, FRED_SOURCE, s.measure, s.frequency, s.units, s.latest, s.previous, s.frequency === 'monthly' ? endMonth(s.latest.observed_at) : s.latest.observed_at, s.freshness)); });
        if (results.slice(0, 3).every(r => r.rows)) {
            const p = computeNetLiquidity(results[0].rows!, results[1].rows!, results[2].rows!).points;
            if (p.length) {
                const l = p.at(-1)!, prev = p.at(-2);
                rows.push(row('net_liquidity', 'US net liquidity (WALCL - WDTGAL - RRPONTSYD)', 'derived from FRED WALCL, WDTGAL, RRPONTSYD', FRED_SOURCE, 'amount_outstanding', 'weekly, as of Wednesday', 'USD billions', { observed_at: l.observed_at, value: l.value }, prev ? { observed_at: prev.observed_at, value: prev.value } : null, l.observed_at, fresh(l.observed_at, 10, tr.now())));
            }
            else {
                unavailable.push({ indicator: 'net_liquidity', error: 'no aligned week' });
                gaps.push('net liquidity: no week had all three components aligned');
            }
        }
        else {
            unavailable.push({ indicator: 'net_liquidity', error: 'a component failed; never computed with a zero term' });
            gaps.push('net liquidity not computed: a component series failed');
        }
        for (const [response, ds] of [[bsi, 'BSI'], [ilm, 'ILM']] as const) {
            for (const s of response.series ?? []) {
                let indicator, label;
                if (ds === 'BSI') {
                    const agg = _ECB_AGGREGATE_CODES[s.dimensions.BS_ITEM];
                    if (!agg || s.measure !== 'amount_outstanding')
                        continue;
                    indicator = `euro_area_${agg.toLowerCase()}`;
                    label = `Euro area ${agg} (stock)`;
                }
                else {
                    indicator = 'eurosystem_total_assets';
                    label = s.title || 'Eurosystem total assets';
                }
                const f = finishEcb(s, 1, tr.now());
                if (f.latest)
                    rows.push(row(indicator, label, s.key, ECB_SOURCE, s.measure, ({ M: 'monthly', W: 'weekly' } as MarketObject)[s.frequency] ?? s.frequency, s.units, f.latest, f.previous, f.latest.period_end, f.freshness));
            }
            for (const indicator of ds === 'BSI' ? ['euro_area_m1', 'euro_area_m2', 'euro_area_m3'] : ['eurosystem_total_assets'])
                if (!rows.some(r => r.indicator === indicator)) {
                    const reason = response.error || 'missing stock observations from the ECB response';
                    unavailable.push({ indicator, dataset: `ECB ${ds}`, error: reason });
                    gaps.push(`${indicator}: ${reason}`);
                }
        }
        for (const r of rows) {
            const s = staleGap(r.indicator, { latest: { observed_at: r.observed_at }, freshness: r.freshness });
            if (s)
                gaps.push(s);
        }
        if (sort === 'newest')
            rows.sort((a, b) => (b.period_end ?? '').localeCompare(a.period_end ?? '') || b.indicator.localeCompare(a.indicator));
        else {
            const move = (r: any) => Math.abs(r.change || 0) / (r.units?.endsWith(' millions') ? 1000 : 1);
            rows.sort((a, b) => Number(a.change === null) - Number(b.change === null) || move(b) - move(a) || a.indicator.localeCompare(b.indicator));
        }
        gaps.push("Changes are vs each indicator's previous observation, so horizons differ (daily RRP, weekly Fed and Eurosystem data, monthly money supply).", "published_at is null for every row: neither FRED's keyless CSV nor the ECB payload carries release dates. FRED units come from the server's series catalog; ECB units come from the response.", 'Not covered (see blocked): ICI money market fund assets and ETF net issuance, FINRA margin statistics and BLS series; no proxy is substituted for them.');
        const out: MarketObject = { sort, ranking_rule: _BOARD_RANKING_RULES[sort], count: rows.length, indicators: rows, unavailable, blocked: structuredClone(BLOCKED_SOURCES), net_liquidity_formula: NET_LIQUIDITY_FORMULA, note: NESTING_NOTE, sources: [FRED_SOURCE, ECB_SOURCE], data_gaps: gaps, timestamp: stamp() };
        if (!rows.length)
            out.error = 'liquidity board unavailable: every source failed';
        return out;
    };
    return handlers;
}
const NET_LIQUIDITY_METHOD: any = { "formula": "net_liquidity = WALCL - WDTGAL - RRPONTSYD, in USD billions: WALCL and WDTGAL are USD millions divided by 1,000; RRPONTSYD is already USD billions", "components": { "WALCL": { "term": "Federal Reserve total assets", "observed": "Wednesday level", "units": "USD millions", "conversion": "divided by 1,000 to USD billions" }, "WDTGAL": { "term": "Treasury General Account", "observed": "Wednesday level", "units": "USD millions", "conversion": "divided by 1,000 to USD billions" }, "RRPONTSYD": { "term": "Fed overnight reverse repo", "observed": "daily, business days", "units": "USD billions", "conversion": "none: already USD billions", "alignment": "the value for the WALCL Wednesday; when blank on or after 2013-09-23, Tuesday only; no fallback before that date. Reported per point as reverse_repo_observed_at; never a later day" } }, "alignment": "One point per WALCL Wednesday. WDTGAL must be reported for that same Wednesday. RRPONTSYD is taken from that Wednesday, or when that day is blank on or after 2013-09-23, from Tuesday only; before that date a blank Wednesday has no fallback. Each point names the RRP date used. Weeks without an aligned TGA or RRP value are skipped and counted, never filled with zero.", "tga_choice": "The Treasury General Account term is WDTGAL (Wednesday level), not WTREGEN (week average), so all three terms describe the same Wednesday. WTREGEN is not a drop-in replacement: subtracting a week average from Wednesday-level total assets mixes two different measures. WTREGEN is served on its own by intel_fed_liquidity_series." };
