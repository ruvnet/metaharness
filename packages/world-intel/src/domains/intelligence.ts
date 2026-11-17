// SPDX-License-Identifier: MIT
// Native port of country brief/risk scoring, upstream fdebf9a8. Phoenix AGI MIT.
// See THIRD_PARTY_NOTICES.md. Optional integrations are explicit, never fabricated.
import type {DomainHandlers} from '../domain-runtime.js';
import {pyRound} from './markets.js';
type Row=Record<string,any>;
export type AcledReason='acled_unconfigured'|'acled_auth_failed'|'acled_fetch_failed';
export interface AcledResult {data:Row|null;reason?:AcledReason}
export interface IntelligenceOptions {
 fetch?:typeof globalThis.fetch;now?:()=>number;timeoutMs?:number;maxBytes?:number;
 acledQuery?:(params:Record<string,string|number>)=>Promise<AcledResult>;
 /** Caller supplies an explicitly configured LLM adapter; no localhost probe by default. */
 generateBrief?:(prompt:string)=>Promise<string>;
}
const messages:Record<AcledReason,string>={acled_unconfigured:'ACLED credentials not configured (ACLED_EMAIL + ACLED_PASSWORD)',acled_auth_failed:'ACLED sign-in failed: ACLED_EMAIL and ACLED_PASSWORD are set, but the token request was refused or did not complete',acled_fetch_failed:'ACLED fetch failed (rate limited, API error, or malformed response)'};
const baselines:Record<string,number>={Syria:5000,Yemen:3000,Ukraine:8000,Myanmar:4000,Somalia:2500,Nigeria:3500,'DR Congo':3000,Afghanistan:2000,Iraq:1500,Mali:2000,'Burkina Faso':2500,Ethiopia:2000,Sudan:3000,'South Sudan':1500,Cameroon:1000,Mozambique:800,Pakistan:1200,India:1000,Colombia:1500,Mexico:4000};
const day=(n:number)=>new Date(n).toISOString().slice(0,10);
const stamp=(n:number)=>new Date(n).toISOString().replace(/\.\d{3}Z$/,'Z');
export class IntelligenceClient {
 private readonly now:()=>number;private readonly fetcher:typeof globalThis.fetch;
 private cache=new Map<string,{at:number;data:unknown}>();
 constructor(private readonly options:IntelligenceOptions={}){this.now=options.now??Date.now;this.fetcher=options.fetch??globalThis.fetch;}
 private async indicator(code:string,indicator:string):Promise<Row[]>{
  const url=new URL(`https://api.worldbank.org/v2/country/${code}/indicator/${indicator}`);url.search=new URLSearchParams({format:'json',per_page:'5',date:'2020:2025'}).toString();
  const key=url.href,cached=this.cache.get(key);let data:any;
  if(cached&&this.now()-cached.at<86400000)data=structuredClone(cached.data);
  else{
   const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
   try{
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('World Bank timeout'));},this.options.timeoutMs??15000);});
    const read=async()=>{const response=await this.fetcher(url,{redirect:'error',credentials:'omit',signal:controller.signal,headers:{Accept:'application/json','User-Agent':'metaharness-world-intel/0.1.0'}});if(!response.ok){await response.body?.cancel();throw new Error(`World Bank HTTP ${response.status}`);}const reader=response.body?.getReader();if(!reader)throw new Error('World Bank empty response');const abort=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',abort,{once:true});try{const chunks:Uint8Array[]=[];let bytes=0;while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;if(bytes>(this.options.maxBytes??4000000)){await reader.cancel();throw new Error('World Bank response limit exceeded');}chunks.push(r.value);}if(controller.signal.aborted)throw new Error('World Bank timeout');return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{controller.signal.removeEventListener('abort',abort);reader.releaseLock();}};
    data=await Promise.race([read(),timeout]);if(this.cache.size>=256)this.cache.delete(this.cache.keys().next().value!);this.cache.set(key,{data:structuredClone(data),at:this.now()});
   }catch{return [];}finally{if(timer)clearTimeout(timer);}
  }
  if(!Array.isArray(data)||!Array.isArray(data[1]))return [];
  return data[1].flatMap((r:Row)=>r?.date!=null&&r.value!=null&&r.value!==''&&Number.isFinite(Number(r.value))?[{year:r.date,value:Number(r.value)}]:[]);
 }
 private async acled(params:Record<string,string|number>):Promise<AcledResult>{
  if(!this.options.acledQuery)return {data:null,reason:'acled_unconfigured'};
  try{const result=await this.options.acledQuery(params);if(!result.data||typeof result.data!=='object'||Array.isArray(result.data))return {data:null,reason:result.reason??'acled_fetch_failed'};return result;}catch{return {data:null,reason:'acled_fetch_failed'};}
 }
 async countryBrief(countryCode='US'):Promise<Row>{
  if(!/^[A-Za-z]{2}$/.test(countryCode))throw new Error('country_code must be a two-letter ISO code');
  const now=this.now(),params={limit:0,event_date:`${day(now-30*86400000)}|${day(now)}`,event_date_where:'BETWEEN',country:countryCode};
  const [gdp,inflation,acled]=await Promise.all([this.indicator(countryCode,'NY.GDP.MKTP.CD'),this.indicator(countryCode,'FP.CPI.TOTL.ZG'),this.acled(params)]);
  const events=Array.isArray(acled.data?.data)?acled.data!.data.length:0,raw=acled.data?.count;
  const count=raw==null?events:Number.isFinite(Number(raw))?Math.trunc(Number(raw)):events;
  let brief='LLM brief unavailable. Data summary below.',llm=false;
  if(this.options.generateBrief){try{const text=await this.options.generateBrief(`Provide a concise 3-paragraph intelligence brief for ${countryCode}. Cover: (1) current political stability and governance, (2) economic outlook and risks, (3) security concerns and regional dynamics. Be factual and analytical.`);if(typeof text==='string'&&text.trim()){brief=text.trim();llm=true;}}catch{/* Upstream data-only fallback. */}}
  // Preserve upstream data shape, while gaps prevent zero events reading as measured peace.
  const gaps:string[]=acled.data?[]:[acled.reason??'acled_fetch_failed'];
  if(!gdp.length)gaps.push('world_bank_gdp_unavailable');if(!inflation.length)gaps.push('world_bank_inflation_unavailable');
  return {country_code:countryCode,brief,data:{gdp,inflation,recent_events:acled.data?count:0},llm_available:llm,data_gaps:gaps,...(gaps.length?{degraded:true}:{}),source:'country-intelligence',timestamp:stamp(now)};
 }
 async riskScores(limit=20):Promise<Row>{
  if(!Number.isInteger(limit)||limit<1||limit>200)throw new Error('limit must be an integer in 1..200');const now=this.now(),base={source:'risk-analysis',timestamp:stamp(now)};
  const result=await this.acled({limit:500,event_date:`${day(now-30*86400000)}|${day(now)}`,event_date_where:'BETWEEN'});
  if(!result.data){const reason=result.reason??'acled_fetch_failed';return {error:messages[reason],...(reason==='acled_unconfigured'?{note:'Free academic access at acleddata.com'}:{degraded:true}),...base};}
  const counts=new Map<string,number>();for(const row of Array.isArray(result.data.data)?result.data.data:[])if(row?.country)counts.set(String(row.country),(counts.get(String(row.country))??0)+1);
  const countries=[...counts].map(([country,events])=>{const monthly=(baselines[country]??500)/12,score=events/monthly*100;return {country,events_30d:events,monthly_baseline:pyRound(monthly,1),risk_score:pyRound(score,1),risk_level:score>150?'critical':score>100?'elevated':score>50?'moderate':'low'};}).sort((a,b)=>b.risk_score-a.risk_score).slice(0,limit);
  return {countries,count:countries.length,...base};
 }
}
export function createIntelligenceHandlers(client=new IntelligenceClient()):DomainHandlers{return {intel_country_brief:a=>client.countryBrief(String(a.country_code??'US')),intel_risk_scores:a=>client.riskScores(Number(a.limit??20))};}
