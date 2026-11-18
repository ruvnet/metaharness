// SPDX-License-Identifier: MIT
// Port of marc-shade/world-intel-mcp cyber.py and public conflict/military lookups.
// Upstream pinned source attribution is retained in THIRD_PARTY_NOTICES.md.
import type {DomainHandlers} from '../domain-runtime.js';
export interface SecurityTransport {json(url:URL,ttlSeconds?:number):Promise<unknown>}
const feeds=[['feodo-tracker','https://feodotracker.abuse.ch/downloads/ipblocklist_recommended.json',1800],['cisa-kev','https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',3600],['sans-dshield','https://isc.sans.edu/api/topips/records/20?json',1800],['urlhaus','https://urlhaus-api.abuse.ch/v1/urls/recent/limit/25/',900]] as const;
export function createSecurityTransport(fetcher:typeof fetch=fetch):SecurityTransport {
 const cache=new Map<string,{until:number;data:unknown}>();
 return {async json(url,ttl=300){
  const feed=feeds.some(([,href])=>url.href===href);
  const other=(url.hostname==='data.humdata.org'&&url.pathname==='/api/3/action/package_search')||(url.hostname==='hexdb.io'&&/^\/api\/v1\/aircraft\/[a-fA-F0-9]{6}$/.test(url.pathname));
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||(!feed&&!other))throw new Error('Unapproved security source URL');
  const old=cache.get(url.href);if(old&&old.until>Date.now())return old.data;
  const response=await fetcher(url,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(20000),headers:{Accept:'application/json','User-Agent':'metaharness-world-intel/0.2.0'}});
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  const reader=response.body?.getReader();if(!reader)throw new Error('Empty response');let size=0;const chunks:Uint8Array[]=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8_000_000){await reader.cancel();throw new Error('Response exceeds 8 MB');}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(cache.size>=200)cache.delete(cache.keys().next().value!);cache.set(url.href,{data,until:Date.now()+ttl*1000});return data;
 }};
}
type Row=Record<string,any>;
const row=(v:unknown):Row=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
const array=(v:unknown):Row[]=>Array.isArray(v)?v.map(row):[];
const val=(r:Row,k:string,d:unknown=null)=>r[k]===undefined?d:r[k];
const selected=(r:Row,keys:string[])=>Object.fromEntries(keys.map(k=>[k,val(r,k)]));
export function normalizeCyberFeed(source:string,data:unknown,now:Date):Row[]{
 if(source==='feodo-tracker')return array(data).map(e=>({type:'c2_ip',indicator:val(e,'ip_address',''),threat:val(e,'malware','unknown'),severity:String(e.status??'').toLowerCase()==='online'?'critical':'medium',source_feed:source,first_seen:val(e,'first_seen',''),details:selected(e,['port','status','hostname','as_number','as_name','country','last_online'])}));
 if(source==='cisa-kev'){
  const cutoff=new Date(now.getTime()-30*86400000).toISOString().slice(0,10);
  return array(row(data).vulnerabilities).filter(e=>String(e.dateAdded??'')>=cutoff).map(e=>({type:'vulnerability',indicator:val(e,'cveID',''),threat:`${val(e,'vendorProject','')} ${val(e,'product','')}: ${val(e,'vulnerabilityName','')}`,severity:String(e.knownRansomwareCampaignUse??'').toLowerCase()==='known'?'critical':'high',source_feed:source,first_seen:val(e,'dateAdded',''),details:{vendor:val(e,'vendorProject',''),product:val(e,'product',''),vulnerability_name:val(e,'vulnerabilityName',''),due_date:val(e,'dueDate'),ransomware_use:val(e,'knownRansomwareCampaignUse'),required_action:val(e,'requiredAction'),notes:val(e,'notes')}}));
 }
 if(source==='sans-dshield')return array(data).filter(e=>e.ip).map(e=>({type:'attack_ip',indicator:e.ip,threat:`DShield top attacker (${val(e,'attacks',0)} attacks)`,severity:'high',source_feed:source,first_seen:val(e,'firstseen',''),details:{count:val(e,'count'),attacks:val(e,'attacks'),first_seen:val(e,'firstseen'),last_seen:val(e,'lastseen'),as_name:val(e,'asname'),as_country:val(e,'ascountry')}}));
 if(source==='urlhaus')return array(row(data).urls).map(e=>({type:'malware_url',indicator:val(e,'url',''),threat:val(e,'threat','unknown'),severity:String(e.url_status??'').toLowerCase()==='online'?'high':'low',source_feed:source,first_seen:val(e,'dateadded',''),details:selected(e,['url_status','tags','reporter'])}));
 return [];
}
const timestamp=(date:Date)=>date.toISOString().replace(/\.000Z$/,'+00:00').replace(/Z$/,'+00:00');
export function createSecurityHandlers(options:{transport?:SecurityTransport;now?:()=>Date}={}):DomainHandlers{
 const transport=options.transport??createSecurityTransport(),now=options.now??(()=>new Date());
 const lookup=async(icao24:unknown)=>{
  if(typeof icao24!=='string'||! /^[a-fA-F0-9]{6}$/.test(icao24))return {error:'invalid_icao24',aircraft:{},source:'hexdb',timestamp:timestamp(now())};
  try{const data=await transport.json(new URL(`https://hexdb.io/api/v1/aircraft/${icao24}`),3600);return {aircraft:row(data),source:'hexdb',timestamp:timestamp(now())};}
  catch(e){return {aircraft:{},source:'hexdb',timestamp:timestamp(now()),degraded:true,error:e instanceof Error?e.message:String(e)};}
 };
 return {
  intel_cyber_threats:async args=>{
   const limit=args.limit===undefined?50:args.limit;if(typeof limit!=='number'||!Number.isSafeInteger(limit)||limit<0||limit>10000)throw new Error('limit must be an integer between 0 and 10000');
   const date=now(),failures:string[]=[];
   const values=await Promise.all(feeds.map(async([source,url,ttl])=>{try{return await transport.json(new URL(url),ttl);}catch{failures.push(source);return null;}}));
   const all=feeds.flatMap(([source],i)=>normalizeCyberFeed(source,values[i],date));
   all.sort((a,b)=>a.first_seen===b.first_seen?0:String(a.first_seen)>String(b.first_seen)?-1:1);
   const severity:Record<string,number>={critical:0,high:1,medium:2,low:3};all.sort((a,b)=>severity[a.severity]!-severity[b.severity]!);
   const threats=all.slice(0,limit),by_type:Record<string,number>={},by_severity:Record<string,number>={};for(const t of threats){by_type[t.type]=(by_type[t.type]??0)+1;by_severity[t.severity]=(by_severity[t.severity]??0)+1;}
   return {threats,count:threats.length,feeds_successful:values.filter(v=>v!==null&&v!==undefined).length,feeds_attempted:4,by_type,by_severity,source:'cyber-feeds',timestamp:timestamp(date),...(failures.length?{degraded:true,data_gaps:failures.map(s=>`${s}: feed fetch failed`)}:{})};
  },
  intel_humanitarian_summary:async args=>{
   const date=now(),url=new URL('https://data.humdata.org/api/3/action/package_search');url.search=new URLSearchParams({q:'crisis',rows:'20',sort:'metadata_modified desc',...(args.country?{fq:`groups:${String(args.country).toLowerCase()}`}:{})}).toString();
   try{const data=row(await transport.json(url,21600));const datasets=array(row(data.result).results).map(d=>{const notes=String(d.notes??'');return {name:val(d,'name'),title:val(d,'title'),organization:val(row(d.organization),'title'),metadata_modified:val(d,'metadata_modified'),num_resources:val(d,'num_resources'),notes:notes.length>200?notes.slice(0,200)+'...':notes};});return {datasets,count:datasets.length,source:'hdx',timestamp:date.toISOString().replace(/\.\d{3}Z$/,'Z')};}
   catch(e){return {datasets:[],count:0,source:'hdx',timestamp:date.toISOString().replace(/\.\d{3}Z$/,'Z'),degraded:true,error:e instanceof Error?e.message:String(e)};}
  },
  intel_aircraft_details:args=>lookup(args.icao24),
  intel_aircraft_batch:async args=>{
   if(!Array.isArray(args.icao24_list))throw new Error('icao24_list must be an array');const list=args.icao24_list.slice(0,20);
   const results=await Promise.all(list.map(async icao=>{const result=await lookup(icao);return Object.keys(result.aircraft).length?{...result.aircraft,icao24:icao}:null;}));const aircraft=results.filter(x=>x!==null);return {aircraft,count:aircraft.length,requested:list.length,source:'hexdb',timestamp:timestamp(now())};
  },
 };
}
