import {type SourceRuntime, type SourceRule, recordingStaleServes} from '../source-runtime.js';
// SPDX-License-Identifier: MIT
// Native port of pinned marc-shade/world-intel-mcp sources/conflict.py (MIT).
import type {DomainHandlers} from '../domain-runtime.js';
const ACLED='https://acleddata.com/api/acled/read',TOKEN='https://acleddata.com/oauth/token',UCDP='https://ucdpapi.pcr.uu.se/api/gedevents/25.1';
type Row=Record<string,any>;
export interface ConflictAnswer {data:unknown;fetchedAt?:number;staleAgeSeconds?:number}
export interface ConflictTransport {get(url:URL,headers:Record<string,string>,ttl:number):Promise<ConflictAnswer|null>;token(form:URLSearchParams):Promise<unknown>}
export interface ConflictCredentials {acledEmail?:string;acledPassword?:string;acledRefreshToken?:string;ucdpAccessToken?:string}
/** Credentials live only in the caller's injected instance, never environment/global storage. */
export function createConflictTransport(fetcher:typeof fetch=fetch,sourceRuntime?:SourceRuntime):ConflictTransport {
 const cache=new Map<string,{data:unknown;time:number}>();
 async function request(url:URL,init:RequestInit):Promise<unknown>{
  const response=await fetcher(url,{...init,redirect:'error',credentials:'omit',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('Provider request failed');
  const reader=response.body?.getReader();if(!reader)throw new Error('No response body');let length=0;const parts:Uint8Array[]=[];try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>8_000_000){await reader.cancel();throw new Error('Response too large');}parts.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }
 return {
  async get(url,headers,ttl){if(url.username||url.password||url.hash||url.origin+url.pathname!==ACLED&&url.origin+url.pathname!==UCDP)throw new Error('Unapproved conflict endpoint');
   if(sourceRuntime){const o={source:url.hostname==='acleddata.com'?'acled':'ucdp',cacheTtl:ttl,maxBytes:8_000_000,timeoutSeconds:30,followRedirects:false,headers:{Accept:'application/json',...headers}};const {value,staleServes}=await recordingStaleServes(()=>sourceRuntime.getJson(url,o));if(value===null)return null;const meta=sourceRuntime.cache.getStaleMeta(sourceRuntime.cacheIdentity(url,o));return {data:value,...(meta?{fetchedAt:meta[1]}:{}),...(staleServes.length?{staleAgeSeconds:staleServes[0]!.age_seconds}:{})};}
   // The instance is credential-scoped; token rotation must not cross credential sets.
   const key=url.href+'\n'+JSON.stringify(headers),old=cache.get(key),now=Date.now()/1000;if(old&&now-old.time<ttl)return {data:old.data,fetchedAt:old.time};
   try{const data=await request(url,{headers:{Accept:'application/json',...headers}});if(cache.size>=500)cache.delete(cache.keys().next().value!);cache.set(key,{data,time:now});return {data,fetchedAt:now};}catch{return old?{data:old.data,fetchedAt:old.time,staleAgeSeconds:Math.max(0,now-old.time)}:null;}
  },
  token:form=>request(new URL(TOKEN),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:form}),
 };
}
const row=(v:unknown):Row|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Row:null;
const fields=(r:Row,keys:string[])=>Object.fromEntries(keys.map(k=>[k,r[k]??null]));
const iso=(d:Date)=>d.toISOString().replace(/\.\d{3}Z$/,'Z');
const integer=(v:unknown,fallback:number,max=100000)=>{if(v===undefined)return fallback;if(typeof v!=='number'||!Number.isSafeInteger(v)||v<1||v>max)throw new Error(`Expected integer in 1..${max}`);return v;};
const pyInt=(v:unknown,fallback=0)=>{if(typeof v==='number'&&Number.isFinite(v))return Math.trunc(v);if(typeof v==='boolean')return Number(v);if(typeof v==='string'&&/^[+-]?\d+$/.test(v.trim()))return Number(v);return fallback;};
export interface ConflictOptions {sourceRuntime?:SourceRuntime;transport?:ConflictTransport;credentials?:ConflictCredentials;now?:()=>Date;maxPages?:number}
export function createConflictClient(options:ConflictOptions={}){
 const transport=options.transport??createConflictTransport(fetch,options.sourceRuntime),credentials={...options.credentials},now=options.now??(()=>new Date());const maxPages=options.maxPages??1000;
 if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>10000)throw new Error('maxPages must be 1..10000');
 let access:string|undefined,expires=0,refresh=credentials.acledRefreshToken,inflight:Promise<string|undefined>|undefined;
 async function getToken():Promise<string|undefined>{
  if(access&&now().getTime()/1000<expires-300)return access;if(inflight)return inflight;
  inflight=(async()=>{for(let attempt=0;attempt<2;attempt++){
   const useRefresh=Boolean(refresh);let form:URLSearchParams;if(useRefresh)form=new URLSearchParams({grant_type:'refresh_token',refresh_token:refresh!,client_id:'acled'});else if(credentials.acledEmail&&credentials.acledPassword)form=new URLSearchParams({grant_type:'password',username:credentials.acledEmail,password:credentials.acledPassword,client_id:'acled'});else return undefined;
   try{const data=row(await transport.token(form));if(typeof data?.access_token!=='string'||!data.access_token)throw new Error('No token');access=data.access_token;expires=now().getTime()/1000+(typeof data.expires_in==='number'?data.expires_in:86400);if(typeof data.refresh_token==='string')refresh=data.refresh_token;return access;}catch{if(useRefresh&&credentials.acledEmail&&credentials.acledPassword){refresh=undefined;continue;}return undefined;}
  }return undefined;})();try{return await inflight;}finally{inflight=undefined;}
 }
 const safeGet=async(url:URL,headers:Record<string,string>,ttl:number)=>{try{return await transport.get(url,headers,ttl);}catch{return null;}};
 /** Raw ACLED query shares this instance's OAuth lock/cache; no credentials enter tool arguments. */
 const acledQuery=async(params:Record<string,string|number>,ttl=900):Promise<import('./intelligence.js').AcledResult>=>{
  const allowed=new Set(['limit','event_date','event_date_where','country','event_type','event_type_where']);
  if(Object.keys(params).some(k=>!allowed.has(k))||!Number.isSafeInteger(params.limit)||Number(params.limit)<0||Number(params.limit)>100000||Object.values(params).some(v=>typeof v==='string'&&(v.length>500||/[\x00-\x1f]/.test(v))))throw new Error('Invalid bounded ACLED query');
  if(!Number.isFinite(ttl)||ttl<0||ttl>86400)throw new Error('Invalid ACLED cache duration');
  const token=await getToken();if(!token)return {data:null,reason:credentials.acledEmail&&credentials.acledPassword||credentials.acledRefreshToken?'acled_auth_failed':'acled_unconfigured'};
  const url=new URL(ACLED);for(const [k,v]of Object.entries(params))url.searchParams.set(k,String(v));const answer=await safeGet(url,{Authorization:`Bearer ${token}`},ttl),data=row(answer?.data);
  if(!data||!(Array.isArray(data.data)||(params.limit===0&&Number.isFinite(Number(data.count)))))return {data:null,reason:'acled_fetch_failed'};
  // Composites score current activity: expired copies are explicitly unavailable, never fresh zeros.
  if(answer?.staleAgeSeconds!==undefined)return {data:null,reason:'acled_stale'};
  return {data:structuredClone(data)};
 };
 const handlers:DomainHandlers={
  intel_acled_events:async args=>{
   const date=now(),days=integer(args.days,7),limit=integer(args.limit,100),country=args.country?String(args.country):null;
   const token=await getToken();let reason:string|undefined;
   if(!token)reason=credentials.acledEmail&&credentials.acledPassword||credentials.acledRefreshToken?'acled_auth_failed':'acled_unconfigured';
   const url=new URL(ACLED);url.search=new URLSearchParams({limit:String(limit),event_date:`${new Date(date.getTime()-days*86400000).toISOString().slice(0,10)}|${date.toISOString().slice(0,10)}`,event_date_where:'BETWEEN',...(country?{country}:{})}).toString();
   const answer=token?await safeGet(url,{Authorization:`Bearer ${token}`},900):null;const data=row(answer?.data);if(!reason&&(!data||!Array.isArray(data.data)))reason='acled_fetch_failed';
   const failure=()=>{const error=reason==='acled_unconfigured'?'ACLED credentials not configured (ACLED_EMAIL + ACLED_PASSWORD)':reason==='acled_auth_failed'?'ACLED sign-in failed: ACLED_EMAIL and ACLED_PASSWORD are set, but the token request was refused or did not complete':'ACLED fetch failed (rate limited, API error, or malformed response)';return reason==='acled_unconfigured'?{error,note:'Free access at acleddata.com',reason}:{error,degraded:true,reason,events:[],count:0,query:{country,days},source:'acled',timestamp:iso(date)};};
   if(reason)return failure();
   const events:Row[]=[];for(const v of data!.data){const event=row(v);if(!event){reason='acled_fetch_failed';return failure();}const fatal=event.fatalities==null?0:pyInt(event.fatalities,NaN);if(!Number.isFinite(fatal)){reason='acled_fetch_failed';return failure();}events.push({...fields(event,['event_id_cnty','event_date','event_type','sub_event_type','actor1','actor2','country','admin1','admin2','location','latitude','longitude','notes','source']),fatalities:fatal});}
   events.sort((a,b)=>String(b.event_date??'').localeCompare(String(a.event_date??'')));events.sort((a,b)=>b.fatalities-a.fatalities);
   const stale=answer!.staleAgeSeconds;return {events,count:events.length,query:{country,days},source:'acled',timestamp:iso(date),fetched_at:iso(new Date((answer!.fetchedAt??date.getTime()/1000-(stale??0))*1000)),...(stale!==undefined?{_stale:true,_stale_age_seconds:Math.round(stale*10)/10}:{})};
  },
  intel_ucdp_events:async args=>{
   const date=now(),days=integer(args.days,30),pageSize=Math.min(integer(args.limit,100),1000),cutoff=date.getTime()-days*86400000;
   const headers:Record<string,string>=credentials.ucdpAccessToken?{'x-ucdp-access-token':credentials.ucdpAccessToken}:{};
   const getPage=async(page:number)=>{const url=new URL(UCDP);url.search=new URLSearchParams({pagesize:String(pageSize),page:String(page)}).toString();return safeGet(url,headers,21600);};
   const first=await getPage(0),data=row(first?.data);const base={events:[] as Row[],count:0,total_fatalities_best:0,query:{days},source:'ucdp',timestamp:iso(date)};
   if(!data||!Array.isArray(data.Result))return {...base,error:credentials.ucdpAccessToken?'UCDP fetch failed (token refused, rate limited, API error, or malformed response)':'UCDP_ACCESS_TOKEN is not set and the request failed; the UCDP API refuses requests without a token',degraded:true,reason:credentials.ucdpAccessToken?'ucdp_fetch_failed':'ucdp_unconfigured'};
   const total=data.TotalPages??1;if(!Number.isSafeInteger(total)||total<1)return {...base,error:'Malformed UCDP page count',degraded:true,reason:'ucdp_fetch_failed'};
   const records=[...data.Result],failed:number[]=[],stalePages:number[]=first?.staleAgeSeconds!==undefined?[0]:[];
   for(let offset=1;offset<Math.min(total,maxPages);offset+=8){const pages=Array.from({length:Math.min(8,Math.min(total,maxPages)-offset)},(_,i)=>offset+i);await Promise.all(pages.map(async p=>{const answer=await getPage(p),page=row(answer?.data);return {p,page,answer};})).then(results=>{for(const {p,page,answer} of results){if(page&&Array.isArray(page.Result)){records.push(...page.Result);if(answer?.staleAgeSeconds!==undefined)stalePages.push(p);}else failed.push(p);}});}
   for(let p=maxPages;p<total&&failed.length<10000;p++)failed.push(p);
   const labels:Record<number,string>={1:'state-based',2:'non-state',3:'one-sided'};
   for(const raw of records){const r=row(raw);if(!r||typeof r.date_start!=='string')continue;const text=r.date_start.slice(0,10),time=Date.parse(text+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(text)||!Number.isFinite(time)||iso(new Date(time)).slice(0,10)!==text||time<cutoff)continue;
    const type=r.type_of_violence==null?null:pyInt(r.type_of_violence,NaN);const vtype=type!==null&&Number.isFinite(type)?type:null;const best=pyInt(r.best);base.total_fatalities_best+=best;base.events.push({...fields(r,['id','relid','year','date_start','date_end','country','region','side_a','side_b','latitude','longitude','source_article','source_headline']),type_of_violence:vtype,type_of_violence_label:vtype===null?'unknown':labels[vtype]??'unknown',best,high:pyInt(r.high),low:pyInt(r.low)});
   }base.count=base.events.length;const gaps:string[]=[];if(failed.length)gaps.push(`UCDP: ${failed.length} of ${total} pages could not be fetched, so count and total_fatalities_best are lower bounds`);if(total>maxPages)gaps.push(`Safety page budget ${maxPages} reached; remaining pages were not requested`);if(stalePages.length)gaps.push(`UCDP stale cached pages: ${stalePages.join(', ')}`);
   return {...base,...(gaps.length?{degraded:true,reason:failed.length?'ucdp_partial':'ucdp_stale',pages_failed:failed,pages_total:total,data_gaps:gaps}:{}),...(stalePages.length?{_stale:true,stale_pages:stalePages}:{})};
  },
 };
 return {handlers,acledQuery};
}
export function createConflictHandlers(options:ConflictOptions={}):DomainHandlers{return createConflictClient(options).handlers;}

export function conflictSourceRules():Record<string,SourceRule>{return {acled:{origins:['https://acleddata.com'],path:/^\/api\/acled\/read$/},ucdp:{origins:['https://ucdpapi.pcr.uu.se'],path:/^\/api\/gedevents\/25\.1$/}};}
