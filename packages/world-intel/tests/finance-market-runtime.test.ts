import {it,expect,vi} from 'vitest';
import {SourceRuntime,createSourceRateState} from '../src/source-runtime.js';
import {MarketTransport,marketSourceRules} from '../src/domains/markets.js';
import {FinanceTransport,financeSourceRules} from '../src/domains/finance.js';
function runtime(rules:any,fetch:any,now=()=>10000){return new SourceRuntime({rules,fetch,now,maxRetries:0,sleep:async()=>{},rateState:createSourceRateState()});}
it('market JSON and text use shared runtime cache, TTL, stale history and breaker state',async()=>{
 let time=10000,fail=false;const fetch=vi.fn(async()=>fail?new Response('',{status:503}):new Response('{"ok":true}'));
 const r=runtime(marketSourceRules(),fetch,()=>time),t=new MarketTransport({sourceRuntime:r,now:()=>time*1000});
 const u=new URL('https://query1.finance.yahoo.com/v8/finance/chart/AAPL');
 expect(await t.json(u,5)).toEqual({ok:true});await t.json(u,5);expect(fetch).toHaveBeenCalledTimes(1);
 expect(r.cache.stats().total_entries).toBe(1);time+=6;fail=true;
 expect(await t.json(u,5)).toEqual({ok:true,_stale:true,_stale_age_seconds:6});
 expect(t.stale(u)).toEqual({time:10000000,text:'{"ok":true}'});
 expect(JSON.stringify(r.health().breakers)).toContain('yahoo-finance');
});
it('finance preserves explicit SEC contact and header-sensitive cache isolation',async()=>{
 const fetch=vi.fn(async()=>new Response('{"ok":true}')),r=runtime(financeSourceRules(),fetch);
 await expect(new FinanceTransport({sourceRuntime:r}).json('https://www.sec.gov/files/company_tickers.json')).rejects.toThrow('contact');
 expect(fetch).not.toHaveBeenCalled();
 for(const secUserAgent of ['Analyst one@example.com','Analyst two@example.com']){
 const t=new FinanceTransport({sourceRuntime:r,secUserAgent});await t.json('https://www.sec.gov/files/company_tickers.json',{},20);await t.json('https://www.sec.gov/files/company_tickers.json',{},20);
 }
 expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls[0]![1].headers['User-Agent']).toBe('Analyst one@example.com');
});
it('runtime injection cannot bypass domain path/port/redirect or response cap restrictions',async()=>{
 const fetch=vi.fn(async()=>new Response(null,{status:302,headers:{location:'https://query1.finance.yahoo.com/v8/finance/chart/MSFT'}}));
 const r=runtime({'yahoo-finance':{origins:['https://query1.finance.yahoo.com']}},fetch),t=new MarketTransport({sourceRuntime:r});
 await expect(t.json(new URL('https://query1.finance.yahoo.com/private'))).rejects.toThrow('allowlist');
 await expect(t.text(new URL('https://query1.finance.yahoo.com:444/v8/finance/chart/AAPL'))).rejects.toThrow('allowlist');
 expect(fetch).not.toHaveBeenCalled();expect(await t.json(new URL('https://query1.finance.yahoo.com/v8/finance/chart/AAPL'))).toBeNull();
 expect(fetch).toHaveBeenCalledTimes(1);
 const large=runtime(marketSourceRules(),async()=>new Response('{"large":"value"}'));
 expect(await new MarketTransport({sourceRuntime:large,maxBytes:4}).json(new URL('https://query1.finance.yahoo.com/v8/finance/chart/AAPL'))).toBeNull();
});
it('stale array/text payloads go through explicit fallback instead of appearing fresh',async()=>{
 let time=10000,fail=false;const fetch=vi.fn(async()=>new Response(fail?'':'[{"id":"a"}]',{status:fail?503:200})),r=runtime(marketSourceRules(),fetch,()=>time),t=new MarketTransport({sourceRuntime:r,now:()=>time*1000});
 const u=new URL('https://gamma-api.polymarket.com/markets');await t.json(u,1);time+=2;fail=true;
 expect(await t.json(u,1)).toBeNull();expect(t.stale(u)?.text).toBe('[{"id":"a"}]');
});
it('explicit origin credentials reach only their designated provider and partition runtime cache',async()=>{
 const fetch=vi.fn(async()=>new Response('{"states":[]}')),r=runtime(marketSourceRules(),fetch);
 const headersByOrigin={'https://opensky-network.org':{Authorization:'Basic explicit-fixture'}},t=new MarketTransport({sourceRuntime:r,headersByOrigin});
 await t.json(new URL('https://opensky-network.org/api/states/all'));await t.json(new URL('https://api.adsb.lol/v2/mil'));
 expect(fetch.mock.calls[0]![1].headers.Authorization).toBe('Basic explicit-fixture');
 expect(fetch.mock.calls[1]![1].headers.Authorization).toBeUndefined();
});
