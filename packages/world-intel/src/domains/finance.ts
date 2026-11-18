import type { SourceRuntime, SourceRule } from '../source-runtime.js';
// MIT native TypeScript port of selected finance contracts from marc-shade/world-intel-mcp.
// Pinned upstream fdebf9a8de6e00ed688053dd647cafedc179708b; see THIRD_PARTY_NOTICES.md.
import { createMarketHandlers, pyRound } from './markets.js';
export type FinanceObject = Record<string, any>;
export interface FinanceOptions { sourceRuntime?:SourceRuntime; fetch?: typeof globalThis.fetch; now?: () => number; timeoutMs?: number; maxBytes?: number; fredApiKey?: string; secUserAgent?: string }
export type FinanceHandler = (args: FinanceObject) => Promise<FinanceObject>;
const record = (v: any): FinanceObject => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const list = (v: any): any[] => Array.isArray(v) ? v : [];
const numeric = (v: any): number | null => v === null || v === undefined || v === '' || v === '.' || !Number.isFinite(Number(v)) ? null : Number(v);
const scalar = (v: any): number | null => numeric(typeof v === 'object' && v !== null ? v.raw : v);
const day = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10);
const currency = (v: any, fallback: string): string => { const s = v ?? fallback; if (typeof s !== 'string' || !/^[A-Z]{3}$/.test(s)) throw new Error('Invalid currency code'); return s; };
const count = (v: any, fallback: number, max = 100): number => { const n = v ?? fallback; if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Count must be an integer in 1..${max}`); return n; };
const ticker = (v: any): string => { if (typeof v !== 'string' || !/^[A-Za-z0-9.^=_-]{1,30}$/.test(v)) throw new Error('Invalid ticker'); return v; };
const PATHS: Record<string, RegExp> = {
  'api.frankfurter.dev': /^\/v1\/(latest|\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2})$/,
  'query1.finance.yahoo.com': /^\/(v8\/finance\/chart|v10\/finance\/quoteSummary)\/[A-Za-z0-9%_^=.+-]{1,100}$/,
  'api.fiscaldata.treasury.gov': /^\/services\/api\/fiscal_service\/v2\/accounting\/od\/avg_interest_rates$/,
  'api.stlouisfed.org': /^\/fred\/series\/observations$/,
  'efts.sec.gov': /^\/LATEST\/search-index$/,
  'www.sec.gov': /^\/files\/company_tickers.json$/,
  'data.sec.gov': /^\/submissions\/CIK\d{10}.json$/,
  'api.gdeltproject.org': /^\/api\/v2\/doc\/doc$/,
  'api.github.com': /^\/search\/repositories$/,
};
const FINANCE_SOURCES:Record<string,string>={'api.frankfurter.dev':'ecb-forex','query1.finance.yahoo.com':'yahoo-finance','api.fiscaldata.treasury.gov':'treasury','api.stlouisfed.org':'fred','efts.sec.gov':'sec-edgar','www.sec.gov':'sec-edgar','data.sec.gov':'sec-edgar','api.gdeltproject.org':'gdelt','api.github.com':'github'};
export function financeSourceRules():Record<string,SourceRule>{
 const rules:Record<string,SourceRule>={};
 for(const [host,source] of Object.entries(FINANCE_SOURCES)){
  const prior=rules[source];rules[source]={origins:[...prior?.origins??[],'https://'+host],path:prior?.path?new RegExp('(?:'+prior.path.source+')|(?:'+PATHS[host].source+')'):PATHS[host]};
 }
 return rules;
}
/** Rechecked at the transport boundary, including nondefault ports and fragments. */
export function validateFinanceUrl(url: URL): void {
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !PATHS[url.hostname]?.test(url.pathname) || url.href.length > 4096) throw new Error('Finance URL outside fixed allowlist');
}
/** Fixed endpoints, bounded cache/bytes/deadline, no redirects or inherited credentials. */
export class FinanceTransport {
  readonly now: () => number; private readonly fetcher: typeof globalThis.fetch;
  private readonly cache = new Map<string, { data: any; at: number }>();
  private last = 0; private queue: Promise<void> = Promise.resolve();
  constructor(private options: FinanceOptions) { this.now = options.now ?? Date.now; this.fetcher = options.fetch ?? globalThis.fetch; }
  stamp(): string { return new Date(this.now()).toISOString(); }
  async json(base: string, params: Record<string, any> = {}, ttl = 1800): Promise<any> {
    const url = new URL(base); for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    validateFinanceUrl(url);
    const sec = /(^|\.)sec.gov$/.test(url.hostname);
    if (sec && (!this.options.secUserAgent || /[\r\n]/.test(this.options.secUserAgent) || !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(this.options.secUserAgent))) throw new Error('SEC requires an explicitly configured contact User-Agent; secUserAgent is not configured');
    if(this.options.sourceRuntime){
      const data=await this.options.sourceRuntime.getJson(url,{source:FINANCE_SOURCES[url.hostname],cacheTtl:ttl,
        timeoutSeconds:(this.options.timeoutMs??15000)/1000,maxBytes:this.options.maxBytes??4000000,
        validateUrl:validateFinanceUrl,followRedirects:false,
        headers:{Accept:'application/json','User-Agent':sec?this.options.secUserAgent!:'metaharness-world-intel/0.2.0'}});
      if(data===null)throw new Error('Finance provider unavailable');
      return data;
    }
    const key = url.href; const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < ttl * 1000) return structuredClone(cached.data);
    if (!this.options.fetch) {
      let release!: () => void; const gate = new Promise<void>(r => { release = r; }); const previous = this.queue; this.queue = previous.then(() => gate); await previous;
      const delay = Math.max(0, this.last + (sec ? 150 : 500) - Date.now()); if (delay) await new Promise(r => setTimeout(r, delay)); this.last = Date.now(); release();
    }
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Finance source timeout')); }, this.options.timeoutMs ?? 15_000); });
      const read = async () => {
        const response = await this.fetcher(url, { redirect: 'error', credentials: 'omit', signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': sec ? this.options.secUserAgent! : 'metaharness-world-intel/0.1.0' } });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Finance provider HTTP ${response.status}`); }
        const reader = response.body?.getReader(); if (!reader) throw new Error('Empty provider body');
        const abort = () => { void reader.cancel().catch(() => undefined); }; controller.signal.addEventListener('abort', abort, { once: true });
        const chunks: Uint8Array[] = []; let size = 0;
        try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > (this.options.maxBytes ?? 4_000_000)) { await reader.cancel(); throw new Error('Finance provider response too large'); } chunks.push(value); } if (controller.signal.aborted) throw new Error('Finance source timeout'); }
        finally { controller.signal.removeEventListener('abort', abort); reader.releaseLock(); }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      };
      const data = await Promise.race([read(), timeout]); if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!); this.cache.set(key, { data, at: this.now() }); return structuredClone(data);
    } finally { if (timer) clearTimeout(timer); }
  }
}
const MAJOR = ['EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'CNY'];
const WEIGHTS: Record<string, number> = { EUR: .576, JPY: .136, GBP: .119, CAD: .091, CHF: .036 };
const BONDS: Record<string, string> = { AGG: 'US Aggregate Bond', TLT: '20+ Year Treasury', HYG: 'High Yield Corporate', LQD: 'Investment Grade Corporate', TIP: 'TIPS' };
const YIELDS: Record<string, string> = { '^IRX': '3M', '^FVX': '5Y', '^TNX': '10Y', '^TYX': '30Y' };
const FRED: Record<string, string> = { DGS1MO: '1M', DGS3MO: '3M', DGS6MO: '6M', DGS1: '1Y', DGS2: '2Y', DGS5: '5Y', DGS10: '10Y', DGS20: '20Y', DGS30: '30Y' };
const MEGACAPS = ['AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','BRK-B','JPM','V','UNH','MA','HD','PG','JNJ','LLY','ABBV','XOM','CVX','BAC'];
function earningsDate(value: any): string | null { if (!value) return null; if (value.fmt) return value.fmt; const n = numeric(value.raw); if (n === null || !Number.isFinite(new Date(n * 1000).getTime())) return null; return day(n * 1000); }
function quarter(value: string | null): string | null { if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null; const date = new Date(value); if (!Number.isFinite(date.getTime())) return null; return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`; }
function errorResult(base: FinanceObject, error: unknown): FinanceObject { return { ...base, error: error instanceof Error ? error.message : 'Finance provider unavailable', degraded: true }; }

export function createFinanceHandlers(options: FinanceOptions = {}): Record<string, FinanceHandler> {
  const tr = new FinanceTransport(options), stamp = () => tr.stamp();
  const quote = async (symbol: string, ttl = 1800): Promise<FinanceObject> => {
    const d = await tr.json(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker(symbol))}`, { range: '1d', interval: '5m' }, ttl);
    const m = d?.chart?.result?.[0]?.meta; if (!m) throw new Error('Yahoo chart metadata unavailable');
    const price = m.regularMarketPrice ?? null; let change = m.regularMarketChangePercent ?? null; const prev = m.previousClose || m.chartPreviousClose;
    if (change === null && price !== null && prev > 0) change = pyRound((price - prev) / prev * 100, 4);
    return { symbol, price, change_pct: change, currency: m.currency ?? null };
  };
  const summary = async (symbol: string, modules: string) => {
    const data = await tr.json(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker(symbol))}`, { modules }, 3600);
    const result = data?.quoteSummary?.result?.[0]; if (!result) throw new Error('Yahoo summary unavailable'); return result;
  };
  const handlers: Record<string, FinanceHandler> = {};
  handlers.intel_forex_rates = async a => {
    const base = currency(a.base, 'USD'); const symbols = a.symbols;
    if (symbols !== undefined && (!Array.isArray(symbols) || symbols.length > 100 || symbols.some(v => typeof v !== 'string' || !/^[A-Z]{3}$/.test(v)))) throw new Error('symbols must be a bounded currency array');
    const out = { base, date: null, rates: {}, fetched_at: stamp(), source: 'ecb-forex' };
    try { const d = await tr.json('https://api.frankfurter.dev/v1/latest', { base, ...(symbols?.length ? { symbols: symbols.join(',') } : {}) }); if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Invalid forex response'); return { ...out, base: d.base ?? base, date: d.date ?? null, rates: d.rates ?? {} }; } catch (e) { return errorResult(out, e); }
  };
  handlers.intel_forex_timeseries = async a => {
    const base = currency(a.base, 'USD'), symbol = currency(a.symbol, 'EUR'), days = count(a.days, 30, 3650);
    const out: FinanceObject = { base, symbol, days, rates: [], trend: null, fetched_at: stamp(), source: 'ecb-forex' };
    try {
      const d = await tr.json(`https://api.frankfurter.dev/v1/${day(tr.now() - days * 86400000)}..${day(tr.now())}`, { base, symbols: symbol }, 3600);
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Invalid forex history');
      out.rates = Object.keys(record(d.rates)).sort().filter(date => d.rates[date]?.[symbol] !== undefined && d.rates[date]?.[symbol] !== null).map(date => ({ date, rate: d.rates[date][symbol] }));
      if (out.rates.length >= 2) { const start = out.rates[0].rate, end = out.rates.at(-1).rate; out.trend = { start, end, change_pct: start ? pyRound((end - start) / start * 100, 4) : 0 }; }
      return out;
    } catch (e) { return errorResult(out, e); }
  };
  handlers.intel_major_crosses = async () => {
    const d = await handlers.intel_forex_rates({ base: 'USD', symbols: MAJOR }); const r = d.rates, cross: FinanceObject = {};
    if (r.EUR && r.GBP) cross['EUR/GBP'] = pyRound(r.GBP / r.EUR, 6); if (r.EUR && r.JPY) cross['EUR/JPY'] = pyRound(r.JPY / r.EUR, 4); if (r.GBP && r.JPY) cross['GBP/JPY'] = pyRound(r.JPY / r.GBP, 4);
    let product = 1, weight = 0; for (const [sym, w] of Object.entries(WEIGHTS)) if (r[sym] > 0) { product *= (1 / r[sym]) ** w; weight += w; }
    const out = { major_pairs: MAJOR.filter(s => r[s] !== undefined && r[s] !== null).map(s => ({ pair: `USD/${s}`, rate: r[s] })), cross_rates: cross, dxy_proxy: weight > 0 ? pyRound((weight < .95 ? product ** (1 / weight) : product) * 100, 4) : null, date: d.date, fetched_at: stamp(), source: 'ecb-forex' };
    return d.error ? errorResult(out, new Error(d.error)) : out;
  };
  handlers.intel_yield_curve = async () => {
    let treasury: any = null; try { treasury = await tr.json('https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates', { sort: '-record_date', 'page[size]': 20 }, 3600); } catch { /* Supplementary source not used as a yield. */ }
    const yields: FinanceObject[] = [];
    if (options.fredApiKey) {
      for (const [series, maturity] of Object.entries(FRED)) { let rate = null, date = null; try { const d = await tr.json('https://api.stlouisfed.org/fred/series/observations', { series_id: series, api_key: options.fredApiKey, file_type: 'json', sort_order: 'desc', limit: 1 }, 3600); const obs = d?.observations?.[0]; rate = numeric(obs?.value); date = obs?.date ?? null; } catch { /* Missing yield is explicit below. */ } yields.push({ maturity, rate, date, series }); }
    } else for (const [symbol, maturity] of Object.entries(YIELDS)) { let rate = null; try { rate = (await quote(symbol, 3600)).price; } catch { /* Missing yield is explicit below. */ } yields.push({ maturity, rate, symbol }); }
    const rates = Object.fromEntries(yields.filter(y => y.rate !== null).map(y => [y.maturity, y.rate])); const two = rates['2Y'] ?? null, three = rates['3M'] ?? null, ten = rates['10Y'] ?? null;
    const spreads: FinanceObject = { spread_2s10s: two !== null && ten !== null ? pyRound(ten - two, 4) : null, spread_3m10y: three !== null && ten !== null ? pyRound(ten - three, 4) : null }; const basis = Object.keys(spreads).filter(k => spreads[k] !== null);
    const provider = options.fredApiKey ? 'fred' : 'yahoo-finance', missing = yields.filter(y => y.rate === null).map(y => y.maturity);
    const out: FinanceObject = { yields, ...spreads, inverted: basis.length ? basis.some(k => spreads[k] < 0) : null, inversion_basis: basis, yields_source: provider, treasury_records: list(treasury?.data).length, fetched_at: stamp(), source: 'treasury' };
    if (missing.length) { out.degraded = true; out.data_gaps = missing.map(m => `No ${m} yield from ${provider}`); if (out.inverted === null) out.data_gaps.push("inverted is null: no spread could be computed, so the curve's shape is unknown, not normal"); }
    if (missing.length === yields.length) out.error = `No Treasury yield could be read from ${provider}`; return out;
  };
  handlers.intel_bond_indices = async () => {
    const indices: FinanceObject[] = [], gaps: string[] = [];
    for (const [symbol, name] of Object.entries(BONDS)) { try { const q = await quote(symbol); indices.push({ symbol, name, price: q.price, change_pct: q.change_pct }); } catch { gaps.push(`No ${symbol} quote`); } }
    return { indices, fetched_at: stamp(), source: 'yahoo-finance', ...(gaps.length ? { degraded: true, data_gaps: gaps, ...(!indices.length ? { error: 'No bond quotes available' } : {}) } : {}) };
  };
  handlers.intel_earnings_calendar = async a => {
    const daysAhead = count(a.days_ahead, 7, 365); const upcoming: FinanceObject[] = [], gaps: string[] = [];
    for (const symbol of MEGACAPS) {
      try {
        const d = await summary(symbol, 'calendarEvents,earningsHistory'), e = record(d.calendarEvents?.earnings), date = earningsDate(e.earningsDate?.[0]); if (!date) continue;
        const dt = Date.parse(date + 'T00:00:00Z');
        upcoming.push({ symbol, company: symbol, earnings_date: date, days_until: Number.isFinite(dt) ? Math.floor((dt - tr.now()) / 86400000) : null, eps_estimate: scalar(e.earningsAverage), eps_previous: scalar(list(d.earningsHistory?.history).at(-1)?.epsActual) });
      } catch { gaps.push(`No earnings response for ${symbol}`); }
    }
    upcoming.sort((a,b) => String(a.earnings_date).localeCompare(String(b.earnings_date)));
    return { upcoming, this_week: upcoming.filter(e => Date.parse(e.earnings_date + 'T00:00:00Z') <= tr.now() + daysAhead * 86400000), fetched_at: stamp(), source: 'yahoo-finance', ...(gaps.length ? { degraded: true, data_gaps: gaps, ...(gaps.length === MEGACAPS.length ? { error: 'No earnings provider responses' } : {}) } : {}) };
  };
  handlers.intel_earnings_surprise = async a => {
    const symbol = ticker(a.symbol); const out: FinanceObject = { symbol, history: [], trend: { current_quarter_estimate: null, next_quarter_estimate: null }, fetched_at: stamp(), source: 'yahoo-finance' };
    try {
      const d = await summary(symbol, 'earningsHistory,earningsTrend');
      for (const row of list(d.earningsHistory?.history)) { const estimate = scalar(row.epsEstimate), actual = scalar(row.epsActual); let surprise = scalar(row.surprisePercent); if (surprise === null && estimate && actual !== null) surprise = pyRound((actual - estimate) / Math.abs(estimate) * 100, 2); const date = earningsDate(row.quarter); out.history.push({ quarter: quarter(date) ?? date, eps_estimate: estimate, eps_actual: actual, surprise_pct: surprise }); }
      for (const row of list(d.earningsTrend?.trend)) { if (row.period === '0q') out.trend.current_quarter_estimate = scalar(row.earningsEstimate?.avg); if (row.period === '+1q') out.trend.next_quarter_estimate = scalar(row.earningsEstimate?.avg); }
      return out;
    } catch (e) { return errorResult(out, e); }
  };
  const secSearch = async (a: FinanceObject, recent = false): Promise<FinanceObject> => {
    const limit = Math.min(count(a.limit, 25, 10000), 100); const query = a.query ?? null, formType = recent ? '8-K' : a.form_type ?? null;
    if (query !== null && (typeof query !== 'string' || query.length > 500)) throw new Error('Invalid SEC query');
    if (formType !== null && (typeof formType !== 'string' || !/^[A-Za-z0-9, /-]{1,100}$/.test(formType))) throw new Error('Invalid SEC form filter');
    const params: FinanceObject = { q: query || '*', from: 0, size: limit }; if (formType) params.forms = formType;
    if (a.date_range) { if (typeof a.date_range !== 'string' || !/^\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2}$/.test(a.date_range)) throw new Error('Invalid SEC date range'); const [start, end] = a.date_range.split(','); if (start > end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) throw new Error('Invalid SEC date range'); Object.assign(params, { dateRange: 'custom', startdt: start, enddt: end }); }
    else Object.assign(params, { dateRange: 'custom', startdt: day(tr.now() - (recent ? 7 : 30) * 86400000), enddt: day(tr.now()) });
    const out: FinanceObject = { ...(!recent ? { query, form_type: formType } : {}), filings: [], total: 0, fetched_at: stamp(), source: 'sec-edgar' };
    try {
      const d = await tr.json('https://efts.sec.gov/LATEST/search-index', params); if (!d?.hits || typeof d.hits !== 'object') throw new Error('Invalid SEC search response');
      out.total = typeof d.hits.total === 'object' ? d.hits.total?.value ?? 0 : d.hits.total ?? 0;
      for (const hit of list(d.hits.hits).slice(0, limit)) {
        const s = record(hit?._source); if (!Object.keys(s).length) continue;
        const url = hit._id ? `https://www.sec.gov/Archives/edgar/data/${String(hit._id).replace(/:/g,'/')}` : recent ? '' : `https://www.sec.gov/Archives/edgar/data/${s.entity_id ?? ''}/${s.file_num ?? ''}`.replace(/\/+$/, '');
        out.filings.push(recent ? { company: list(s.display_names)[0] ?? s.entity_name ?? null, ticker: list(s.tickers)[0] ?? null, filed_date: s.file_date ?? '', description: s.display_description ?? s.description ?? '', items: s.items ?? [], url } : { company: list(s.display_names)[0] ?? s.entity_name ?? null, form_type: s.form_type ?? '', filed_date: s.file_date ?? '', description: s.display_description ?? s.description ?? '', url });
      }
      return out;
    } catch (e) { return errorResult(out, e); }
  };
  handlers.intel_sec_filings = a => secSearch(a);
  handlers.intel_recent_8k = a => secSearch(a, true);
  handlers.intel_company_filings = async a => {
    const symbol = ticker(a.ticker).toUpperCase(), limit = count(a.limit, 10, 1000);
    const forms = a.form_types?.length ? a.form_types : ['10-K','10-Q','8-K']; if (!Array.isArray(forms) || forms.length > 100 || forms.some(v => typeof v !== 'string' || !/^[A-Za-z0-9 /-]{1,30}$/.test(v))) throw new Error('Invalid SEC form types');
    const out: FinanceObject = { ticker: symbol, company_name: '', cik: '', filings: [], fetched_at: stamp(), source: 'sec-edgar' };
    try {
      const tickers = await tr.json('https://www.sec.gov/files/company_tickers.json', {}, 86400);
      const match = Object.values(record(tickers)).map(record).find(v => String(v.ticker ?? '').toUpperCase() === symbol);
      if (!match || !/^\d{1,10}$/.test(String(match.cik_str))) return { ...out, error: `Ticker '${a.ticker}' not found in SEC company tickers` };
      out.cik = String(match.cik_str).padStart(10, '0'); out.company_name = match.title ?? '';
      const d = await tr.json(`https://data.sec.gov/submissions/CIK${out.cik}.json`, {}, 3600); if (!d || typeof d !== 'object') throw new Error('Invalid SEC submissions');
      out.company_name = d.name || out.company_name; const recent = record(d.filings?.recent);
      for (const [i, form] of list(recent.form).entries()) {
        if (out.filings.length >= limit) break; if (!forms.includes(form)) continue;
        const accession = String(recent.accessionNumber?.[i] ?? '').replace(/-/g,''), primary = recent.primaryDocument?.[i] ?? '';
        out.filings.push({ form, filing_date: recent.filingDate?.[i] ?? '', description: recent.primaryDocDescription?.[i] ?? '', url: accession && primary ? `https://www.sec.gov/Archives/edgar/data/${out.cik.replace(/^0+/, '')}/${accession}/${primary}` : '' });
      }
      return out;
    } catch (e) { return errorResult(out, e); }
  };
  handlers.intel_macro_composite = async () => {
    const market = createMarketHandlers(options);
    const safe = async (name: string): Promise<FinanceObject> => { try { return await market[name]({}); } catch { return {}; } };
    const [macro, sectors, btc] = await Promise.all([safe('intel_macro_signals'), safe('intel_sector_heatmap'), safe('intel_btc_technicals')]);
    return computeMacroComposite(macro, sectors, btc, stamp());
  };
  handlers.intel_company_profile = async a => {
    if (typeof a.query !== 'string' || !a.query.trim() || a.query.length > 200) throw new Error('Company query must be 1..200 characters');
    const query = a.query, symbol = query.toUpperCase().trim(), gaps: string[] = [];
    const safe = async (label: string, callback: () => Promise<any>) => { try { return await callback(); } catch { gaps.push(`${label} unavailable`); return null; } };
    const [stockData, info, newsData, sec, githubData] = await Promise.all([
      safe('stock_quote', async () => { const d = await tr.json(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker(symbol))}`, { range:'5d', interval:'1d' }, 300); const m = d?.chart?.result?.[0]?.meta; if (!m) throw new Error('No metadata'); const price = m.regularMarketPrice ?? null, prev = m.previousClose || m.chartPreviousClose; return { price, change_pct: price !== null && prev > 0 ? pyRound((price-prev)/prev*100,4) : null, volume:m.regularMarketVolume ?? null, market_cap:m.marketCap ?? null }; }),
      safe('company_info', async () => { const d = await summary(symbol, 'assetProfile,financialData,defaultKeyStatistics'), p=record(d.assetProfile),f=record(d.financialData),s=record(d.defaultKeyStatistics); return { sector:p.sector??null, industry:p.industry??null, employees:p.fullTimeEmployees??null, website:p.website??null, description:p.longBusinessSummary??null, revenue:scalar(f.totalRevenue),profit_margin:scalar(f.profitMargins),pe_ratio:scalar(s.forwardPE||s.trailingPE),market_cap:scalar(s.marketCap) }; }),
      safe('company_news', () => tr.json('https://api.gdeltproject.org/api/v2/doc/doc', { query:`"${query}"`,mode:'artlist',maxrecords:'5',format:'json' })),
      safe('sec_filings', async () => { const d=await handlers.intel_company_filings({ticker:symbol,limit:5}); if(d.error) throw new Error('SEC unavailable'); return d.filings; }),
      safe('github_repos', () => tr.json('https://api.github.com/search/repositories',{q:query,sort:'stars',per_page:'3'})),
    ]);
    const stock=stockData??{}, financials:FinanceObject=info ? {revenue:info.revenue,profit_margin:info.profit_margin,pe_ratio:info.pe_ratio,employees:info.employees} : {};
    if(!stock.market_cap&&info?.market_cap)stock.market_cap=info.market_cap;
    const news=list(newsData?.articles).slice(0,5).map(art=>({title:art.title??null,url:art.url??null,date:art.seendate??null}));
    const github=list(githubData?.items).slice(0,3).filter(repo=>String(repo.owner?.login??'').toLowerCase().includes(query.toLowerCase())||String(repo.full_name??'').toLowerCase().includes(query.toLowerCase())).map(repo=>({name:repo.full_name??null,stars:repo.stargazers_count??null,url:repo.html_url??null}));
    return {query,ticker:symbol,company_name:info?.description?String(info.description).slice(0,80):symbol,sector:info?.sector??null,industry:info?.industry??null,stock,financials,recent_news:news,...(sec!==null?{sec_filings:sec}:{}),...(github.length?{github}:{}),fetched_at:stamp(),source:'composite',...(gaps.length?{degraded:true,data_gaps:gaps,...(gaps.length===5?{error:'No company sources available'}:{})}:{})};
  };
  return handlers;
}

/** Formula port; retains upstream score bands but marks missing inputs as degraded. Not investment advice. */
export function computeMacroComposite(macro: FinanceObject, heatmap: FinanceObject, btc: FinanceObject, fetchedAt: string): FinanceObject {
  const s=record(macro.signals), fg=record(s.fear_greed), fgValue=numeric(fg.value), vix=numeric(s.vix?.price), dxy=numeric(s.dxy?.price), y=numeric(s.treasury_10y?.price);
  const v:[string,number]=vix===null?['unavailable',50]:vix<15?['complacent',90]:vix<20?['calm',70]:vix<30?['cautious',40]:['fear',10];
  const d:[string,number]=dxy===null?['unavailable',50]:dxy<100?['weak dollar',75]:dxy<=105?['neutral',50]:['strong dollar',25];
  const yieldSignal:[string,number]=y===null?['unavailable',50]:y<3?['accommodative',80]:y<4?['moderate',60]:y<5?['elevated',35]:['restrictive',15];
  let btcLabel=btc.cross_signal==='golden_cross'?'bullish':btc.cross_signal==='death_cross'?'bearish':'neutral', btcScore=btc.cross_signal==='golden_cross'?75:btc.cross_signal==='death_cross'?25:50;
  const mayer=numeric(btc.mayer_multiple);if(mayer!==null){if(mayer>2.4){btcScore=Math.max(btcScore-20,0);btcLabel='overheated';}else if(mayer<.8){btcScore=Math.min(btcScore+20,100);btcLabel='undervalued';}}
  const sectors=list(heatmap.sectors), positive=sectors.filter(x=>(x.change_pct||0)>0).length,negative=sectors.filter(x=>(x.change_pct||0)<0).length,breadth=positive+negative?positive/(positive+negative)*100:50;
  const composite=Math.min(100,Math.max(0,(fgValue??50)*.25+v[1]*.2+breadth*.2+d[1]*.15+btcScore*.1+yieldSignal[1]*.1));
  const verdict=composite>=80?'RISK_ON':composite>=60?'CONSTRUCTIVE':composite>=40?'NEUTRAL':composite>=20?'CAUTIOUS':'STRONG_CAUTION';
  const sorted=[...sectors].sort((a,b)=>(b.change_pct||0)-(a.change_pct||0)),take=(rows:any[])=>rows.map(x=>({name:x.name??null,change_pct:x.change_pct??null}));
  const gaps=[...(fgValue===null?['fear_greed']:[]),...(vix===null?['vix']:[]),...(dxy===null?['dxy']:[]),...(y===null?['yield_10y']:[]),...(!sectors.length?['sector_breadth']:[]),...(!btc.cross_signal||btc.error?['btc']:[])];
  return {verdict,score:pyRound(composite,1),signals:{fear_greed:{value:fgValue,label:fg.classification??'unavailable',weight:.25},vix:{value:vix,label:v[0],weight:.2},sector_breadth:{positive,negative,weight:.2},dxy:{value:dxy,label:d[0],weight:.15},btc:{signal:btcLabel,mayer,weight:.1},yield_10y:{value:y,label:yieldSignal[0],weight:.1}},top_sectors:take(sorted.slice(0,3)),bottom_sectors:take(sorted.slice(-3)),fetched_at:fetchedAt,source:'composite',...(gaps.length?{degraded:true,data_gaps:gaps.map(x=>`${x} unavailable; neutral placeholder is not an observation`),...(gaps.length===6?{error:'No macro inputs available'}:{})}:{})};
}

