// SPDX-License-Identifier: MIT
// Native port of upstream sources/news.py, Phoenix AGI MIT pinned fdebf9a8.
import {readFileSync} from 'node:fs';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {recordingStaleServes,type SourceRuntime,type SourceRule} from '../source-runtime.js';
import type {DomainHandlers} from '../domain-runtime.js';
type Row=Record<string,any>;
const ref:Row=JSON.parse(readFileSync(new URL('../../data/news/reference.json',import.meta.url),'utf8'));
export const RSS_FEEDS:Record<string,[string,string][]>=ref._RSS_FEEDS;
export const outletFor=(name:string):string=>ref.FEED_OUTLETS[name]??name;
const rssSources=new Map(Object.values(RSS_FEEDS).flat().map(([name,url])=>[url,`rss:${name.toLowerCase().replaceAll(' ','_')}`]));
const approved=new Set(Object.values(RSS_FEEDS).flat().map(([,url])=>url));
const stopwords=new Set<string>(ref._STOPWORDS);
const arr=(v:any):Row[]=>v==null?[]:Array.isArray(v)?v:[v];
const text=(v:any):string=>typeof v==='string'?v:v==null?'':String(v['#text']??'');
const truncate=(v:string,n:number)=>[...v].length>n?[...v].slice(0,n).join('')+'...':v;
const webLink=(v:string)=>/^https?:\/\//i.test(v.trim())?v.trim():'';
const iso=(d:Date)=>d.toISOString().replace(/\.\d{3}Z$/,'Z');
function published(entry:Row):string|null{const raw=text(entry.pubDate??entry.published??entry['dc:date']??entry.date??entry.updated);if(!raw)return null;const t=Date.parse(raw);return Number.isFinite(t)?iso(new Date(t)):raw;}
export function parseFeed(xml:string,name:string,category:string):Row[]{
 if(/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))throw new Error('DTD/entity declarations are not allowed');
 if(XMLValidator.validate(xml)!==true)throw new Error('Malformed RSS/Atom XML');
 const doc=new XMLParser({ignoreAttributes:false,parseTagValue:false,trimValues:false,processEntities:true}).parse(xml);
 const entries=arr(doc.rss?.channel?.item??doc.feed?.entry??doc['rdf:RDF']?.item??doc.RDF?.item);
 return entries.map(entry=>{const links=arr(entry.link);const atom=links.find(l=>l?.['@_rel']==='alternate')??links.find(l=>!l?.['@_rel'])??links[0];const link=typeof atom==='string'?atom:text(atom?.['@_href']??atom);return {title:truncate(text(entry.title),500),link:webLink(link),published:published(entry),summary:truncate(text(entry.summary??entry.description??entry['content:encoded']??''),200),feed_name:name,category,source_tier:ref.SOURCE_TIERS[name]??'unknown'};});
}
export interface NewsOptions{sourceRuntime?:SourceRuntime;fetch?:typeof fetch;now?:()=>Date;concurrency?:number;maxBytes?:number;timeoutMs?:number;maxStaleMs?:number;gdeltIntervalMs?:number}
interface CacheEntry{value:string;time:number}
export class NewsClient{
 private sourceRuntime?:SourceRuntime;private fetchFn:typeof fetch;private now:()=>Date;private concurrency:number;private maxBytes:number;private timeoutMs:number;private staleMs:number;
 private gdeltIntervalMs:number;private gdeltLast=0;private gdeltQueue:Promise<void>=Promise.resolve();
 private cache=new Map<string,CacheEntry>();private inflight=new Map<string,Promise<{items:Row[];failed:string[];stale:string[]}>>();
 constructor(o:NewsOptions={}){this.sourceRuntime=o.sourceRuntime;this.gdeltIntervalMs=o.gdeltIntervalMs??5000;if(!Number.isInteger(this.gdeltIntervalMs)||this.gdeltIntervalMs<0||this.gdeltIntervalMs>60000)throw new RangeError('Invalid GDELT interval');this.fetchFn=o.fetch??fetch;this.now=o.now??(()=>new Date());this.concurrency=o.concurrency??25;this.maxBytes=o.maxBytes??4_000_000;this.timeoutMs=o.timeoutMs??8000;this.staleMs=o.maxStaleMs??86400000;for(const [k,v,max]of [['concurrency',this.concurrency,25],['maxBytes',this.maxBytes,10_000_000],['timeoutMs',this.timeoutMs,45000],['maxStaleMs',this.staleMs,604800000]]as const)if(!Number.isInteger(v)||v<1||v>max)throw new RangeError(`Invalid ${k}`);}
 private async request(url:string,ttl:number):Promise<{value:string;stale:boolean;time:number}>{
  const u=new URL(url);if(!approved.has(url)&&!(u.origin==='https://api.gdeltproject.org'&&u.pathname==='/api/v2/doc/doc'))throw new Error('Unapproved news URL');if(u.username||u.password||u.hash)throw new Error('Invalid news URL');
  if(this.sourceRuntime){const runtime=this.sourceRuntime,source=u.hostname==='api.gdeltproject.org'?'gdelt':rssSources.get(url)!;
   const args={source,cacheKey:source==='gdelt'?'news:gdelt':`news:rss:${source.slice(4)}`,cacheTtl:ttl/1000,timeoutSeconds:source==='gdelt'?45:this.timeoutMs/1000,maxBytes:this.maxBytes,followRedirects:false,validateUrl:(v:URL)=>{if(v.href!==url)throw new Error('News redirects forbidden');}};
   const format=source==='gdelt'?'json':'text';const read=await recordingStaleServes<unknown>(()=>format==='json'?runtime.getJson(u,args):runtime.getText(u,args));if(read.value===null)throw new Error('News source unavailable');const meta=runtime.cache.getStaleMeta(runtime.cacheIdentity(u,args,format));return {value:format==='json'?JSON.stringify(read.value):String(read.value),time:(meta?.[1]??this.now().getTime()/1000)*1000,stale:read.staleServes.length>0};
  }
  const old=this.cache.get(url),time=this.now().getTime();if(old&&time-old.time<ttl)return {...old,stale:false};
  if(u.hostname==='api.gdeltproject.org'&&this.gdeltIntervalMs){let release!:()=>void;const gate=new Promise<void>(r=>{release=r;}),previous=this.gdeltQueue;this.gdeltQueue=previous.then(()=>gate);await previous;try{const wait=Math.max(0,this.gdeltLast+this.gdeltIntervalMs-Date.now());if(wait)await new Promise(r=>setTimeout(r,wait));this.gdeltLast=Date.now();}finally{release();}}
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('News request timed out'));},u.hostname==='api.gdeltproject.org'?45000:this.timeoutMs);});
  try{const read=async()=>{const r=await this.fetchFn(u,{signal:controller.signal,redirect:'error',credentials:'omit',headers:{'User-Agent':'metaharness-world-intel/0.1.0 (https://github.com/ruvnet/metaharness)','Accept':'application/rss+xml, application/atom+xml, application/xml, application/json, text/xml'}});if(!r.ok){await r.body?.cancel();throw new Error(`News HTTP ${r.status}`);}if(Number(r.headers.get('content-length')??0)>this.maxBytes){await r.body?.cancel();throw new Error('News response too large');}if(!r.body)throw new Error('Missing news body');const reader=r.body.getReader(),chunks:Uint8Array[]=[];let total=0;const cancel=()=>{void reader.cancel().catch(()=>undefined);};controller.signal.addEventListener('abort',cancel,{once:true});try{while(true){const {value,done}=await reader.read();if(done)break;total+=value.length;if(total>this.maxBytes)throw new Error('News response too large');chunks.push(value);}}finally{controller.signal.removeEventListener('abort',cancel);await reader.cancel();}const bytes=new Uint8Array(total);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return new TextDecoder().decode(bytes);};const value=await Promise.race([read(),timeout]);if(this.cache.size>=256)this.cache.delete(this.cache.keys().next().value!);const next={value,time:this.now().getTime()};this.cache.set(url,next);return {...next,stale:false};}
  catch(error){if(old&&time-old.time<ttl+this.staleMs)return {...old,stale:true};throw error;}finally{if(timer)clearTimeout(timer);}
 }
 async newsFeed({category,limit=50}:{category?:string;limit?:number}={}):Promise<Row>{
  const now=this.now();if(!Number.isInteger(limit)||limit<0||limit>1000000)throw new RangeError('limit must be0..1000000');
  if(category!==undefined&&!Object.hasOwn(RSS_FEEDS,category))return {items:[],count:0,categories_fetched:[],error:`Unknown category '${category}'. Valid: [${Object.keys(RSS_FEEDS).map(k=>`'${k}'`).join(', ')}]`,source:'rss-aggregator',timestamp:iso(now)};
  const categories=category===undefined?Object.keys(RSS_FEEDS):[category];const key=categories.join('|');let task=this.inflight.get(key);
  if(!task){task=this.readFeeds(categories);this.inflight.set(key,task);void task.finally(()=>{if(this.inflight.get(key)===task)this.inflight.delete(key);}).catch(()=>undefined);}
  const result=await task;const items=structuredClone(result.items).sort((a,b)=>(b.published??'').localeCompare(a.published??'')).slice(0,limit);const attempted=categories.reduce((n,c)=>n+RSS_FEEDS[c].length,0),ok=attempted-result.failed.length-result.stale.length;
  const out:Row={items,count:items.length,categories_fetched:categories,feeds_attempted:attempted,feeds_ok:ok,feeds_failed:result.failed,feeds_stale:result.stale,source:'rss-aggregator',timestamp:iso(now)};
  if(attempted&&ok===0){out.error=`All ${attempted} RSS feeds failed or timed out${result.stale.length?` (${result.stale.length} served from an expired cache copy)`:''}`;out.degraded=true;out.reason='all_feeds_failed';}else if(attempted&&ok/attempted<.5){out.degraded=true;out.reason='partial_feeds_failed';}return out;
 }
 private async readFeeds(categories:string[]){const jobs=categories.flatMap(cat=>RSS_FEEDS[cat].map(([name,url])=>({cat,name,url})));const results:Row[][]=new Array(jobs.length);const failed:string[]=[],stale:string[]=[];let next=0;
  await Promise.all(Array.from({length:Math.min(this.concurrency,jobs.length)},async()=>{while(next<jobs.length){const i=next++,{cat,name,url}=jobs[i];try{const r=await this.request(url,300000);results[i]=parseFeed(r.value,name,cat);if(r.stale)stale.push(name);}catch{results[i]=[];failed.push(name);}}}));return {items:results.flat(),failed:failed.sort(),stale:stale.sort()};}
 async trendingKeywords({hours=6,min_count=3}:{hours?:number;min_count?:number}={}):Promise<Row>{
  // Upstream hours is deliberately not a time filter.
  void hours;const feed=await this.newsFeed({limit:200}),counts=new Map<string,number>();for(const item of feed.items){const clean=String(item.title??'').toLowerCase().replace(/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/g,' ');for(const word of clean.split(/\s+/u))if([...word].length>=3&&!stopwords.has(word))counts.set(word,(counts.get(word)??0)+1);}
  const keywords=[...counts].filter(([,n])=>n>=min_count).sort((a,b)=>b[1]-a[1]).slice(0,50).map(([word,count])=>({word,count}));const out:Row={keywords,total_items_analyzed:feed.items.length,source:'keyword-analysis',timestamp:iso(this.now())};for(const k of ['feeds_attempted','feeds_ok','feeds_failed','feeds_stale','error','degraded','reason'])if(k in feed)out[k]=feed[k];return out;
 }
 /** Internal AOI timeline: default upstream GDELT window, deliberately no timespan. */
 async gdeltAreaTimeline(query:string):Promise<Row>{
  if(typeof query!=='string'||query.length>4000)throw new RangeError('Invalid GDELT area query');const u=new URL('https://api.gdeltproject.org/api/v2/doc/doc');u.search=new URLSearchParams({query,mode:'timelinevolraw',maxrecords:'50',format:'json'}).toString();
  try{const r=await this.request(u.href,600000),data=JSON.parse(r.value);if(!data||!Array.isArray(data.timeline))throw new Error('Malformed GDELT timeline');return {...data,fetched_at:iso(new Date(r.time)),...(r.stale?{_stale:true,_stale_age_seconds:(this.now().getTime()-r.time)/1000}:{})};}catch{return {error:'GDELT area timeline unavailable',degraded:true,reason:'gdelt_fetch_failed'};}
 }
 async gdeltTimeline(query:string,mode:'timelinevolraw'|'timelinetone',days:number):Promise<Row|null>{
  if(typeof query!=='string'||query.length>4000||!['timelinevolraw','timelinetone'].includes(mode)||!Number.isInteger(days)||days<1||days>90)throw new RangeError('Invalid GDELT timeline arguments');
  const u=new URL('https://api.gdeltproject.org/api/v2/doc/doc');u.search=new URLSearchParams({query,mode,timespan:`${days}d`,format:'json'}).toString();
  try{const r=await this.request(u.href,1800000),data=JSON.parse(r.value);if(!data||!Array.isArray(data.timeline))return null;return {...data,...(r.stale?{_stale:true,_stale_age_seconds:(this.now().getTime()-r.time)/1000}:{})};}catch{return null;}
 }
 async gdeltSearch({query='conflict',mode='artlist',limit=50}:{query?:string;mode?:string;limit?:number}={}):Promise<Row>{
  if(typeof query!=='string'||query.length>2000||!['artlist','timelinevol'].includes(mode)||!Number.isInteger(limit)||limit<1||limit>250)throw new RangeError('Invalid GDELT arguments');const u=new URL('https://api.gdeltproject.org/api/v2/doc/doc');u.search=new URLSearchParams({query,mode,maxrecords:String(limit),format:'json'}).toString();const base={query,mode,source:'gdelt',timestamp:iso(this.now())};
  try{const r=await this.request(u.href,600000),data=JSON.parse(r.value);if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Malformed GDELT payload');const freshness={fetched_at:iso(new Date(r.time)),...(r.stale?{_stale:true,_stale_age_seconds:Math.max(0,(this.now().getTime()-r.time)/1000)}:{})};if(mode==='artlist'){const articles=(data.articles??[]).map((a:Row)=>Object.fromEntries(['title','url','seendate','socialimage','domain','language','sourcecountry'].map(k=>[k,a[k]??null])));return {...base,articles,count:articles.length,...freshness};}const timeline=data.timeline??[];return {...base,timeline,count:Array.isArray(timeline)?timeline.length:0,...freshness};}
  catch{return {...base,error:'GDELT fetch failed (rate limited, API error, or malformed response)',degraded:true,reason:'gdelt_fetch_failed',articles:mode==='artlist'?[]:null,timeline:mode==='artlist'?null:[],count:0};}
 }
}
export function createNewsHandlers(client=new NewsClient()):DomainHandlers{return {intel_news_feed:a=>client.newsFeed(a),intel_trending_keywords:a=>client.trendingKeywords(a),intel_gdelt_search:a=>client.gdeltSearch(a)};}

/** Explicit pinned endpoint policy for a shared runtime; no arbitrary feed URLs. */
export function newsSourceRules():Record<string,SourceRule>{const rules:Record<string,SourceRule>={gdelt:{origins:['https://api.gdeltproject.org'],path:/^\/api\/v2\/doc\/doc$/}};for(const [url,source]of rssSources){const u=new URL(url);const existing=rules[source];if(existing)rules[source]={origins:[...new Set([...existing.origins,u.origin])],path:new RegExp(existing.path!.source+'|^'+u.pathname.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')};else rules[source]={origins:[u.origin],path:new RegExp('^'+u.pathname.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')};}return rules;}
