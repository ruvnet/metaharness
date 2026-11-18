import {type SourceRuntime, type SourceRule} from '../source-runtime.js';
import { attachForecasts, createForecastTransport, type ForecastTransport } from './cyclone-forecasts.js';
import { XMLParser } from 'fast-xml-parser';
/** Native TypeScript ports of upstream seismology/weather/environmental/launches/space_weather (MIT). */
type Obj = Record<string, any>;
type Args = Record<string, unknown>;
export type HazardTransport = ((url: URL, ttlSeconds: number, format?: 'json' | 'text') => Promise<unknown>) & { fetchedAt?: (url: URL) => number | undefined };
const ORIGINS = new Set(['https://earthquake.usgs.gov','https://api.weather.gov','https://eonet.gsfc.nasa.gov','https://www.gdacs.org','https://ll.thespacedevs.com','https://services.swpc.noaa.gov','https://archive-api.open-meteo.com','https://www.nhc.noaa.gov','https://volcano.si.edu','https://feeds.meteoalarm.org','https://www.metoc.navy.mil','https://firms.modaps.eosdis.nasa.gov']);
export function createHazardTransport(fetchFn: typeof fetch = fetch, sourceRuntime?: SourceRuntime): HazardTransport {
  const stamps=new Map<string,number>();
  const cache=new Map<string,{time:number;value:unknown}>();
  const transport: HazardTransport = async (url,ttl,format='json') => {
    if(!ORIGINS.has(url.origin)||url.username||url.password||url.hash||url.href.length>4096) throw new Error('Unapproved hazard origin');
    if(sourceRuntime){const o={source:hazardSource(url),cacheTtl:ttl,maxBytes:4_000_000,timeoutSeconds:15,followRedirects:false,headers:{'User-Agent':'metaharness-world-intel','Accept':'application/json, application/geo+json'}};const data=await (format==='text'?sourceRuntime.getText(url,o):sourceRuntime.getJson(url,o));if(data===null)throw Error('Hazard provider unavailable');const meta=sourceRuntime.cache.getStaleMeta(sourceRuntime.cacheIdentity(url,o,format));if(meta){if(stamps.size>=128)stamps.delete(stamps.keys().next().value!);stamps.set(url.href,meta[1]*1000);}return data;}
    const key=format+url.href, old=cache.get(key); if(old && Date.now()-old.time<ttl*1000) return structuredClone(old.value);
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();void reader?.cancel().catch(()=>{});reject(Error('Hazard request timed out'));},15000);});
    let value:unknown;
    try{value=await Promise.race([deadline,(async()=>{
      const r=await fetchFn(url,{signal:controller.signal,credentials:'omit',redirect:'error',headers:{'User-Agent':'metaharness-world-intel (https://github.com/ruvnet/metaharness)','Accept':'application/json, application/geo+json'}});
      if(!r.ok){await r.body?.cancel();throw new Error(`Hazard HTTP ${r.status}`);}
      if(Number(r.headers.get('content-length')??0)>4_000_000){await r.body?.cancel();throw new Error('Hazard response too large');}
      if(!r.body)throw new Error('Empty hazard response');reader=r.body.getReader();const parts:Uint8Array[]=[];let size=0;
      try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>4_000_000)throw new Error('Hazard response too large');parts.push(value);}}finally{await reader.cancel();}
      if(controller.signal.aborted)throw Error('Hazard request timed out');const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
      const decoded=new TextDecoder().decode(bytes);return format==='text'?decoded:JSON.parse(decoded);
    })()]);}finally{if(timer)clearTimeout(timer);}
    if(cache.size>=128)cache.delete(cache.keys().next().value!);cache.set(key,{time:Date.now(),value});return structuredClone(value);
  };
  transport.fetchedAt = url => sourceRuntime?stamps.get(url.href):cache.get('json'+url.href)?.time;
  return transport;
}
const CLIMATE_ZONES: Record<string,{lat:number;lon:number;name:string}> = {"arctic": {"lat": 80.0, "lon": 0.0, "name": "Arctic (Svalbard)"}, "subarctic_siberia": {"lat": 65.0, "lon": 100.0, "name": "Subarctic Siberia"}, "northern_europe": {"lat": 55.0, "lon": 15.0, "name": "Northern Europe"}, "mediterranean": {"lat": 38.0, "lon": 20.0, "name": "Mediterranean Basin"}, "sahel": {"lat": 14.0, "lon": 0.0, "name": "Sahel Region"}, "middle_east": {"lat": 30.0, "lon": 45.0, "name": "Middle East"}, "south_asia": {"lat": 25.0, "lon": 78.0, "name": "South Asia (India)"}, "east_asia": {"lat": 35.0, "lon": 116.0, "name": "East Asia (Beijing)"}, "southeast_asia": {"lat": 2.0, "lon": 105.0, "name": "Southeast Asia"}, "australia": {"lat": -25.0, "lon": 135.0, "name": "Central Australia"}, "amazon": {"lat": -3.0, "lon": -60.0, "name": "Amazon Basin"}, "us_midwest": {"lat": 40.0, "lon": -90.0, "name": "US Midwest"}, "us_southwest": {"lat": 33.0, "lon": -112.0, "name": "US Southwest"}, "antarctica": {"lat": -75.0, "lon": 0.0, "name": "Antarctica"}, "pacific_enso": {"lat": 0.0, "lon": -150.0, "name": "Pacific ENSO Region"}};
const METEO_COUNTRIES: string[] = ["andorra", "austria", "belgium", "bosnia-herzegovina", "bulgaria", "croatia", "cyprus", "czechia", "denmark", "estonia", "finland", "france", "germany", "greece", "hungary", "iceland", "ireland", "israel", "italy", "latvia", "lithuania", "luxembourg", "malta", "moldova", "montenegro", "netherlands", "norway", "poland", "portugal", "republic-of-north-macedonia", "romania", "serbia", "slovakia", "slovenia", "spain", "sweden", "switzerland", "ukraine", "united-kingdom"];
const METEO_ALIASES: Record<string,string> = {"uk": "united-kingdom", "great-britain": "united-kingdom", "czech-republic": "czechia", "bosnia": "bosnia-herzegovina", "bosnia-and-herzegovina": "bosnia-herzegovina", "macedonia": "republic-of-north-macedonia", "north-macedonia": "republic-of-north-macedonia"};
const arr=(v:unknown):Obj[]=>v==null?[]:Array.isArray(v)?v:[v as Obj];
const xmltext=(v:any):string=>typeof v==='string'?v:v?.['#text']??v?.['@_href']??'';
const plain=(v:string)=>v.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/\s+/g,' ').trim();
const FIRE_REGIONS: Record<string,string> = {"north_america": "-170,15,-50,75", "south_america": "-85,-60,-30,15", "europe": "-25,35,45,72", "africa": "-20,-37,55,38", "middle_east": "25,10,65,45", "south_asia": "60,5,100,40", "east_asia": "95,15,150,55", "southeast_asia": "90,-15,155,25", "oceania": "105,-50,180,-5"};
const obj=(v:unknown):Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Obj:{};
const list=(v:unknown):any[]=>Array.isArray(v)?v:[];
const iso=(d:Date)=>d.toISOString().replace(/\.\d{3}Z$/,'Z');
const nullable=(v:unknown)=>v??null;
const num=(v:unknown)=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const integer=(a:Args,key:string,fallback:number,max=1000)=>{const v=a[key]??fallback;if(typeof v!=='number'||!Number.isInteger(v)||v<1||v>max)throw new RangeError(`Invalid ${key}`);return v;};
const text=(a:Args,key:string)=>{const v=a[key];if(v==null)return undefined;if(typeof v!=='string'||v.length>200)throw new TypeError(`Invalid ${key}`);return v;};
function point(g:Obj):[number|null,number|null]{
  const c=list(g.coordinates);let ring:any[]=g.type==='Polygon'?list(c[0]):g.type==='MultiPolygon'?list(list(c[0])[0]):[];
  if(ring.length>1&&JSON.stringify(ring[0])===JSON.stringify(ring.at(-1)))ring=ring.slice(0,-1);
  if(!ring.length||ring.some(p=>!Array.isArray(p)||p.length<2||typeof p[0]!=='number'||typeof p[1]!=='number'))return [null,null];
  return [Number((ring.reduce((s,p)=>s+p[1],0)/ring.length).toFixed(4)),Number((ring.reduce((s,p)=>s+p[0],0)/ring.length).toFixed(4))];
}
export function createHazardHandlers(options:{sourceRuntime?:SourceRuntime;transport?:HazardTransport;now?:()=>Date;firmsApiKey?:string;forecastTransport?:ForecastTransport}={}) {
  const transport=options.transport??createHazardTransport(fetch,options.sourceRuntime),now=options.now??(()=>new Date()),forecastTransport=options.forecastTransport??createForecastTransport();
  const freshness=new WeakMap<object,number>();
  async function get(base:string,params:Record<string,unknown>={},ttl=300):Promise<unknown>{const url=new URL(base);for(const[k,v]of Object.entries(params))if(v!==undefined&&v!==null&&v!=='')url.searchParams.set(k,String(v));const data=await transport(url,ttl);if(data&&typeof data==='object')freshness.set(data,transport.fetchedAt?.(url)??+now());return data;}
  async function xml(url:string,ttl:number):Promise<Obj>{const raw=await transport(new URL(url),ttl,'text');if(typeof raw!=='string'||raw.length>4_000_000||/<!DOCTYPE|<!ENTITY/i.test(raw))throw Error('Unsafe XML');const parsed=new XMLParser({ignoreAttributes:false,parseTagValue:false,processEntities:true}).parse(raw);const feed=parsed?.rss?.channel??parsed?.feed;if(!feed)throw Error('Unrecognized feed');return feed;}
  const failure=(source:string,key:string,reason:string,message:string,extra:Obj={})=>({error:message,degraded:true,reason,[key]:[],count:0,...extra,source,timestamp:iso(now())});
  return {
    intel_earthquakes:async(a:Args={})=>{
      const magnitude=a.min_magnitude??4.5;if(typeof magnitude!=='number'||!Number.isFinite(magnitude)||magnitude< -2||magnitude>10)throw new RangeError('Invalid min_magnitude');
      const hours=integer(a,'hours',24,8760),limit=integer(a,'limit',50);const date=now(),query={min_magnitude:magnitude,hours};
      let data:Obj;try{data=obj(await get('https://earthquake.usgs.gov/fdsnws/event/1/query',{format:'geojson',minmagnitude:magnitude,orderby:'time',limit,starttime:iso(new Date(+date-hours*3600000)).slice(0,-1)}));if(!Array.isArray(data.features))throw new Error('Malformed features');}catch{return failure('usgs','earthquakes','usgs_fetch_failed','USGS earthquake fetch failed (API error, timeout, or malformed response)',{query});}
      const earthquakes=data.features.map((f:Obj)=>{const p=obj(f.properties),c=list(obj(f.geometry).coordinates);return {id:nullable(f.id),magnitude:nullable(p.mag),place:nullable(p.place),time:p.time==null?null:iso(new Date(p.time)),depth_km:nullable(c[2]),latitude:nullable(c[1]),longitude:nullable(c[0]),tsunami_alert:nullable(p.tsunami),felt_reports:nullable(p.felt),alert_level:nullable(p.alert),url:nullable(p.url)};});
      return {earthquakes,count:earthquakes.length,query,source:'usgs',timestamp:iso(date),fetched_at:iso(new Date(freshness.get(data)??+now())),...(data._stale?{_stale:true,_stale_age_seconds:data._stale_age_seconds}:{})};
    },
    intel_weather_alerts:async(a:Args={})=>{
      const limit=integer(a,'limit',50),area=text(a,'area')?.trim().toUpperCase(),sv=text(a,'severity')?.trim().toLowerCase(),severity=sv?sv[0]!.toUpperCase()+sv.slice(1):undefined,query={area:area??null,severity:severity??null};
      let data:Obj;try{data=obj(await get('https://api.weather.gov/alerts/active',{area,severity}));if(!Array.isArray(data.features))throw new Error('Malformed features');}catch{return failure('nws','alerts','nws_fetch_failed','NWS alerts API unavailable (no live or cached data)',{by_severity:{},coverage:'US',query});}
      const by_severity:Record<string,number>={};const alerts=data.features.slice(0,limit).map((f:Obj)=>{const p=obj(f.properties),[latitude,longitude]=point(obj(f.geometry)),s=p.severity||'Unknown';by_severity[s]=(by_severity[s]??0)+1;return {id:nullable(f.id),event:nullable(p.event),severity:s,urgency:nullable(p.urgency),certainty:nullable(p.certainty),headline:nullable(p.headline),area:nullable(p.areaDesc),effective:nullable(p.effective),expires:nullable(p.expires),onset:nullable(p.onset),ends:nullable(p.ends),sender:nullable(p.senderName),latitude,longitude};});
      return {alerts,count:alerts.length,by_severity,coverage:'US',query,source:'nws',timestamp:iso(now())};
    },
    intel_environmental_events:async(a:Args={})=>{
      const days=integer(a,'days',30,3660),limit=integer(a,'limit',50),category=text(a,'category');let data:Obj;
      try{data=obj(await get('https://eonet.gsfc.nasa.gov/api/v3/events',{days,limit:Math.min(limit,100),status:'open',category},600));if(!Array.isArray(data.events))throw new Error('Malformed events');}catch{return failure('eonet','events','eonet_fetch_failed','NASA EONET unavailable');}
      const events=data.events.slice(0,limit).map((e:Obj)=>{const geometries=list(e.geometry),g=obj(geometries.at(-1)),c=list(g.coordinates);return {id:nullable(e.id),title:nullable(e.title),categories:list(e.categories).map(c=>c.title??''),lat:c.length>=2?c[1]:null,lon:c.length>=2?c[0]:null,date:nullable(g.date),sources:list(e.sources).map(s=>s.url??null),closed:nullable(e.closed)};});return {events,count:events.length,source:'eonet',timestamp:now().toISOString().replace('Z','+00:00')};
    },
    intel_disaster_alerts:async(a:Args={})=>{
      const limit=integer(a,'limit',30),alert_level=text(a,'alert_level'),event_type=text(a,'event_type');let data:Obj;
      try{data=obj(await get('https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH',{fromDate:new Date(+now()-30*86400000).toISOString().slice(0,10),toDate:now().toISOString().slice(0,10),alertlevel:alert_level,eventType:event_type},600));if(!Array.isArray(data.features))throw new Error('Malformed features');}catch{return failure('gdacs','alerts','gdacs_fetch_failed','GDACS unavailable');}
      const alerts=data.features.slice(0,limit).map((f:Obj)=>{const p=obj(f.properties),c=list(obj(f.geometry).coordinates);return {event_id:nullable(p.eventid),event_type:nullable(p.eventtype),name:p.name||p.eventname||null,alert_level:nullable(p.alertlevel),alert_score:nullable(p.alertscore),severity:typeof p.severity==='object'?nullable(obj(p.severity).severity_value):nullable(p.severity),country:nullable(p.country),lat:c.length>=2?c[1]:null,lon:c.length>=2?c[0]:null,from_date:nullable(p.fromdate),to_date:nullable(p.todate),url:nullable(obj(p.url).report),population_affected:nullable(obj(p.population).value)};});return {alerts,count:alerts.length,source:'gdacs',timestamp:now().toISOString().replace('Z','+00:00')};
    },
    intel_launch_schedule:async(a:Args={})=>{
      const limit=integer(a,'limit',20,100);let data:Obj;try{data=obj(await get('https://ll.thespacedevs.com/2.2.0/launch/upcoming/',{limit},3600));if(!Array.isArray(data.results))throw new Error('Malformed results');}catch{return failure('launch-library','launches','launch_library_fetch_failed','Launch Library 2 API unavailable (no live or cached data)');}
      const launches=data.results.slice(0,limit).map((r:Obj)=>{const s=obj(r.status),p=obj(r.launch_service_provider),c=obj(obj(r.rocket).configuration),pad=obj(r.pad),loc=obj(pad.location),m=obj(r.mission);return {id:nullable(r.id),name:nullable(r.name),provider:nullable(p.name),provider_type:nullable(p.type),vehicle:c.full_name||c.name||null,pad:nullable(pad.name),pad_location:nullable(loc.name),country_code:nullable(loc.country_code),latitude:num(pad.latitude),longitude:num(pad.longitude),net:nullable(r.net),window_start:nullable(r.window_start),window_end:nullable(r.window_end),status:nullable(s.name),status_abbrev:nullable(s.abbrev),mission:nullable(m.name),mission_type:nullable(m.type),orbit:nullable(obj(m.orbit).abbrev),mission_description:typeof m.description==='string'?m.description.slice(0,500):null};});return {launches,count:launches.length,source:'launch-library',timestamp:iso(now())};
    },
    intel_climate_anomalies:async(a:Args={})=>{
      const zones=a.zones;if(zones!=null&&(!Array.isArray(zones)||zones.length>100||zones.some(z=>typeof z!=='string')))throw new TypeError('Invalid zones');
      const targets=Object.entries(CLIMATE_ZONES).filter(([k])=>zones==null||(zones as string[]).includes(k));const stamp=()=>now().toISOString().replace('Z','+00:00');
      if(!targets.length)return {error:`No valid zone keys in ${JSON.stringify(zones)}; valid keys: ${JSON.stringify(Object.keys(CLIMATE_ZONES).sort())}`,zones:{},significant_anomalies:[],source:'open-meteo',timestamp:stamp()};
      const output:Obj={},missing:string[]=[],significant:string[]=[];const day=(n:number)=>new Date(+now()-n*86400000).toISOString().slice(0,10);const rnd=(n:number,d=2)=>Number(n.toFixed(d));
      for(const [key,zone]of targets){try{
        const common={latitude:zone.lat,longitude:zone.lon,daily:'temperature_2m_max,temperature_2m_min,precipitation_sum',timezone:'UTC'};
        const [cur,base]=await Promise.all([get('https://archive-api.open-meteo.com/v1/archive',{...common,start_date:day(7),end_date:day(1)},1800),get('https://archive-api.open-meteo.com/v1/archive',{...common,start_date:day(372),end_date:day(366)},1800)]);
        if(!obj(cur).daily||!obj(base).daily)throw Error('Missing daily');
        const average=(d:Obj)=>{const max=list(d.temperature_2m_max),min=list(d.temperature_2m_min),temps=max.flatMap((v,i)=>v!=null&&min[i]!=null?[(v+min[i])/2]:[]);return temps.length?temps.reduce((s,v)=>s+v,0)/temps.length:0;};
        const sum=(d:Obj)=>list(d.precipitation_sum).reduce((s,v)=>s+(v??0),0);const c=obj(obj(cur).daily),b=obj(obj(base).daily),ct=average(c),bt=average(b),cp=rnd(sum(c)),bp=rnd(sum(b)),temp=rnd(ct-bt),precip=rnd((cp-bp)/Math.max(bp,.1)*100,1),is_significant=Math.abs(temp)>3||Math.abs(precip)>100;
        output[key]={...zone,current_avg_temp_c:rnd(ct),baseline_avg_temp_c:rnd(bt),temp_anomaly_c:temp,current_precip_mm:cp,baseline_precip_mm:bp,precip_anomaly_pct:precip,is_significant};if(is_significant)significant.push(key);
      }catch{missing.push(key);}}
      const response:Obj={zones:output,significant_anomalies:significant,source:'open-meteo',timestamp:stamp()};if(missing.length){missing.sort();Object.assign(response,{unavailable_zones:missing,degraded:true});if(!Object.keys(output).length)Object.assign(response,{error:'Open-Meteo unavailable for all requested zones: '+missing.join(', '),reason:'open_meteo_fetch_failed'});}return response;
    },
    intel_cyclones:async(a:Args={})=>{
      let data:Obj;try{data=obj(await get('https://www.nhc.noaa.gov/CurrentStorms.json',{},600));if(!Array.isArray(data.activeStorms))throw Error('Malformed activeStorms');}catch{return failure('nhc','storms','nhc_fetch_failed','NHC CurrentStorms feed unavailable (no live or cached data)',{by_basin:{}});}
      const basins:Record<string,string>={al:'atlantic',ep:'eastern_pacific',cp:'central_pacific'},classes:Record<string,string>={TD:'Tropical Depression',TS:'Tropical Storm',HU:'Hurricane',MH:'Major Hurricane',SD:'Subtropical Depression',SS:'Subtropical Storm',PTC:'Potential Tropical Cyclone',PC:'Post-tropical Cyclone',STD:'Subtropical Depression',STS:'Subtropical Storm'},by_basin:Record<string,number>={};
      const int=(v:unknown)=>{const n=num(v);return n===null?null:typeof v==='string'&&!/^[+-]?\d+$/.test(v.trim())?null:Math.trunc(n);};
      const storms=data.activeStorms.map((s:Obj)=>{const id=s.id||'',prefix=id.slice(0,2).toLowerCase(),basin=basins[prefix]||prefix||null;if(basin)by_basin[basin]=(by_basin[basin]??0)+1;return {id:id||null,name:nullable(s.name),basin,classification:nullable(s.classification),classification_name:classes[s.classification]??s.classification??null,intensity_kt:int(s.intensity),pressure_mb:int(s.pressure),latitude:nullable(s.latitudeNumeric),longitude:nullable(s.longitudeNumeric),movement_dir_deg:nullable(s.movementDir),movement_speed_kt:nullable(s.movementSpeed),last_update:nullable(s.lastUpdate),advisory_url:nullable(obj(s.publicAdvisory).url)};});
      const response:Obj={storms,count:storms.length,by_basin,source:'nhc',timestamp:iso(now())};if(data._stale)Object.assign(response,{_stale:true,_stale_age_seconds:data._stale_age_seconds});if(a.include_forecast===true)Object.assign(response,await attachForecasts('NHC',storms,data.activeStorms,forecastTransport,now()));return response;
    },
    intel_volcano_activity:async(_a:Args={})=>{
      let feed:Obj;try{feed=await xml('https://volcano.si.edu/news/WeeklyVolcanoRSS.xml',3600);}catch{return failure('gvp','volcanoes','gvp_fetch_failed','GVP weekly volcano feed unavailable (no live or cached data)');}
      let new_activity_count=0,continuing_activity_count=0;const volcanoes=arr(feed.item).map((e:Obj)=>{const title=String(e.title??''),parts=title.split(' - ');let name=title,country=null,week=null,status=null;if(parts.length>=2&&parts[1]!.startsWith('Report for ')){week=parts[1]!.slice(11);status=parts[2]??null;const m=parts[0]!.match(/^(.*?)\s+\(([^)]*)\)$/);name=m?m[1]!:parts[0]!;country=m?m[2]!:null;}if(status?.toLowerCase().includes('new'))new_activity_count++;else if(status?.toLowerCase().includes('continuing'))continuing_activity_count++;const p=String(e['georss:point']??'').trim().split(/\s+/).map(Number);return {name,country,latitude:p.length>=2&&p.every(Number.isFinite)?p[0]:null,longitude:p.length>=2&&p.every(Number.isFinite)?p[1]:null,activity_status:status,summary:plain(String(e.description??'')).slice(0,500),report_week:week,published:e.pubDate??null,link:xmltext(e.guid)||xmltext(e.link)||null};});
      return {volcanoes,count:volcanoes.length,new_activity_count,continuing_activity_count,report_published:feed.pubDate??null,source:'gvp',timestamp:iso(now())};
    },
    intel_meteoalarm_alerts:async(a:Args={})=>{
      const country=text(a,'country'),limit=integer(a,'limit',50),countries=METEO_COUNTRIES;
      if(country===undefined)return {note:'Meteoalarm publishes per-country feeds only (no Europe-wide feed exists). Pass country=<name> to fetch warnings.',available_countries:countries,alerts:[],count:0,country:null,source:'meteoalarm',timestamp:iso(now())};
      const normalized=country.trim().toLowerCase().replace(/[\s_]+/g,'-'),slug=METEO_ALIASES[normalized]??normalized;if(!countries.includes(slug))return {error:`Unknown Meteoalarm country: '${country}'`,reason:'unknown_country',available_countries:countries,alerts:[],count:0,country,source:'meteoalarm',timestamp:iso(now())};
      let feed:Obj;try{feed=await xml('https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-'+slug,600);}catch{return failure('meteoalarm','alerts','meteoalarm_fetch_failed',`Meteoalarm feed for ${slug} unavailable (no live or cached data)`,{country:slug});}
      const entries=arr(feed.entry),by_severity:Record<string,number>={},by_color:Record<string,number>={},alerts:Obj[]=[];
      for(const e of entries){const title=xmltext(e.title),color=title.match(/^(Green|Yellow|Orange|Red)\b/i)?.[1]?.toLowerCase()??null,sv=e['cap:severity']??null;if(sv)by_severity[sv]=(by_severity[sv]??0)+1;if(color)by_color[color]=(by_color[color]??0)+1;if(alerts.length>=limit)continue;alerts.push({event:e['cap:event']??null,severity:sv,awareness_color:color,area:e['cap:areaDesc']??e['cap:areadesc']??null,onset:e['cap:onset']??null,expires:e['cap:expires']??null,certainty:e['cap:certainty']??null,urgency:e['cap:urgency']??null,status:e['cap:status']??null,message_type:e['cap:message_type']??null,identifier:e['cap:identifier']??null,title,published:e.published??null,link:xmltext(arr(e.link).find((l:Obj)=>!l['@_rel']||l['@_rel']==='alternate')??e.link)||null});}
      return {alerts,count:alerts.length,total_entries:entries.length,by_severity,by_color,country:slug,feed_updated:feed.updated??null,source:'meteoalarm',timestamp:iso(now())};
    },
    intel_jtwc_cyclones:async(a:Args={})=>{
      let feed:Obj;try{feed=await xml('https://www.metoc.navy.mil/jtwc/rss/jtwc.rss',600);}catch{return failure('jtwc','storms','jtwc_fetch_failed','JTWC RSS feed unavailable (no live or cached data)',{by_basin:{},advisories:[]});}
      const basins:Record<string,string>={'NWPAC-NIO-WARNINGS':'northwest_pacific_north_indian','EPAC-CPAC-WARNINGS':'central_eastern_pacific','SH-WARNINGS':'southern_hemisphere'},storms:Obj[]=[],by_basin:Record<string,number>={};let advisories:Obj[]=[];
      for(const e of arr(feed.item)){const guid=xmltext(e.guid),desc=String(e.description??'');if(guid==='TROPICAL-ADVISORIES'){advisories=[...desc.matchAll(/<a\s+href=['"]([^'"]+\.txt)['"][^>]*>([^<]+)<\/a>/g)].map(m=>({title:m[2]!.trim().replace(/\s+/g,' '),url:m[1]}));continue;}
        const basin=basins[guid]??String(e.category||guid||'unknown').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');const matches=[...desc.matchAll(/((?:Super\s+)?(?:Tropical\s+(?:Depression|Storm|Cyclone)|Typhoon|Hurricane|Subtropical\s+(?:Depression|Storm)))\s+(\d{2}[A-Z])\s+\(([^)]+)\)\s+Warning\s+#?(\d+)/g)];by_basin[basin]=matches.length;
        for(let i=0;i<matches.length;i++){const m=matches[i]!,segment=desc.slice(m.index!+m[0].length,matches[i+1]?.index??desc.length);storms.push({id:m[2],name:m[3]!.trim(),classification:m[1]!.replace(/\s+/g,' '),warning_number:Number(m[4]),issued_at:segment.match(/(?:Re)?issued at\s+(\d{2}\/\d{4}Z)/i)?.[1]??null,basin,warning_text_url:segment.match(/href=['"]([^'"]*web\.txt)['"]/)?.[1]??null,warning_graphic_url:segment.match(/href=['"]([^'"]*\.gif)['"]/)?.[1]??null});}
      }
      const response:Obj={storms,count:storms.length,by_basin,advisories,feed_published:feed.pubDate??null,source:'jtwc',timestamp:iso(now())};if(a.include_forecast===true)Object.assign(response,await attachForecasts('JTWC',storms,storms,forecastTransport,now()));return response;
    },
    intel_wildfires:async(a:Args={})=>{
      const key=options.firmsApiKey;if(!key)return {error:'NASA_FIRMS_API_KEY not configured'};if(!/^[a-zA-Z0-9_-]{8,200}$/.test(key))throw Error('Invalid FIRMS key');
      const region=text(a,'region');if(region!==undefined&&!FIRE_REGIONS[region])return {error:`Unknown region '${region}'. Valid: ${Object.keys(FIRE_REGIONS).join(', ')}`};
      const targets=region?[region]:Object.keys(FIRE_REGIONS),fires_by_region:Obj={},failed:string[]=[];let total_fires=0;
      const even=(n:number)=>{const f=Math.floor(n);return n-f===.5?f+f%2:Math.round(n);};
      for(const name of targets){try{const raw=await transport(new URL(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/${FIRE_REGIONS[name]}/2`),1800,'text');if(typeof raw!=='string')throw Error('Missing CSV');const lines=raw.trim().split('\n'),header=lines.shift()!.split(',').map(h=>h.trim().toLowerCase()),idx=Object.fromEntries(header.map((h,i)=>[h,i]));const fires:Obj[]=[];
        if(['latitude','longitude','confidence'].every(k=>idx[k]!==undefined))for(const line of lines){const fields=line.split(','),field=(k:string)=>idx[k]===undefined?undefined:fields[idx[k]!];const confidence=field('confidence')?.trim().toLowerCase();if(confidence==null||confidence==='low'||confidence==='l')continue;const lat=num(field('latitude')),lon=num(field('longitude')),bright=idx.bright_ti4===undefined?0:num(field('bright_ti4')),frp=field('frp')?.trim()?num(field('frp')):0;if(lat===null||lon===null||bright===null||frp===null)continue;fires.push({latitude:lat,longitude:lon,frp});}
        const cells=new Map<string,Obj>();for(const f of fires){const lat=even(f.latitude*2)/2,lon=even(f.longitude*2)/2,k=lat+','+lon;let c=cells.get(k);if(!c){c={lat,lon,fire_count:0,max_frp:f.frp};cells.set(k,c);}c.fire_count++;c.max_frp=Math.max(c.max_frp,f.frp);}
        const clusters=[...cells.values()].sort((a,b)=>b.fire_count-a.fire_count);fires_by_region[name]={count:fires.length,top_clusters:clusters.slice(0,20),cluster_count:clusters.length};total_fires+=fires.length;
      }catch{failed.push(name);fires_by_region[name]={count:0,top_clusters:[],error:`NASA FIRMS gave no answer for ${name} (API error, timeout, or open circuit) and no cached copy exists`};}}
      const result:Obj={fires_by_region,total_fires,source:'nasa-firms',timestamp:now().toISOString().replace('Z','+00:00')};if(failed.length){failed.sort();Object.assign(result,{degraded:true,reason:'firms_fetch_failed',failed_regions:failed});if(failed.length===targets.length)result.error='NASA FIRMS fetch failed for every requested region (API error, timeout, or open circuit; no cached copy)';else result.partial_errors=failed.map(k=>fires_by_region[k].error);}return result;
    },
    intel_space_weather:async(_a:Args={})=>{
      const base='https://services.swpc.noaa.gov';const values=await Promise.allSettled([get(base+'/products/noaa-planetary-k-index.json',{},600),get(base+'/json/goes/primary/xrays-6-hour.json',{},600),get(base+'/products/alerts.json',{},600)]);const [kp,flare,alerts]=values.map(v=>v.status==='fulfilled'?list(v.value):[]);
      const kp_recent=kp!.length>1?kp!.slice(-8).flatMap(r=>{const value=num(Array.isArray(r)?r[1]:r?.Kp??r?.kp);return value===null?[]:[{time:Array.isArray(r)?r[0]:r.time_tag||r.time||null,kp:value}];}):[];
      const current=kp_recent.at(-1)?.kp??null;const flux=num(obj(flare!.at(-1)).flux);let cls:string|null=null;if(flux!==null){const pair=([[1e-4,'X'],[1e-5,'M'],[1e-6,'C'],[1e-7,'B']] as const).find(([v])=>flux>=v);cls=pair?pair[1]+(flux/pair[0]).toFixed(1):'A';}
      const result:Obj={current_kp:current,kp_level:current===null?'Unknown':current>=9?'G5 Extreme':current>=8?'G4 Severe':current>=7?'G3 Strong':current>=6?'G2 Moderate':current>=5?'G1 Minor':current>=4?'Active':'Quiet',latest_flare_class:cls,solar_wind_speed_km_s:null,alerts:alerts!.slice(0,10).filter(a=>a&&typeof a==='object'&&!Array.isArray(a)).map(a=>({issue_datetime:nullable(a.issue_datetime),message:String(a.message||'').slice(0,200),product_id:nullable(a.product_id)})),kp_recent,source:'noaa-swpc',timestamp:now().toISOString().replace('Z','+00:00')};
      if(values.some(v=>v.status==='rejected'))Object.assign(result,{degraded:true,reason:'swpc_partial_failure'});return result;
    },
  };
}

const HAZARD_NAMES:Record<string,string>={'earthquake.usgs.gov':'usgs','api.weather.gov':'nws','eonet.gsfc.nasa.gov':'eonet','www.gdacs.org':'gdacs','ll.thespacedevs.com':'launch-library','services.swpc.noaa.gov':'swpc','archive-api.open-meteo.com':'open-meteo','www.nhc.noaa.gov':'nhc','volcano.si.edu':'gvp','feeds.meteoalarm.org':'meteoalarm','www.metoc.navy.mil':'jtwc','firms.modaps.eosdis.nasa.gov':'nasa-firms'};
function hazardSource(url:URL){return HAZARD_NAMES[url.hostname]!;}
export function hazardSourceRules():Record<string,SourceRule>{return Object.fromEntries([...ORIGINS].map(origin=>[hazardSource(new URL(origin)),{origins:[origin]}]));}
