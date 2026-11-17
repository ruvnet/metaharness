// SPDX-License-Identifier: MIT
// Native port of migration.py/displacement.py at fdebf9a8; Phoenix AGI. See THIRD_PARTY_NOTICES.md.
import {readFileSync} from 'node:fs';
import type {DomainHandlers} from '../domain-runtime.js';
import {pyRound} from './markets.js';
type Row=Record<string,any>;
export interface EconomicsOptions {fetch?:typeof globalThis.fetch;now?:()=>number;timeoutMs?:number;maxBytes?:number}
const tier:Record<string,Row>=JSON.parse(readFileSync(new URL('../../data/synthesis/reference.json',import.meta.url),'utf8')).TIER1_COUNTRIES;
export const UNHCR_MEASURE='UNHCR year-end stock: people from the origin present in the destination at the end of the year (refugees + asylum seekers + others in need of international protection). Year-over-year change = net arrivals minus returns, onward movement, naturalisation and deaths; not a crossing count.';
export const WB_MEASURE='World Bank SM.POP.NETM: immigrants minus emigrants over the year, citizens and non-citizens, all reasons (work, family, study, forced). Positive = net inflow. Source is the UN World Population Prospects: modelled values, and the most recent years can be WPP projections rather than observed counts.';
const nonCountry:Record<string,string>={UNK:'Unknown origin',XXA:'Stateless'};
const integer=(v:any):number=>{if(typeof v==='string'&&!/^[+-]?\d+$/.test(v.trim()))return 0;const n=Number(v);return Number.isFinite(n)?Math.trunc(n):0;};
const arr=(v:any):Row[]=>Array.isArray(v)?v.filter(x=>x&&typeof x==='object'&&!Array.isArray(x)):[];
const sum=(rows:Row[],key:string)=>rows.reduce((n,r)=>n+(r[key]??0),0);
const rank=(rows:Row[],key:string,limit:number,reverse=true)=>[...rows].sort((a,b)=>reverse?b[key]-a[key]:a[key]-b[key]).slice(0,Math.max(1,limit));
function bound(v:any,fallback:number,min:number,max:number){const n=v??fallback;if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`Expected integer in ${min}..${max}`);return n;}
export function validateMigrationUrl(url:URL):void {
 const allowed=url.hostname==='api.unhcr.org'&&/^\/population\/v1\/(countries|population)\/$/.test(url.pathname)||url.hostname==='api.worldbank.org'&&/^\/v2\/country(?:\/(?:all|[A-Z]{3})\/indicator\/(?:SP\.POP\.TOTL|SM\.POP\.TOTL|SM\.POP\.NETM))?$/.test(url.pathname);
 if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||!allowed||url.href.length>4096)throw new Error('Migration URL outside fixed allowlist');
}
/** Fixed endpoints, bounded cache/bytes/deadline, no redirects or inherited credentials. */
class MigrationTransport {
  readonly now: () => number; private readonly fetcher: typeof globalThis.fetch;
  private readonly cache = new Map<string, { data: any; at: number }>();
  private last = 0; private queue: Promise<void> = Promise.resolve();
  constructor(private options: EconomicsOptions) { this.now = options.now ?? Date.now; this.fetcher = options.fetch ?? globalThis.fetch; }
  stamp(): string { return new Date(this.now()).toISOString(); }
  async json(base: string, params: Record<string, any> = {}, ttl = 1800): Promise<any> {
    const url = new URL(base); for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    validateMigrationUrl(url);
    const sec = false;
    const key = url.href; const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < ttl * 1000) return structuredClone(cached.data);
    if (!this.options.fetch) {
      let release!: () => void; const gate = new Promise<void>(r => { release = r; }); const previous = this.queue; this.queue = previous.then(() => gate); await previous;
      const delay = Math.max(0, this.last + (sec ? 150 : 500) - Date.now()); if (delay) await new Promise(r => setTimeout(r, delay)); this.last = Date.now(); release();
    }
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Migration source timeout')); }, this.options.timeoutMs ?? 15_000); });
      const read = async () => {
        const response = await this.fetcher(url, { redirect: 'error', credentials: 'omit', signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'metaharness-world-intel/0.2.0' } });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Migration provider HTTP ${response.status}`); }
        const reader = response.body?.getReader(); if (!reader) throw new Error('Empty provider body');
        const abort = () => { void reader.cancel().catch(() => undefined); }; controller.signal.addEventListener('abort', abort, { once: true });
        const chunks: Uint8Array[] = []; let size = 0;
        try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > (this.options.maxBytes ?? 4_000_000)) { await reader.cancel(); throw new Error('Migration provider response too large'); } chunks.push(value); } if (controller.signal.aborted) throw new Error('Migration source timeout'); }
        finally { controller.signal.removeEventListener('abort', abort); reader.releaseLock(); }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      };
      const data = await Promise.race([read(), timeout]); if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!); this.cache.set(key, { data, at: this.now() }); return structuredClone(data);
    } finally { if (timer) clearTimeout(timer); }
  }
}type Selection={kind:'country'|'region';label:string;codes:Set<string>};
export function resolveMigrationPlace(query:string,countries:Record<string,Row>):Selection {
 if(typeof query!=='string'||query.length>200)throw new Error('Invalid place');const q=query.trim(),up=q.toUpperCase(),low=q.toLowerCase();if(!q)throw new Error('empty place');
 const result=(iso:string):Selection=>({kind:'country',label:countries[iso]!.name,codes:new Set([iso])});
 if(up.length===3&&countries[up])return result(up);
 if(up.length===2){const hits=Object.keys(countries).filter(i=>String(countries[i]!.iso2??'').toUpperCase()===up);if(hits.length===1)return result(hits[0]!);}
 for(const field of ['major_area','region']){const members=Object.keys(countries).filter(i=>String(countries[i]![field]??'').toLowerCase()===low);if(members.length)return{kind:'region',label:countries[members[0]!]![field],codes:new Set(members)};}
 const exact=Object.keys(countries).filter(i=>[countries[i]!.name,...countries[i]!.names??[]].some(n=>String(n).toLowerCase()===low));
 if(exact.length===1)return result(exact[0]!);
 const partial=exact.length?exact:Object.keys(countries).filter(i=>low.length>=4&&[countries[i]!.name,...countries[i]!.names??[]].some(n=>String(n).toLowerCase().includes(low)));
 if(partial.length===1)return result(partial[0]!);if(partial.length)throw new Error(`'${query}' is ambiguous: ${partial.map(i=>`${countries[i]!.name} (${i})`).sort().slice(0,8).join(', ')}`);
 throw new Error(`unknown country or region: '${query}'`);
}
function corridorTable(rows:Row[]):Map<string,Row>{const out=new Map<string,Row>();for(const r of rows){const o=String(r.coo_iso??'').toUpperCase(),d=String(r.coa_iso??'').toUpperCase();if(!o||!d||o==='-'||d==='-'||o===d)continue;const key=`${o}|${d}`,e=out.get(key)??{origin_iso3:o,destination_iso3:d,refugees:0,asylum_seekers:0,oip:0,origin_name:r.coo_name,destination_name:r.coa_name};for(const f of ['refugees','asylum_seekers','oip'])e[f]+=integer(r[f]);e.people=e.refugees+e.asylum_seekers+e.oip;out.set(key,e);}return out;}
function idps(rows:Row[]):Record<string,number>{const out:Record<string,number>={};for(const r of rows){const o=String(r.coo_iso??'').toUpperCase();if(o&&o===String(r.coa_iso??'').toUpperCase())out[o]=(out[o]??0)+integer(r.idps);}return out;}
export function createEconomicsHandlers(options:EconomicsOptions={}):DomainHandlers {
 const transport=new MigrationTransport(options),now=options.now??Date.now,yearNow=()=>new Date(now()).getUTCFullYear(),stamp=()=>new Date(now()).toISOString().replace(/\.\d{3}Z$/,'Z');
 const failure=(error:string,extra:Row={})=>({error,degraded:true,source:'unhcr',timestamp:stamp(),...extra});
 const invalid=(error:unknown,source='unhcr')=>({error:error instanceof Error?error.message:String(error),source,timestamp:stamp()});
 const year=(v:any)=>v==null?null:bound(v,yearNow()-1,1951,yearNow());
 const json=async(url:string,params:Row={},ttl=43200)=>{try{return await transport.json(url,params,ttl);}catch{return null;}};
 // Unlike upstream's silent truncation, incomplete pages fail closed instead of reporting partial totals as complete.
 const unhcr=async(endpoint:string,params:Row,ttl=43200):Promise<Row[]|null>=>{const all:Row[]=[];for(let page=1;page<=10;page++){const data=await json(`https://api.unhcr.org/population/v1/${endpoint}/`,{...params,page},ttl);if(!data||typeof data!=='object'||Array.isArray(data)||!Array.isArray(data.items))return null;all.push(...arr(data.items));if(page>=integer(data.maxPages))return all;}return null;};
 const countries=async():Promise<Record<string,Row>|null>=>{const items=await unhcr('countries',{limit:1000},604800);if(items===null)return null;const out:Record<string,Row>={};for(const c of items){const iso=String(c.iso??'').toUpperCase();if(iso.length!==3)continue;const names=new Set<string>(['name','nameShort','nameLong','nameOrigin','nameFormal'].map(k=>c[k]).filter(n=>typeof n==='string'&&n));const t=tier[iso];if(t){names.add(t.name);for(const k of t.keywords??[])names.add(k);}out[iso]={name:nonCountry[iso]??t?.name??String(c.name??iso).trim(),is_country:!Object.hasOwn(nonCountry,iso),iso2:c.iso2??null,region:c.region??null,major_area:c.majorArea??null,names:[...names].sort()};}return out;};
 const pairs=(y:number)=>unhcr('population',{yearFrom:y,yearTo:y,coo_all:'true',coa_all:'true',cf_type:'ISO',limit:10000});
 const latest=async(y:number|null):Promise<[number,Row[]]|null>=>{if(y!==null){const r=await pairs(y);return r===null?null:[y,r];}for(const candidate of [yearNow()-1,yearNow()-2]){const r=await pairs(candidate);if(r===null)return null;if(r.length)return[candidate,r];}return[yearNow()-2,[]];};
 const wbIndicator=async(indicator:string,country='all',date?:string):Promise<Row[]|null>=>{const all:Row[]=[];for(let page=1;page<=10;page++){const data=await json(`https://api.worldbank.org/v2/country/${country}/indicator/${indicator}`,{format:'json',per_page:1000,...(date?{date}:{mrnev:1}),page});if(!Array.isArray(data)||data.length<2||!data[0]||!Array.isArray(data[1]))return null;all.push(...arr(data[1]));if(page>=integer(data[0].pages))return all;}return null;};
 const wbCountries=async():Promise<Record<string,Row>|null>=>{const data=await json('https://api.worldbank.org/v2/country',{format:'json',per_page:1000},604800);if(!Array.isArray(data)||!Array.isArray(data[1]))return null;const out:Record<string,Row>={};for(const c of arr(data[1])){if(!/^[A-Z0-9]{3}$/.test(c.id??''))continue;const coord=(v:any)=>v!==''&&v!=null&&Number.isFinite(Number(v))?Number(v):null;out[c.id]={name:String(c.name??'').trim(),iso2:c.iso2Code??null,region:String(c.region?.value??'').trim(),region_id:c.region?.id??null,income:String(c.incomeLevel?.value??'').trim(),aggregate:c.region?.id==='NA',capital:String(c.capitalCity??'').trim()||null,latitude:coord(c.latitude),longitude:coord(c.longitude)};}return out;};
 const wbPlace=(query:string,wb:Record<string,Row>):Selection=>{const cc:Record<string,Row>={};for(const [iso,c]of Object.entries(wb))if(!c.aggregate)cc[iso]={name:c.name,iso2:c.iso2,region:c.region,names:[c.name,...tier[iso]?.keywords??[],...(tier[iso]?[tier[iso]!.name]:[])]};const region=Object.values(wb).find(c=>!c.aggregate&&c.region_id===query.trim().toUpperCase());return region?{kind:'region',label:region.region,codes:new Set(Object.keys(cc).filter(i=>cc[i]!.region===region.region))}:resolveMigrationPlace(query,cc);};
 const name=(iso:string,rowName:any,cc:Record<string,Row>)=>cc[iso]?.name??String(rowName||iso||'Unknown').trim();
 const named=(e:Row,cc:Record<string,Row>)=>({origin:name(e.origin_iso3,e.origin_name,cc),origin_iso3:e.origin_iso3,destination:name(e.destination_iso3,e.destination_name,cc),destination_iso3:e.destination_iso3});
 const handlers:DomainHandlers={
 intel_migration_flows:async (a:Row)=>{
  const y=year(a.year),limit=bound(a.limit,25,1,10000),min=bound(a.min_people,0,0,Number.MAX_SAFE_INTEGER),cc=await countries();if(cc===null)return failure('UNHCR country list unavailable',{reason:'unhcr_fetch_failed'});
  let os:Selection|null=null,ds:Selection|null=null;try{os=a.origin?resolveMigrationPlace(a.origin,cc):null;ds=a.destination?resolveMigrationPlace(a.destination,cc):null;}catch(e){return invalid(e);}
  const got=await latest(y);if(!got)return failure('UNHCR population API unavailable',{reason:'unhcr_fetch_failed'});const [chosen,rows]=got,prior=await pairs(chosen-1),cur=corridorTable(rows),prev=prior?.length?corridorTable(prior):null;const selected:Row[]=[];
  for(const [key,e]of cur){if(os&&!os.codes.has(e.origin_iso3)||ds&&!ds.codes.has(e.destination_iso3)||e.people<=0||e.people<min)continue;const p=prev?(prev.get(key)?.people??0):null;selected.push({...named(e,cc),people:e.people,refugees:e.refugees,asylum_seekers:e.asylum_seekers,other_in_need_of_protection:e.oip,prior_year_people:p,change:p===null?null:e.people-p});}selected.sort((a,b)=>b.people-a.people);
  const top=(key:string,isoKey:string)=>{const agg=new Map<string,Row>();for(const c of selected){const e=agg.get(c[isoKey])??{name:c[key],iso3:c[isoKey],people:0,corridors:0};e.people+=c.people;e.corridors++;agg.set(c[isoKey],e);}return rank([...agg.values()],'people',10);};
  return{year:chosen,origin_filter:os?{kind:os.kind,name:os.label}:null,destination_filter:ds?{kind:ds.kind,name:ds.label}:null,total_people:sum(selected,'people'),corridor_count:selected.length,corridors:selected.slice(0,limit),top_origins:top('origin','origin_iso3'),top_destinations:top('destination','destination_iso3'),prior_year_available:prev!==null,measure:UNHCR_MEASURE,source:'unhcr',timestamp:stamp()};
 },
 intel_migration_history:async (a:Row)=>{
  const role=a.role??'origin';if(!['origin','host'].includes(role))return invalid("role must be 'origin' or 'host'");const from=bound(a.year_from,1951,1951,yearNow()),to=bound(a.year_to,yearNow(),1951,yearNow());if(from>to)return invalid('year_from must not exceed year_to');
  const cc=await countries();if(cc===null)return failure('UNHCR country list unavailable',{reason:'unhcr_fetch_failed'});let sel:Selection;try{sel=resolveMigrationPlace(a.country,cc);}catch(e){return invalid(e);}if(sel.kind!=='country')return invalid(`'${a.country}' is a region; history needs one country`);const iso=[...sel.codes][0]!;
  const items=await unhcr('population',{[role==='origin'?'coo':'coa']:iso,cf_type:'ISO',yearFrom:from,yearTo:to,limit:1000});if(items===null)return failure('UNHCR population API unavailable',{reason:'unhcr_fetch_failed'});
  const years=new Map<number,Row>();for(const r of items){const y=integer(r.year);if(!y)continue;const e=years.get(y)??{year:y,refugees:0,asylum_seekers:0,other_in_need_of_protection:0,idps:0,returned_refugees:0};for(const f of ['refugees','asylum_seekers','idps','returned_refugees'])e[f]+=integer(r[f]);e.other_in_need_of_protection+=integer(r.oip);e.people=e.refugees+e.asylum_seekers+e.other_in_need_of_protection;years.set(y,e);}
  const series=[...years.values()].sort((a,b)=>a.year-b.year),waves:Row[]=[];for(let i=1;i<series.length;i++){const c=series[i]!,p=series[i-1]!,delta=c.people-p.people;if(c.year===p.year+1&&delta>0)waves.push({year:c.year,increase:delta,people:c.people,pct_change:p.people?pyRound(100*delta/p.people,1):null});}const peak=rank(series,'people',1)[0];
  return{country:sel.label,iso3:iso,role,meaning:role==='origin'?'people FROM this country living abroad (and IDPs inside it)':'people from other countries hosted IN this country',years:series.length,first_year:series[0]?.year??null,latest:series.at(-1)??null,peak:peak?{year:peak.year,people:peak.people}:null,largest_waves:rank(waves,'increase',5),series,measure:UNHCR_MEASURE,source:'unhcr',timestamp:stamp()};
 },
 intel_migration_surges:async (a:Row)=>{
  const y=year(a.year),min=bound(a.min_change,50000,0,Number.MAX_SAFE_INTEGER),limit=bound(a.limit,20,1,10000),cc=await countries();if(cc===null)return failure('UNHCR country list unavailable',{reason:'unhcr_fetch_failed'});const got=await latest(y);if(!got)return failure('UNHCR population API unavailable',{reason:'unhcr_fetch_failed'});const [chosen,rows]=got,prior=await pairs(chosen-1);if(!rows.length||!prior?.length)return failure(`UNHCR has no data for ${chosen} and ${chosen-1} to compare`,{reason:'no_comparison_year',year:chosen});
  const cur=corridorTable(rows),prev=corridorTable(prior),ic=idps(rows),ip=idps(prior),pops=await wbIndicator('SP.POP.TOTL'),population:Record<string,number>={};for(const p of pops??[])if(p.countryiso3code&&p.value!=null)population[p.countryiso3code]=integer(p.value);
  const corridors:Row[]=[];for(const key of new Set([...cur.keys(),...prev.keys()])){const n=cur.get(key)?.people??0,p=prev.get(key)?.people??0,delta=n-p;if(Math.abs(delta)<min)continue;const e=cur.get(key)??prev.get(key)!;corridors.push({...named(e,cc),people:n,prior_year_people:p,change:delta,pct_change:p?pyRound(100*delta/p,1):null});}
  const origins=new Map<string,Row>();for(const [table,field]of [[cur,'now'],[prev,'was']]as const)for(const e of table.values()){const o=e.origin_iso3,r=origins.get(o)??{origin_name:e.origin_name,now:0,was:0};r[field]+=e.people;origins.set(o,r);}for(const o of new Set([...Object.keys(ic),...Object.keys(ip)]))if(!origins.has(o))origins.set(o,{origin_name:null,now:0,was:0});
  const changes:Row[]=[],unattributed:Row[]=[];for(const[o,e]of origins){const delta=e.now-e.was,id=ic[o]??0,idelta=id-(ip[o]??0);if(Math.abs(delta)<min&&Math.abs(idelta)<min)continue;const p=population[o]??null,r={origin:name(o,e.origin_name,cc),origin_iso3:o,people_abroad:e.now,prior_year_people_abroad:e.was,change_abroad:delta,idps:id,change_idps:idelta,idps_first_reported:id>0&&(ip[o]??0)===0,population:p,change_abroad_pct_of_population:p?pyRound(100*delta/p,2):null,level:delta>=min?(delta>=500000||p&&delta>=.01*p?'mass':delta>=100000?'major':'notable'):null};(cc[o]?.is_country?changes:unattributed).push(r);}
  const attributed=corridors.filter(c=>cc[c.origin_iso3]?.is_country),ranked=(items:Row[],key:string,rising:boolean)=>rank(items.filter(i=>i[key]!==0&&(i[key]>0)===rising),key,limit,rising);
  return{year:chosen,compared_with:chosen-1,min_change:min,origin_outflow_increases:ranked(changes,'change_abroad',true),origin_outflow_decreases:ranked(changes,'change_abroad',false),internal_displacement_increases:rank(changes.filter(o=>o.change_idps>=min),'change_idps',limit),corridor_increases:ranked(attributed,'change',true),corridor_decreases:ranked(attributed,'change',false),unattributed_origin_changes:[...unattributed].sort((a,b)=>Math.abs(b.change_abroad)-Math.abs(a.change_abroad)),levels:{mass:'increase >= 500,000 people or >= 1% of the origin population',major:'increase >= 100,000 people',notable:`increase >= min_change (${min.toLocaleString('en-US')})`,basis:'heuristic thresholds of this tool, not a UNHCR classification'},population_source:Object.keys(population).length?'worldbank SP.POP.TOTL':null,measure:UNHCR_MEASURE,source:'unhcr',timestamp:stamp()};
 },
 intel_net_migration:async (a:Row)=>{
  const limit=bound(a.limit,20,1,10000),wb=await wbCountries();if(wb===null)return failure('World Bank country list unavailable',{source:'worldbank',reason:'worldbank_fetch_failed'});
  if(a.country){let sel:Selection;try{sel=wbPlace(a.country,wb);}catch(e){return invalid(e,'worldbank');}if(sel.kind!=='country')return invalid(`'${a.country}' is a region; pass it as region=`,'worldbank');const iso=[...sel.codes][0]!,span=`1960:${yearNow()}`,net=await wbIndicator('SM.POP.NETM',iso,span);if(net===null)return failure('World Bank API unavailable',{source:'worldbank',reason:'worldbank_fetch_failed'});
   const stock=await wbIndicator('SM.POP.TOTL',iso,span)??[],pop=await wbIndicator('SP.POP.TOTL',iso,span)??[],pb:Record<number,number>={};for(const r of pop)if(r.value!=null)pb[integer(r.date)]=integer(r.value);
   const series=net.filter(r=>r.value!=null).map(r=>{const y=integer(r.date),v=integer(r.value);return{year:y,net_migration:v,per_1000:pb[y]?pyRound(1000*v/pb[y]!,2):null};}).sort((a,b)=>a.year-b.year),stocks=stock.filter(r=>r.value!=null).map(r=>({year:integer(r.date),migrant_stock:integer(r.value)})).sort((a,b)=>a.year-b.year);
   return{country:sel.label,iso3:iso,region:wb[iso]!.region,latest:series.at(-1)??null,largest_net_inflow_years:rank(series.filter(e=>e.net_migration>0),'net_migration',5),largest_net_outflow_years:rank(series.filter(e=>e.net_migration<0),'net_migration',5,false),migrant_stock:stocks,series,measure:WB_MEASURE,source:'worldbank',timestamp:stamp()};
  }
  let sel:Selection|null=null;if(a.region){try{sel=wbPlace(a.region,wb);}catch(e){return invalid(e,'worldbank');}if(sel.kind!=='region')return invalid(`'${a.region}' is a country; pass it as country=`,'worldbank');}
  const net=await wbIndicator('SM.POP.NETM');if(net===null)return failure('World Bank API unavailable',{source:'worldbank',reason:'worldbank_fetch_failed'});const pop:Record<string,number>={},stock:Record<string,number>={};for(const r of await wbIndicator('SP.POP.TOTL')??[])if(r.value!=null)pop[r.countryiso3code]=integer(r.value);for(const r of await wbIndicator('SM.POP.TOTL')??[])if(r.value!=null)stock[r.countryiso3code]=integer(r.value);
  const rows:Row[]=[],aggregates:Row[]=[];for(const r of net){const iso=r.countryiso3code??'',meta=wb[iso];if(!meta||r.value==null)continue;const value=integer(r.value),entry:Row={name:meta.name,iso3:iso,year:integer(r.date),net_migration:value,per_1000:pop[iso]?pyRound(1000*value/pop[iso]!,2):null,migrant_stock:stock[iso]??null,migrant_stock_pct:stock[iso]&&pop[iso]?pyRound(100*stock[iso]!/pop[iso]!,1):null};if(meta.aggregate)aggregates.push(entry);else if(!sel||sel.codes.has(iso))rows.push({...entry,region:meta.region});}
  const rates=(key:string,rising:boolean)=>rank(rows.filter(r=>r[key]!=null&&(rising?r[key]>0:r[key]<0)),key,limit,rising);
  return{region_filter:sel?.label??null,countries:rows.length,net_total:sum(rows,'net_migration'),top_net_immigration:rates('net_migration',true),top_net_emigration:rates('net_migration',false),highest_rate_immigration:rates('per_1000',true),highest_rate_emigration:rates('per_1000',false),world_regions:a.region?[]:rank(aggregates.filter(r=>['WLD','EAS','ECS','LCN','MEA','NAC','SAS','SSF'].includes(r.iso3)),'net_migration',aggregates.length),measure:WB_MEASURE,source:'worldbank',timestamp:stamp()};
 },
 intel_displacement_summary:async (a:Row)=>{
  const y=year(a.year)??yearNow()-1,data=await json('https://api.unhcr.org/population/v1/population/',{limit:1000,yearFrom:y,yearTo:y,coo_all:'true',cf_type:'ISO'});
  const by=new Map<string,Row>();for(const r of arr(data?.items)){const code=String(r.coo_iso??'').toUpperCase(),iso=code.length===3?code:null,country=(iso?tier[iso]?.name:null)??String(r.coo_name||'Unknown').trim(),key=iso??country,e=by.get(key)??{country,iso3:iso,refugees:0,asylum_seekers:0,internally_displaced:0,stateless:0,others_of_concern:0};for(const[from,to]of [['refugees','refugees'],['asylum_seekers','asylum_seekers'],['idps','internally_displaced'],['stateless','stateless'],['ooc','others_of_concern']]as const)e[to]+=integer(r[from]);e.total_displaced=e.refugees+e.asylum_seekers+e.internally_displaced+e.stateless+e.others_of_concern;by.set(key,e);}
  const rows=[...by.values()],base={by_origin:rank(rows,'total_displaced',30),global_totals:{total_refugees:sum(rows,'refugees'),total_asylum_seekers:sum(rows,'asylum_seekers'),total_idps:sum(rows,'internally_displaced'),total_stateless:sum(rows,'stateless'),total_ooc:sum(rows,'others_of_concern'),grand_total:sum(rows,'total_displaced')},year:y,count:Math.min(rows.length,30),source:'unhcr',timestamp:stamp()};
  return !data||!Array.isArray(data.items)?{...base,error:'UNHCR API unavailable (no live or cached data)',degraded:true,reason:'unhcr_fetch_failed'}:base;
 }
 };
 return handlers;
}
