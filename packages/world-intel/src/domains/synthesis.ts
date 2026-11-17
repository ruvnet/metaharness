// SPDX-License-Identifier: MIT
// Native TS port of pinned upstream entities/classifier/clustering/spikes.
// Copyright (c) 2025-2026 Phoenix AGI; see THIRD_PARTY_NOTICES.md.
// Reference leader titles/risk values are the upstream's dated table, not verified current facts.
import {readFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import type {DomainHandlers} from '../domain-runtime.js';
type Row=Record<string,any>;
const ref:Row=JSON.parse(readFileSync(new URL('../../data/synthesis/reference.json',import.meta.url),'utf8'));
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const left='(?<![\\p{L}\\p{N}_])',right='(?![\\p{L}\\p{N}_])';
const stamp=(now=()=>new Date())=>now().toISOString().replace(/\.000Z$/,'+00:00');
function words(keys:string[],plural=false){return new RegExp(left+'(?:'+[...keys].sort((a,b)=>b.length-a.length).map(k=>escape(k)+(plural&&k.length>=5&&/^\p{L}+$/u.test(k)?'s?':'')).join('|')+')'+right,'gu');}
const countryKW:Record<string,string>=Object.create(null);
for(const [iso,info]of Object.entries(ref.TIER1_COUNTRIES) as [string,Row][])for(const kw of [...info.keywords,info.name,iso])countryKW[kw.toLowerCase()]=iso;
function matches(text:string,pattern:RegExp):string[]{return [...text.matchAll(new RegExp(pattern.source,pattern.flags))].map(m=>m[0]);}
const cve=/CVE-\d{4}-\d{4,}/giu;
const apt= new RegExp(left+'(?:'+[...ref.APT_GROUPS].sort((a:string,b:string)=>b.length-a.length).map(escape).join('|')+')'+right,'giu');
export function extractEntities(text:string,now?:()=>Date){
 const lower=text.toLowerCase();const countries:Row[]=[],leaders:Row[]=[],organizations:Row[]=[],companies:Row[]=[];
 const seen=new Set<string>();for(const kw of matches(lower,words(Object.keys(countryKW),true))){const iso=countryKW[kw]??countryKW[kw.slice(0,-1)];if(iso&&!seen.has(iso)){seen.add(iso);const info=ref.TIER1_COUNTRIES[iso];countries.push({iso3:iso,name:info.name,baseline_risk:info.baseline_risk});}}
 const types:[string,Row[],string,(k:string,i:Row)=>Row][]=[['LEADERS',leaders,'name',(_k,i)=>({name:i.name,title:i.title,country:i.country})],['ORGANIZATIONS',organizations,'abbrev',(_k,i)=>({name:i.abbrev,type:i.type})],['COMPANIES',companies,'',(k,i)=>({name:k.replace(/\p{L}+/gu,w=>w[0].toUpperCase()+w.slice(1).toLowerCase()),ticker:i.ticker,sector:i.sector})]];
 for(const [table,out,key,format]of types){const found=new Set<string>();for(const kw of matches(lower,words(Object.keys(ref[table])))){const info=ref[table][kw],id=key?info[key]:kw;if(!found.has(id)){found.add(id);out.push(format(kw,info));}}}
 // Python set output order is process-random; TS keeps first-seen order.
 const entities={countries,leaders,organizations,companies,cves:[...new Set(matches(text,cve))],apt_groups:[...new Set(matches(text,apt).map(s=>s.toLowerCase()))]};
 const by_type=Object.fromEntries(Object.entries(entities).map(([k,v])=>[k,v.length]));return {entities,by_type,total_entities:Object.values(by_type).reduce((a,b)=>a+b,0),source:'regex-ner',timestamp:stamp(now)};
}
function pattern(kw:string):RegExp{
 if(kw==='apt')return new RegExp(left+'apt[0-9]*'+right,'u');if(kw==='dead')return new RegExp(left+'dead(?:ly)?'+right,'u');
 return new RegExp(left+escape(kw)+(ref._WORD_ONLY_KEYWORDS.includes(kw)?'s?'+right:'[\\p{L}\\p{N}_]*'),'u');
}
const hit=(keywords:string[],lower:string)=>keywords.filter(k=>lower.includes(k)&&pattern(k).test(lower));
export function classifyEvent(text:string,now?:()=>Date){
 const lower=text.toLowerCase();const found:Row[]=[];for(const [category,info]of Object.entries(ref.CATEGORIES) as [string,Row][]){const keywords=hit(info.keywords,lower);if(keywords.length)found.push({category,keywords,count:keywords.length,base:info.severity_base,confidence:Math.min(1,Math.round((keywords.length*.2+.3)*100)/100)});}
 found.sort((a,b)=>b.count-a.count);const high=hit(ref._HIGH_SEVERITY,lower),moderate=hit(ref._MODERATE_SEVERITY,lower),primary=found[0];
 return {primary_category:primary?.category??'unclassified',severity:primary?Math.min(10,primary.base+(high.length?2:moderate.length?1:0)):0,confidence:primary?.confidence??0,all_categories:found.map(m=>({category:m.category,confidence:m.confidence,keywords:m.keywords})),category_count:found.length,severity_modifiers:[...high,...moderate],source:'keyword-classifier',timestamp:stamp(now)};
}
const stopwords=new Set<string>(ref._STOPWORDS);
const tokenize=(text:string)=>new Set((text.toLowerCase().match(/[a-z]{3,}/g)??[]).filter(w=>!stopwords.has(w)));
export function jaccard(a:ReadonlySet<string>,b:ReadonlySet<string>):number{if(!a.size||!b.size)return 0;return [...a].filter(x=>b.has(x)).length/new Set([...a,...b]).size;}
export function clusterArticles(articles:Row[],threshold=.3,titleField='title'){
 const tokens=articles.map(a=>tokenize(a[titleField]||'')),assigned=new Set<number>(),clusters:{representative:Row;member_count:number;member_indices:number[]}[]=[];
 for(let i=0;i<articles.length;i++){if(assigned.has(i))continue;const members=[i];assigned.add(i);for(let j=i+1;j<articles.length;j++)if(!assigned.has(j)&&jaccard(tokens[i],tokens[j])>=threshold){members.push(j);assigned.add(j);}clusters.push({representative:articles[i],member_count:members.length,member_indices:members});}return clusters.sort((a,b)=>b.member_count-a.member_count);
}
export function newsClusters(feed:Row,threshold=.25,now?:()=>Date,outletFor=(name:string)=>ref.FEED_OUTLETS[name]??name){
 const items:Row[]=feed.items??[];const raw=clusterArticles(items,threshold);const clusters=raw.filter(c=>c.member_count>1).map(c=>{const members=c.member_indices.map(i=>({title:items[i].title??'',source:items[i].feed_name||items[i].source_name||items[i].source||'',link:items[i].link??''}));const freq=new Map<string,number>();for(const i of c.member_indices)for(const w of tokenize(items[i].title??''))freq.set(w,(freq.get(w)??0)+1);const outlets=[...new Set(members.filter(m=>m.source).map(m=>outletFor(m.source)))].sort();return {headline:c.representative.title??'',size:c.member_count,keywords:[...freq].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k])=>k),sources:[...new Set(members.map(m=>m.source).filter(Boolean))],outlets,outlet_count:outlets.length,items:members.slice(0,5)};});
 const result:Row={clusters,cluster_count:clusters.length,total_items:items.length,singleton_count:raw.filter(c=>c.member_count===1).length,threshold,source:'jaccard-clustering',timestamp:stamp(now)};
 for(const k of ['feeds_attempted','feeds_ok','feeds_failed','feeds_stale','error','degraded','reason'])if(k in feed)result[k]=feed[k];return result;
}
export interface BaselineStore{get(keyword:string):[number,number,number];set(keyword:string,n:number,mean:number,m2:number,updatedAt:string):void}
export class MemoryBaselineStore implements BaselineStore{private values=new Map<string,[number,number,number]>();get(k:string):[number,number,number]{return this.values.get(k)??[0,0,0];}set(k:string,n:number,m:number,m2:number){this.values.set(k,[n,m,m2]);}}
/** Persistent sqlite schema compatible with upstream kw_baselines. Caller owns path/authorization. */
export class SqliteBaselineStore implements BaselineStore{
 private db:DatabaseSync;constructor(path:string){const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);this.db.exec('CREATE TABLE IF NOT EXISTS kw_baselines (keyword TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, mean REAL NOT NULL DEFAULT 0.0, m2 REAL NOT NULL DEFAULT 0.0, updated_at TEXT NOT NULL)');}
 get(k:string):[number,number,number]{const row=this.db.prepare('SELECT count,mean,m2 FROM kw_baselines WHERE keyword=?').get(k);return row?[Number(row.count),Number(row.mean),Number(row.m2)]:[0,0,0];}
 set(k:string,n:number,m:number,m2:number,updated:string){this.db.prepare('INSERT INTO kw_baselines (keyword,count,mean,m2,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(keyword) DO UPDATE SET count=excluded.count, mean=excluded.mean, m2=excluded.m2, updated_at=excluded.updated_at').run(k,n,m,m2,updated);}
 close(){this.db.close();}
}
function round(n:number,d=2):number{const scale=10**d,scaled=n*scale;const lo=Math.floor(scaled),f=scaled-lo;return (f===.5?(lo%2?lo+1:lo):Math.round(scaled))/scale;}
export class KeywordSpikeDetector{
 constructor(readonly store:BaselineStore=new MemoryBaselineStore(),readonly now=()=>new Date()){}
 detect(counts:Record<string,number>,threshold=2):Row[]{const spikes:Row[]=[];for(const [keyword,current]of Object.entries(counts)){const [n,mean,m2]=this.store.get(keyword);if(n>=3){const sd=Math.sqrt(m2/n),ratio=current/Math.max(mean,.1);if(sd<.1){if(ratio>3)spikes.push({keyword,current_count:current,baseline_mean:round(mean),ratio:round(ratio),z_score:null,detection:'ratio'});}else{const z=(current-mean)/sd;if(z>=threshold)spikes.push({keyword,current_count:current,baseline_mean:round(mean),stddev:round(sd),z_score:round(z),ratio:round(ratio),detection:'z_score'});}}const nextMean=mean+(current-mean)/(n+1);this.store.set(keyword,n+1,nextMean,m2+(current-mean)*(current-nextMean),stamp(this.now));}return spikes.sort((a,b)=>(b.z_score||b.ratio||0)-(a.z_score||a.ratio||0));}
}
const spikeAPT=new RegExp(left+'(APT[0-9]{1,3}|Lazarus|Fancy Bear|Cozy Bear|Sandworm|Turla|Kimsuky|Volt Typhoon|Salt Typhoon|Midnight Blizzard|Scattered Spider|LockBit|BlackCat|ALPHV|CL0P|Black Basta|Charming Kitten)'+right,'giu');
export interface SynthesisDependencies{newsFeed:(args:{category?:string;limit:number})=>Promise<Row>;trendingKeywords:(args:{min_count:number})=>Promise<Row>;outletFor?:(name:string)=>string;detector?:KeywordSpikeDetector;now?:()=>Date}
export function createSynthesisHandlers(deps:SynthesisDependencies):DomainHandlers{
 const now=deps.now??(()=>new Date()),detector=deps.detector??new KeywordSpikeDetector(new MemoryBaselineStore(),now);
 return {
  intel_extract_entities:async a=>{if(a.text)return extractEntities(String(a.text),now);const feed=await deps.newsFeed({limit:100});const items:Row[]=feed.items??[];return {...extractEntities(items.map(i=>(i.title??'')+' '+(i.summary??'')).join(' '),now),input_source:'news_feed',items_analyzed:items.length};},
  intel_classify_event:a=>classifyEvent(String(a.text),now),
  intel_news_clusters:async a=>newsClusters(await deps.newsFeed({category:a.category as string|undefined,limit:Number(a.limit??100)}),Number(a.threshold??.25),now,deps.outletFor),
  intel_keyword_spikes:async a=>{const kw=await deps.trendingKeywords({min_count:Number(a.min_count??3)}),counts:Record<string,number>=Object.create(null);for(const item of kw.keywords??[])counts[item.keyword??item.word]=item.count;const threshold=Number(a.z_threshold??2),spikes=detector.detect(counts,threshold);const feed=await deps.newsFeed({limit:100}),text=(feed.items??[]).map((i:Row)=>(i.title??'')+' '+(i.summary??'')).join(' ');const cves=[...new Set(matches(text,cve))].sort(),apts=[...new Set(matches(text,spikeAPT).map(s=>s.toLowerCase()))].sort();return {spikes,spike_count:spikes.length,keywords_analyzed:Object.keys(counts).length,z_threshold:threshold,cve_mentions:cves,apt_mentions:apts,cve_count:cves.length,apt_count:apts.length,source:'keyword-spike-detector',timestamp:stamp(now)};}
 };
}
