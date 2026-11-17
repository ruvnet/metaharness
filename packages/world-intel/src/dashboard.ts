// SPDX-License-Identifier: MIT
// Native HTTP/SSE adapter of Phoenix AGI World Intel dashboard/app.py, pinned fdebf9a8.
// Construction performs no network listening or provider calls. All capabilities are explicit.
import {readFileSync} from 'node:fs';
import {withExecutionPolicy} from './execution-policy.js';
import {situationBrief} from './domains/situation.js';
import type {DomainHandlers} from './domain-runtime.js';
type Obj=Record<string,any>;
const read=(p:string)=>JSON.parse(readFileSync(new URL('../data/'+p,import.meta.url),'utf8'));
const surface=read('dashboard/surface.json');
export const DASHBOARD_ROUTES:readonly {path:string;handler:string;methods:string[]}[]=surface.routes;
export const DASHBOARD_SOURCES:readonly string[]=surface.streamSources;
const countries=read('synthesis/reference.json').TIER1_COUNTRIES;
const SLOW=new Set(['news_feed','trending_keywords','alert_digest','weekly_trends','strategic_posture']);
const CORS={'Access-Control-Allow-Origin':'*'};
const SSE_HEADERS={...CORS,'Content-Type':'text/event-stream','Cache-Control':'no-cache','X-Accel-Buffering':'no'};
export type DashboardSource=(signal:AbortSignal)=>Promise<unknown>|unknown;
export interface DashboardOptions{
 handlers:DomainHandlers;
 sources?:Record<string,DashboardSource>;
 health?:()=>{breakers?:unknown;cache?:unknown;freshness?:unknown};
 now?:()=>number;
 sourceTimeoutMs?:number;
 slowTimeoutMs?:number;
 researchTimeoutMs?:number;
 streamIntervalMs?:number;
 aoiStore?:{list():Obj[];getSnapshot(name:string):Obj|null};
 countryCoordinates?:()=>Promise<Record<string,Obj>|null>;
 situationBrief?:(overview:Obj,signal:AbortSignal)=>Promise<Obj>;
 vector?:{collectionStats():unknown;domainSummary(hours:number):unknown;trendDetection(category:undefined,recent:number,baseline:number):unknown;semanticSearch(query:string,limit:number,domain:undefined,category?:string,hours?:number):Promise<unknown>};
 collectionHealth?:(source:string|null)=>Promise<Obj>|Obj;
 historyPath?:string;
 html?:string;
}
const stamp=(now:()=>number)=>new Date(now()).toISOString().replace(/\.000Z$/,'+00:00').replace(/Z$/,'+00:00');
const errorText=(e:unknown)=>e instanceof Error?e.message:String(e);
const typedError=(e:unknown,n:number)=>`${e instanceof Error?e.name:'Error'}: ${errorText(e).slice(0,n)}`;
function json(data:unknown,status=200,headers:Record<string,string>={}){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json',...headers}});}
class BudgetExpired extends Error {}
async function budget<T>(work:(signal:AbortSignal)=>Promise<T>|T,ms:number,signal?:AbortSignal):Promise<T>{
 if(!Number.isFinite(ms)||ms<=0||ms>600000)throw new Error('Invalid dashboard deadline');
 const ctrl=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 let abort!:()=>void;
 const interrupted=new Promise<never>((_,reject)=>{abort=()=>{ctrl.abort();reject(new DOMException('Aborted','AbortError'));};if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});
 try{return await Promise.race([Promise.resolve().then(()=>{if(ctrl.signal.aborted)throw new DOMException('Aborted','AbortError');return work(ctrl.signal);}),interrupted,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{ctrl.abort();reject(new BudgetExpired());},ms);})]);}
 finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
function sleep(ms:number,signal:AbortSignal):Promise<void>{
 if(signal.aborted)return Promise.reject(new DOMException('Aborted','AbortError'));
 return new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(t);reject(new DOMException('Aborted','AbortError'));},t=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});});
}
const title=(s:string)=>s.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
export function dashboardConflictFallback(acled:Obj|null,ucdp:Obj|null,now=Date.now):Obj|null{
 if([acled,ucdp].some(r=>r&&!r.error&&(r.count??0)>0))return null;
 const labels:Record<number,string>={1:'low',2:'low',3:'moderate',4:'high',5:'critical'};
 const events=Object.entries(surface.reference.INTEL_HOTSPOTS).map(([name,v])=>{const h=v as Obj,assoc:string[]=h.associated_countries??[],actors=assoc.map(c=>countries[c]?.name??c),esc=h.baseline_escalation,severity=labels[esc]??'unknown';return {latitude:h.lat,longitude:h.lon,country:countries[assoc[0]]?.name||title(name),location:title(name),event_type:'Active Hotspot',type_of_violence_label:'active hotspot',fatalities:0,best:0,escalation:esc,severity,event_date:new Date(now()).toISOString().slice(0,10),actor1:actors[0]??'—',actor2:actors[1]??'—',source:'Intel Hotspot Database',notes:`Escalation level ${esc}/5 (${severity}). Monitored hotspot involving ${actors.join(', ')}.`,associated_countries:assoc};});
 return {events,count:events.length,source:'intel-hotspots'};
}
export function dashboardStatic():Obj{
 const out:Obj={};for(const [name,key]of Object.entries({military_bases:'bases',strategic_ports:'ports',pipelines:'pipelines',nuclear_facilities:'facilities',trade_routes:'routes',cloud_regions:'regions',financial_centers:'centers'})){
 const rows=read('geospatial/'+name+'.json');out[name]={[key]:rows,count:rows.length};}
 const waterways=surface.reference.STRATEGIC_WATERWAYS,corridors=Object.entries(surface.reference.CABLE_CORRIDORS).map(([name,v])=>{const c=v as Obj;return {name,lat_range:c.lat_range,lon_range:c.lon_range,cables:c.cables};});
 out.waterways={waterways,count:waterways.length};out.cable_corridors={corridors,count:corridors.length};return out;
}
const ALIASES:Record<string,string>={domestic_flights:'intel_aviation_domestic',displacement:'intel_displacement_summary',ai_watch:'intel_ai_releases'};
export function dashboardSources(handlers:DomainHandlers):Record<string,DashboardSource>{
 return Object.fromEntries(DASHBOARD_SOURCES.map(name=>[name,async()=>{const handler=handlers[ALIASES[name]??'intel_'+name];if(!handler)throw new Error(`Dashboard source not configured: ${name}`);return withExecutionPolicy(false,async()=>handler({}));}]));
}
function queryNumber(p:URLSearchParams,name:string,fallback:number,integer:boolean,low:number,high:number):number{
 const raw=p.get(name);if(raw===null)return fallback;
 if(raw.trim()===''||integer&&!/^[+-]?\d+$/.test(raw.trim())||!integer&&!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()))throw new Error(`${name} must be a number between ${low} and ${high}, got '${raw}'`);
 const n=Number(raw);if(!Number.isFinite(n)||n<low||n>high)throw new Error(`${name} must be between ${low} and ${high}, got '${raw}'`);return n;
}
function choice(p:URLSearchParams,name:string,choices:string[]):string{const v=p.get(name)??choices[0];if(!choices.includes(v))throw new Error(`${name} must be one of ${choices.join(', ')}, got '${v}'`);return v;}
export function dashboardResearchArgs(path:string,p:URLSearchParams):Obj{
 if(path==='/api/liquidity-board')return {sort:choice(p,'sort',['biggest_move','newest'])};
 if(path==='/api/situations')return {hours:queryNumber(p,'hours',24,false,1,168),sort:choice(p,'sort',['covered','hostile','change']),kind:choice(p,'kind',['all','between','inside']),limit:queryNumber(p,'limit',20,true,1,100),min_articles:queryNumber(p,'min_articles',2,true,1,1000)};
 return {hours:queryNumber(p,'hours',24,false,1,168),min_outlets:queryNumber(p,'min_outlets',3,true,1,50),limit:queryNumber(p,'limit',10,true,1,50),attention_limit:queryNumber(p,'attention_limit',10,true,1,50)};
}
export function placeDashboardCorridors(corridors:Obj[],wb:Record<string,Obj>):[Obj[],Obj[]]{
 const point=(iso:string)=>{const c=wb[iso];return !c||c.aggregate||c.latitude==null||c.longitude==null?null:{lat:c.latitude,lon:c.longitude,capital:c.capital??null};};
 const plotted:Obj[]=[],unplotted:Obj[]=[];for(const c of corridors){const o=point(c.origin_iso3),d=point(c.destination_iso3);if(o&&d)plotted.push({...c,origin_point:o,destination_point:d});else unplotted.push({origin:c.origin,origin_iso3:c.origin_iso3,destination:c.destination,destination_iso3:c.destination_iso3,people:c.people,no_coordinates:[...(!o?['origin']:[]),...(!d?['destination']:[])]});}return [plotted,unplotted];
}
export function createDashboard(options:DashboardOptions){
 const now=options.now??Date.now,sources=options.sources??dashboardSources(options.handlers);
 const metadata=()=>{const h=options.health?.()??{};return {source_health:h.breakers??{},cache_stats:h.cache??{},cache_freshness:h.freshness??{},timestamp:stamp(now)};};
 const call=async(name:string,args:Obj)=>{const fn=options.handlers[name];if(!fn)throw new Error(`Handler not configured: ${name}`);return await withExecutionPolicy(false,async()=>fn(args)) as Obj;};
 const fetchSource=async(name:string,signal:AbortSignal)=>{const ms=SLOW.has(name)?options.slowTimeoutMs??90000:options.sourceTimeoutMs??45000;try{return await budget(sources[name],ms,signal);}catch(e){if(signal.aborted)throw e;return e instanceof BudgetExpired?{error:`timeout after ${Number.isInteger(ms/1000)?(ms/1000).toFixed(1):ms/1000}s`,_timeout:true}:{error:typedError(e,120)};}};
 async function overview(signal:AbortSignal):Promise<Obj>{
  const entries=await Promise.all(Object.keys(sources).map(async name=>[name,await fetchSource(name,signal)] as const)),result:Obj=Object.fromEntries(entries),zones=dashboardConflictFallback(result.acled_events,result.ucdp_events,now);
  if(zones!==null)result.conflict_zones=zones;Object.assign(result,dashboardStatic());
  try{result.situation_brief=await budget(s=>options.situationBrief?options.situationBrief(result,s):situationBrief(result,{now:()=>new Date(now())}),35000,signal);}catch(e){result.situation_brief={error:errorText(e)};}
  return {...result,...metadata()};
 }
 async function* streamTick(signal:AbortSignal):AsyncGenerator<Obj>{
  const pending=new Map<number,Promise<{id:number;name:string;data:unknown}>>();Object.keys(sources).forEach((name,id)=>pending.set(id,fetchSource(name,signal).then(data=>({id,name,data}),e=>({id,name,data:{error:errorText(e)}}))));
  const total=pending.size;let done=0;const conflict:Obj={};
  while(pending.size&&!signal.aborted){const r=await Promise.race(pending.values());pending.delete(r.id);done++;yield {_progressive:true,_done:done,_total:total,[r.name]:r.data};if(['acled_events','ucdp_events'].includes(r.name)){conflict[r.name]=r.data;if(Object.keys(conflict).length===2)yield {_progressive:true,_done:done,_total:total,conflict_zones:dashboardConflictFallback(conflict.acled_events,conflict.ucdp_events,now)};}}
  if(!signal.aborted)yield {_progressive:false,_complete:true,...metadata()};
 }
 async function vectorAnalytics(signal?:AbortSignal):Promise<Obj>{
  if(!options.vector)return {available:false,error:'Vector store not available (Qdrant not running)',timestamp:stamp(now)};
  const v=options.vector,ms=options.sourceTimeoutMs??45000,results=await Promise.allSettled([budget(()=>v.collectionStats(),ms,signal),budget(()=>v.domainSummary(24),ms,signal),budget(()=>v.trendDetection(undefined,6,48),ms,signal)]);if(signal?.aborted)throw new DOMException('Aborted','AbortError');
  return {available:true,...Object.fromEntries(results.map((r,i)=>[['stats','domain_summary','trends'][i],r.status==='fulfilled'?r.value:{error:errorText(r.reason)}])),timestamp:stamp(now)};
 }
 function stream(request:Request,vector=false):Response{
  const ctrl=new AbortController(),abort=()=>ctrl.abort();request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)ctrl.abort();
  async function* cycles(){try{while(!ctrl.signal.aborted){try{if(vector)yield await vectorAnalytics(ctrl.signal);else yield* streamTick(ctrl.signal);}catch(e){if(ctrl.signal.aborted)return;yield {error:errorText(e)};}await sleep(options.streamIntervalMs??30000,ctrl.signal);}}finally{ctrl.abort();request.signal.removeEventListener('abort',abort);}}
  const iterator=cycles(),encoder=new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({async pull(c){try{const r=await iterator.next();if(r.done)c.close();else c.enqueue(encoder.encode('data: '+JSON.stringify(r.value)+'\n\n'));}catch(e){if(ctrl.signal.aborted)c.close();else c.error(e);}},async cancel(){ctrl.abort();await iterator.return(undefined);}}),{headers:SSE_HEADERS});
 }
 async function migration(p:URLSearchParams):Promise<Response>{
  const raw=p.get('limit')??'40',yearRaw=p.get('year');if(!/^[+-]?\d+$/.test(raw.trim())||yearRaw&&!/^[+-]?\d+$/.test(yearRaw.trim()))return json({error:'limit and year must be integers'},400,CORS);
  const limit=Number(raw),year=yearRaw?Number(yearRaw):null;if(limit<1||limit>150)return json({error:'limit must be between 1 and 150'},400,CORS);
  try{const [flows,surges,wb]=await Promise.all([call('intel_migration_flows',{year,limit}),call('intel_migration_surges',{year,limit:15}),options.countryCoordinates?.()??null]);
   if('error'in flows)return json({...flows,corridors:[],rising:[]},503,CORS);if(wb===null)return json({error:'World Bank country coordinates unavailable',source:'worldbank',corridors:[],rising:[]},503,CORS);
   const [plotted,unplotted]=placeDashboardCorridors(flows.corridors,wb),payload:Obj={year:flows.year,limit,corridors:plotted,plotted:plotted.length,unplotted:unplotted.length,unplotted_corridors:unplotted,corridor_count:flows.corridor_count,prior_year_available:flows.prior_year_available,anchor:'capital city (World Bank country list); a corridor is drawn capital to capital, not along a route',measure:flows.measure,source:'unhcr+worldbank',timestamp:flows.timestamp};
   if('error'in surges)Object.assign(payload,{rising:[],rising_unplotted:0,rising_error:surges.error});else{const [r,u]=placeDashboardCorridors(surges.corridor_increases,wb);Object.assign(payload,{rising:r,rising_unplotted:u.length,compared_with:surges.compared_with});}return json(payload,200,CORS);
  }catch(e){return json({error:'Migration fetch failed: '+errorText(e),corridors:[],rising:[]},503,CORS);}
 }
 async function dispatch(request:Request):Promise<Response>{
  const url=new URL(request.url),path=url.pathname,method=request.method.toUpperCase(),route=DASHBOARD_ROUTES.find(r=>r.path===path&&r.methods.includes(method==='HEAD'?'GET':method));
  if(!route)return json({error:DASHBOARD_ROUTES.some(r=>r.path===path)?'Method not allowed':'Not found'},DASHBOARD_ROUTES.some(r=>r.path===path)?405:404);
  if(path==='/')return new Response(options.html??readFileSync(new URL('../data/dashboard/index.html',import.meta.url),'utf8'),{headers:{'Content-Type':'text/html; charset=utf-8'}});
  if(path==='/api/health')return json({status:'ok'});
  if(path==='/api/report/pdf')return json({error:'PDF reports removed — use the live dashboard at /'},410);
  if(path==='/api/static')return json(dashboardStatic(),200,CORS);
  if(path==='/api/stream'||path==='/sse/vector-analytics')return stream(request,path.startsWith('/sse/'));
  if(path==='/api/overview')return json(await overview(request.signal),200,CORS);
  if(path==='/api/migration'){try{return await budget(()=>migration(url.searchParams),options.researchTimeoutMs??90000,request.signal)}catch(e){return json({error:request.signal.aborted?'Request cancelled':'Migration deadline exceeded'},request.signal.aborted?499:504)}}
  if(path==='/api/aois'){try{if(!options.aoiStore)throw new Error('AOI store not configured');const aois=options.aoiStore.list().map(row=>{const snap=options.aoiStore!.getSnapshot(row.name),counts=snap?Object.fromEntries(Object.entries(snap.domains??{}).map(([d,items])=>[d,Object.keys(items??{}).length])):null;return {...row,last_sweep:snap?{taken_at:snap.taken_at,counts,total:Object.values(counts!).reduce((a,b)=>a+b,0)}:null};});return json({aois,count:aois.length,source:'aoi-store'},200,CORS);}catch(e){return json({error:'AOI store unavailable: '+errorText(e),aois:[],count:0},503,CORS);}}
  if(path==='/api/collection-health'){try{const data=await budget(()=>options.collectionHealth?options.collectionHealth(url.searchParams.get('source')||null):call('intel_collection_health',{source:url.searchParams.get('source')||null}),options.sourceTimeoutMs??45000,request.signal);return json(data,'error'in data?404:200);}catch(e){return json({error:'history store unavailable: '+typedError(e,1000),db_path:options.historyPath??null},503);}}
  if(path==='/api/vector-search'){
   if(method==='OPTIONS')return json({},200,{...CORS,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
   if(!options.vector)return json({error:'Vector store not available (Qdrant not running)'},503,CORS);
   let body:Obj;try{const raw=await request.text();if(raw.length>64000)return json({error:'Request body exceeds 64 KB'},413,CORS);body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw Error();}catch{return json({error:'Invalid JSON body'},400,CORS);}
   const query=typeof body.query==='string'?body.query.trim():'';if(!query)return json({error:"Missing 'query' parameter"},400,CORS);
   const limit=Math.min(Math.trunc(Number(body.limit??20)),50),hours=body.hours?Number(body.hours):undefined;
   if(!Number.isFinite(limit)||limit<1||hours!==undefined&&(!Number.isFinite(hours)||hours<0))return json({error:'Invalid vector search bounds'},400,CORS);
   try{return json(await budget(()=>options.vector!.semanticSearch(query,limit,undefined,body.category,hours),options.researchTimeoutMs??90000,request.signal),200,CORS);}catch(e){return json({error:errorText(e)},500,CORS);}
  }
  const name=path==='/api/liquidity-board'?'liquidity board':path==='/api/situations'?'situations':'top stories',tool=path==='/api/liquidity-board'?'intel_liquidity_board':path==='/api/situations'?'intel_situations':'intel_top_stories';let args:Obj;
  try{args=dashboardResearchArgs(path,url.searchParams);}catch(e){return json({error:errorText(e)},400);}
  let data:Obj,status:number;try{data=await budget(()=>call(tool,args),options.researchTimeoutMs??90000,request.signal);status=data.error?503:200;}catch(e){data=e instanceof BudgetExpired?{error:`${name} timed out after ${(options.researchTimeoutMs??90000)/1000} s`,timeout:true}:{error:`${name} failed: ${typedError(e,200)}`};status=e instanceof BudgetExpired?504:503;}
  if(path==='/api/liquidity-board'&&data.net_liquidity_method===undefined)data.net_liquidity_method=structuredClone(surface.reference.NET_LIQUIDITY_METHOD);return json(data,status);
 }
 async function handle(request:Request):Promise<Response>{const r=await dispatch(request);if(request.method==='HEAD'){await r.body?.cancel();return new Response(null,{status:r.status,headers:r.headers});}return r;}
 return {handle,overview,streamTick,vectorAnalytics};
}
