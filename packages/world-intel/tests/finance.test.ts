import { describe, it, expect, vi } from 'vitest';
import { createFinanceHandlers, computeMacroComposite, validateFinanceUrl } from '../src/domains/finance.js';
const NOW = Date.parse('2026-01-01T12:00:00Z');
const json = (data: unknown) => new Response(JSON.stringify(data));
const setup = (resolve: (url: URL) => unknown, extra = {}) => {
  const fetch = vi.fn(async (url: any) => json(resolve(new URL(url))));
  return { fetch, handlers: createFinanceHandlers({ fetch, now: () => NOW, ...extra }) };
};
describe('native finance ports', () => {
  it('registers all 12 native finance handlers', () => {
    expect(Object.keys(createFinanceHandlers())).toHaveLength(12);
    expect(typeof createFinanceHandlers().intel_company_profile).toBe('function');
  });
  it('FX rates preserve provider date, base and symbol filtering', async () => {
    const c = setup(url => { expect(url.searchParams.get('symbols')).toBe('EUR,GBP'); return { base: 'USD', date: '2025-12-31', rates: { EUR: .85, GBP: .75 } }; });
    const result = await c.handlers.intel_forex_rates({ symbols: ['EUR','GBP'] });
    expect(result).toEqual({ base:'USD',date:'2025-12-31',rates:{EUR:.85,GBP:.75},fetched_at:'2026-01-01T12:00:00.000Z',source:'ecb-forex' });
    expect(c.fetch.mock.calls[0][0].origin).toBe('https://api.frankfurter.dev');
  });
  it('FX history sorts dates and computes upstream trend shape', async () => {
    const c = setup(() => ({ rates:{'2025-12-31':{EUR:1.2},'2025-12-01':{EUR:1}} }));
    const r = await c.handlers.intel_forex_timeseries({ days:30 });
    expect(r.rates).toEqual([{date:'2025-12-01',rate:1},{date:'2025-12-31',rate:1.2}]);
    expect(r.trend).toEqual({start:1,end:1.2,change_pct:20});
  });
  it('major crosses computes pair rates and inverse weighted proxy', async () => {
    const c = setup(() => ({ date:'2025-12-31',rates:{EUR:.8,GBP:.6,JPY:150,CHF:.9,CAD:1.4} }));
    const r = await c.handlers.intel_major_crosses({});
    expect(r.major_pairs).toContainEqual({pair:'USD/JPY',rate:150});
    expect(r.cross_rates).toEqual({'EUR/GBP':.75,'EUR/JPY':187.5,'GBP/JPY':250});
    expect(r.dxy_proxy).toBeGreaterThan(0);
  });
  it('Yahoo yield curve preserves unknown 2Y spread and inversion basis', async () => {
    const c = setup(url => url.hostname.includes('treasury') ? {data:[{}]} : {chart:{result:[{meta:{regularMarketPrice:decodeURIComponent(url.pathname).endsWith('^IRX') ? 5 : 4}}]}});
    const r = await c.handlers.intel_yield_curve({});
    expect(r.yields).toHaveLength(4); expect(r.spread_2s10s).toBeNull(); expect(r.spread_3m10y).toBe(-1); expect(r.inverted).toBe(true); expect(r.inversion_basis).toEqual(['spread_3m10y']); expect(r.treasury_records).toBe(1);
  });
  it('FRED yield branch returns nine maturities with series/date', async () => {
    const c = setup(url => url.hostname.includes('treasury') ? {data:[]} : {observations:[{date:'2025-12-31',value:url.searchParams.get('series_id')==='DGS2'?'5':'4'}]}, {fredApiKey:'fixture-only'});
    const r = await c.handlers.intel_yield_curve({}); expect(r.yields).toHaveLength(9); expect(r.spread_2s10s).toBe(-1); expect(r.yields_source).toBe('fred');
  });
  it('bond indices compute price changes from previousClose fallback', async () => {
    const c = setup(() => ({chart:{result:[{meta:{regularMarketPrice:102,previousClose:100,currency:'USD'}}]}}));
    const r = await c.handlers.intel_bond_indices({}); expect(r.indices).toHaveLength(5); expect(r.indices[0]).toEqual({symbol:'AGG',name:'US Aggregate Bond',price:102,change_pct:2});
  });
  it('earnings calendar matches upstream days-until and latest EPS semantics', async () => {
    const c = setup(() => ({quoteSummary:{result:[{calendarEvents:{earnings:{earningsDate:[{fmt:'2026-01-03'}],earningsAverage:{raw:2}}},earningsHistory:{history:[{epsActual:{raw:1}},{epsActual:{raw:1.5}}]}}]}}));
    const r = await c.handlers.intel_earnings_calendar({days_ahead:7}); expect(r.upcoming).toHaveLength(20); expect(r.this_week).toHaveLength(20); expect(r.upcoming[0]).toMatchObject({symbol:'AAPL',days_until:1,eps_estimate:2,eps_previous:1.5});
  });
  it('earnings surprise preserves quarter labels and estimates', async () => {
    const c = setup(() => ({quoteSummary:{result:[{earningsHistory:{history:[{quarter:{fmt:'2025-12-31'},epsEstimate:{raw:2},epsActual:{raw:2.2}}]},earningsTrend:{trend:[{period:'0q',earningsEstimate:{avg:{raw:3}}},{period:'+1q',earningsEstimate:{avg:{raw:4}}}]}}]}}));
    const r = await c.handlers.intel_earnings_surprise({symbol:'AAPL'}); expect(r.history[0]).toEqual({quarter:'Q4 2025',eps_estimate:2,eps_actual:2.2,surprise_pct:10}); expect(r.trend).toEqual({current_quarter_estimate:3,next_quarter_estimate:4});
  });
  it('SEC search and recent8k retain distinct shapes', async () => {
    const c = setup(() => ({hits:{total:{value:3},hits:[{_id:'123:report.htm',_source:{display_names:['Example'],tickers:['EX'],form_type:'8-K',file_date:'2025-12-31',description:'Report',items:['2.02']}}]}}), {secUserAgent:'Test fixture@example.test'});
    const s = await c.handlers.intel_sec_filings({query:'Example',form_type:'8-K',limit:1}); expect(s.total).toBe(3); expect(s.filings[0]).toMatchObject({company:'Example',form_type:'8-K',url:'https://www.sec.gov/Archives/edgar/data/123/report.htm'});
    const r = await c.handlers.intel_recent_8k({limit:1}); expect(r.query).toBeUndefined(); expect(r.filings[0]).toMatchObject({company:'Example',ticker:'EX',items:['2.02']});
  });
  it('company SEC lookup pads CIK, filters forms and composes document URL', async () => {
    const c = setup(url => url.hostname==='www.sec.gov' ? {'0':{ticker:'EX',cik_str:123,title:'Example'}} : {name:'Example Inc',filings:{recent:{form:['4','10-K'],filingDate:['2025-12-31','2025-12-30'],primaryDocument:['a','report.htm'],accessionNumber:['x','000-123'],primaryDocDescription:['ignored','Annual report']}}}, {secUserAgent:'Test fixture@example.test'});
    const r = await c.handlers.intel_company_filings({ticker:'ex'}); expect(r.cik).toBe('0000000123'); expect(r.company_name).toBe('Example Inc'); expect(r.filings).toEqual([{form:'10-K',filing_date:'2025-12-30',description:'Annual report',url:'https://www.sec.gov/Archives/edgar/data/123/000123/report.htm'}]);
  });
  it('SEC missing configured contact is explicit and performs no request', async () => {
    const c = setup(() => ({})); const r = await c.handlers.intel_recent_8k({}); expect(r.error).toContain('secUserAgent'); expect(r.degraded).toBe(true); expect(c.fetch).not.toHaveBeenCalled();
  });
  it('provider outage never reports normal yield curve or healthy empty finance', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('offline')); const h = createFinanceHandlers({fetch,now:()=>NOW,secUserAgent:'Test fixture@example.test'});
    for (const [name,args] of [['intel_forex_rates',{}],['intel_forex_timeseries',{}],['intel_major_crosses',{}],['intel_bond_indices',{}],['intel_earnings_calendar',{}],['intel_earnings_surprise',{symbol:'AAPL'}],['intel_recent_8k',{}],['intel_sec_filings',{}],['intel_company_filings',{ticker:'AAPL'}]] as const) expect((await h[name](args)).degraded).toBe(true);
    const curve = await h.intel_yield_curve({}); expect(curve.inverted).toBeNull(); expect(curve.error).toContain('No Treasury yield'); expect(curve.data_gaps).toHaveLength(5);
  });
  it('validates path-affecting inputs before outbound requests', async () => {
    const c = setup(() => ({}));
    await expect(c.handlers.intel_forex_rates({base:'https://evil'})).rejects.toThrow();
    await expect(c.handlers.intel_earnings_surprise({symbol:'../../private'})).rejects.toThrow();
    await expect(c.handlers.intel_company_filings({ticker:'http://localhost'})).rejects.toThrow();
    await expect(c.handlers.intel_sec_filings({date_range:'bad'})).rejects.toThrow(); expect(c.fetch).not.toHaveBeenCalled();
  });
});


describe('finance composites', () => {
  it('macro formula matches threshold labels and weighted score', () => {
    const r=computeMacroComposite({signals:{fear_greed:{value:80,classification:'Extreme Greed'},vix:{price:14},dxy:{price:99},treasury_10y:{price:2.5}}},{sectors:[{name:'Tech',change_pct:2},{name:'Energy',change_pct:-1}]},{cross_signal:'golden_cross',mayer_multiple:1.1},'2026-01-01T00:00:00Z');
    expect(r.score).toBe(74.8);expect(r.verdict).toBe('CONSTRUCTIVE');expect(r.signals.vix.label).toBe('complacent');expect(r.degraded).toBeUndefined();
  });
  it('missing macro inputs never quietly read as a neutral observed market', () => {
    const r=computeMacroComposite({}, {}, {}, '2026-01-01T00:00:00Z');expect(r.score).toBe(50);expect(r.degraded).toBe(true);expect(r.error).toBe('No macro inputs available');expect(r.data_gaps).toHaveLength(6);
  });
  it('company enrichment combines only actual provider fields', async () => {
    const c=setup(url=>{
      if(url.pathname.includes('/chart/'))return {chart:{result:[{meta:{regularMarketPrice:102,previousClose:100,regularMarketVolume:42}}]}};
      if(url.pathname.includes('/quoteSummary/'))return {quoteSummary:{result:[{assetProfile:{sector:'Technology',industry:'Software',fullTimeEmployees:100,longBusinessSummary:'Example software'},financialData:{totalRevenue:{raw:123}},defaultKeyStatistics:{marketCap:{raw:999},forwardPE:{raw:10}}}]}};
      if(url.hostname==='api.gdeltproject.org')return {articles:[{title:'News',url:'https://example.test',seendate:'20260101'}]};
      if(url.hostname==='api.github.com')return {items:[{full_name:'EX/project',owner:{login:'EX'},stargazers_count:3,html_url:'https://github.com/EX/project'}]};
      if(url.hostname==='www.sec.gov')return {'0':{ticker:'EX',cik_str:123,title:'Example'}};
      return {filings:{recent:{form:[]}}};
    },{secUserAgent:'Test fixture@example.test'});
    const r=await c.handlers.intel_company_profile({query:'EX'});expect(r.company_name).toBe('Example software');expect(r.stock).toMatchObject({price:102,change_pct:2,market_cap:999});expect(r.financials.revenue).toBe(123);expect(r.recent_news).toHaveLength(1);expect(r.github).toHaveLength(1);expect(r.sec_filings).toEqual([]);expect(r.degraded).toBeUndefined();
  });
});

it('finance transport rejects nondefault ports, fragments, credentials and off-allowlist origins', () => {
 const base='https://api.frankfurter.dev/v1/latest';
 expect(()=>validateFinanceUrl(new URL(base))).not.toThrow();
 for(const bad of [base+'#hidden','https://api.frankfurter.dev:8443/v1/latest','https://user:pass@api.frankfurter.dev/v1/latest','http://api.frankfurter.dev/v1/latest','https://api.frankfurter.dev.evil.test/v1/latest', 'https://api.frankfurter.dev/v1/admin'])expect(()=>validateFinanceUrl(new URL(bad))).toThrow('outside fixed allowlist');
});
