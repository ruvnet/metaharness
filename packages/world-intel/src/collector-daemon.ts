// SPDX-License-Identifier: MIT
// Native lifecycle port of collector.py at fdebf9a8 (Phoenix AGI MIT).
// No resource construction, model loading, process handlers or timers occur at import.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {withExecutionPolicy} from './execution-policy.js';
export const COLLECTOR_DOMAIN_GROUPS:Readonly<Record<string,readonly string[]>>={"markets":["market_quotes","crypto_quotes","macro_signals","sector_heatmap","stablecoin_status","etf_flows","commodity_quotes","btc_technicals"],"economic":["energy_prices","gas_prices","residential_natgas","electricity_rates","central_bank_rates"],"liquidity":["liquidity_board","net_liquidity"],"natural":["earthquakes","wildfires","weather_alerts","volcano_activity","cyclones"],"conflict":["acled_events","ucdp_events","displacement"],"migration":["displacement","migration_surges","net_migration"],"military":["military_flights"],"infrastructure":["internet_outages","cable_health","service_status"],"maritime":["nav_warnings"],"climate":["climate_anomalies"],"news":["news_feed","trending_keywords","situations","top_stories"],"prediction":["prediction_markets","kalshi_markets","prediction_compare"],"aviation":["airport_delays","domestic_flights","bizjet_cohort","military_cohort"],"cyber":["cyber_threats"],"space":["space_weather","launch_schedule"],"ai":["ai_watch"],"health":["disease_outbreaks"],"elections":["election_calendar"],"shipping":["shipping_index"],"social":["social_signals"],"nuclear":["nuclear_monitor"],"traffic":["traffic_flow","traffic_incidents"],"aoi":["aoi_digest"],"analysis":["risk_scores","signal_convergence","alert_digest","weekly_trends","strategic_posture","fleet_report","usni_fleet"]};
export const COLLECTOR_DEFAULT_INTERVAL_SECONDS=300;
export const COLLECTOR_SOURCE_TIMEOUT_SECONDS=45;
export const COLLECTOR_TIMEOUT_OVERRIDES:Readonly<Record<string,number>>={aoi_digest:240};
export type CollectorRosterEntry=readonly [name:string,module:string,functionName:string,args:Record<string,unknown>];
/** Read the pinned 61-source roster only when explicitly requested. Never invokes it. */
export function collectorRoster():readonly CollectorRosterEntry[]{return JSON.parse(readFileSync(new URL('../data/public/collector.json',import.meta.url),'utf8')) as CollectorRosterEntry[];}
/** Unknown selectors intentionally survive, matching upstream empty-selection semantics. */
export function resolveCollectorSources(filter?:string|null):ReadonlySet<string>|undefined{if(!filter)return undefined;const names=new Set<string>();for(const part of filter.split(',')){const name=part.trim();for(const source of COLLECTOR_DOMAIN_GROUPS[name]??[name])names.add(source);}return names;}
export interface CollectorCycleContext{sourceFilter?:ReadonlySet<string>;sourceTimeoutSeconds:number;sourceTimeoutOverrides:Readonly<Record<string,number>>;/** Graceful stop is not cancellation of the current cycle. */stopRequested:()=>boolean}
export interface CollectorDaemonResources{
 /** Adapter should call collectOnce; HistoryStore.recordCycle applies retention in that same cycle transaction. */
 collect(context:CollectorCycleContext):Promise<Record<string,unknown>>;
 evictExpiredCache():number|Promise<number>;
 /** Drain an asynchronous vector write queue if one exists. Native synchronous SQLite may omit it. */
 drain?():void|Promise<void>;
 /** Close every explicitly opened fetcher, cache and store. Called exactly once after successful open. */
 close():void|Promise<void>;
}
export type CollectorDaemonEvent={kind:'starting'|'cycle_started'|'cycle_completed'|'cycle_failed'|'cache_evicted'|'stop_requested'|'stopped';at:number;cycle?:number;summary?:Record<string,unknown>;error?:string;count?:number;signal?:string};
export interface CollectorDaemonOptions{
 dataDirectory:string;allowWrites:boolean;
 open:(configuration:{dataDirectory:string;allowWrites:true})=>Promise<CollectorDaemonResources>|CollectorDaemonResources;
 intervalSeconds?:number;sourceFilter?:string|null;mode?:'once'|'daemon';maxCycles?:number;
 now?:()=>number;wait?:(milliseconds:number,signal:AbortSignal)=>Promise<void>;
 signal?:AbortSignal;
 /** Optional explicit process-signal adapter; omitted means no process listeners are installed. Returns unsubscribe. */
 signals?:{subscribe:(callback:(signal:'SIGINT'|'SIGTERM')=>void)=>()=>void};
 onEvent?:(event:CollectorDaemonEvent)=>void;
}
export interface CollectorDaemonResult{cycles:number;failedCycles:number;stopped:boolean;lastSummary:Record<string,unknown>|null;errors:string[];startedAt:number;finishedAt:number}
export function waitForCollectorInterval(milliseconds:number,signal:AbortSignal):Promise<void>{if(signal.aborted)return Promise.resolve();return new Promise(resolve=>{let timer:ReturnType<typeof setTimeout>;const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};timer=setTimeout(done,milliseconds);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});}
/** Explicitly constructed but inert until run(). Serial cycles never overlap.
 * Cadence is completion-relative, matching upstream: collect + interval, not fixed-rate.
 * Signals stop future cycles and interrupt waiting, but let an in-flight cycle finish and persist outcomes.
 */
export function createCollectorDaemon(options:CollectorDaemonOptions){
 const interval=options.intervalSeconds??COLLECTOR_DEFAULT_INTERVAL_SECONDS,mode=options.mode??'daemon';
 if(!options.allowWrites)throw Error('Collector lifecycle requires explicit allowWrites:true');
 if(typeof options.dataDirectory!=='string'||!options.dataDirectory.trim()||options.dataDirectory===':memory:'||/^[a-z][a-z0-9+.-]*:\/\//i.test(options.dataDirectory))throw Error('Collector lifecycle requires an explicit local data directory');
 if(!Number.isSafeInteger(interval)||interval<1||interval>86400)throw Error('Collector interval must be an integer from 1 to 86400 seconds');
 if(!['once','daemon'].includes(mode))throw Error('Collector mode must be once or daemon');
 if(options.maxCycles!==undefined&&(!Number.isSafeInteger(options.maxCycles)||options.maxCycles<1))throw Error('maxCycles must be a positive integer');
 const dataDirectory=resolve(options.dataDirectory),now=options.now??Date.now,wait=options.wait??waitForCollectorInterval,filter=resolveCollectorSources(options.sourceFilter),stopController=new AbortController();
 let state:'idle'|'running'|'stopped'|'failed'='idle',started=false,cycles=0,failed=0,lastSummary:Record<string,unknown>|null=null;
 const emit=(event:Omit<CollectorDaemonEvent,'at'>)=>{try{options.onEvent?.({...event,at:now()});}catch{/* A logging/telemetry observer cannot prevent persistence or cleanup. */}};
 const stop=(signal='requested')=>{if(!stopController.signal.aborted){stopController.abort();emit({kind:'stop_requested',signal});}};
 const run=async():Promise<CollectorDaemonResult>=>{
  if(started)throw Error('Collector lifecycle can only run once');started=true;const startedAt=now(),errors:string[]=[];let resources:CollectorDaemonResources|undefined,unsubscribe:(()=>void)|undefined;
  const abort=()=>stop('abort');if(options.signal?.aborted)stop('abort');else options.signal?.addEventListener('abort',abort,{once:true});
  state='running';
  try{
   if(!stopController.signal.aborted){resources=await options.open({dataDirectory,allowWrites:true});unsubscribe=options.signals?.subscribe(signal=>stop(signal));emit({kind:'starting'});}
   while(resources&&!stopController.signal.aborted){cycles++;emit({kind:'cycle_started',cycle:cycles});
    try{lastSummary=await withExecutionPolicy(true,()=>resources!.collect({sourceFilter:filter,sourceTimeoutSeconds:COLLECTOR_SOURCE_TIMEOUT_SECONDS,sourceTimeoutOverrides:COLLECTOR_TIMEOUT_OVERRIDES,stopRequested:()=>stopController.signal.aborted}));emit({kind:'cycle_completed',cycle:cycles,summary:lastSummary});}
    catch(e){failed++;const error=e instanceof Error?e.message:String(e);if(errors.length<100)errors.push(error.slice(0,500));emit({kind:'cycle_failed',cycle:cycles,error:error.slice(0,500)});}
    // Counts failed collection attempts too, exactly as upstream. Not a time-based hourly timer.
    if(cycles%12===0){const count=await resources.evictExpiredCache();emit({kind:'cache_evicted',cycle:cycles,count});}
    if(mode==='once'||options.maxCycles!==undefined&&cycles>=options.maxCycles)break;
    if(!stopController.signal.aborted)await wait(interval*1000,stopController.signal);
   }
   state='stopped';return{cycles,failedCycles:failed,stopped:stopController.signal.aborted,lastSummary,errors,startedAt,finishedAt:now()};
  }catch(error){state='failed';throw error;}
  finally{
   options.signal?.removeEventListener('abort',abort);const cleanupErrors:unknown[]=[];
   try{unsubscribe?.();}catch(error){cleanupErrors.push(error);}
   if(resources){try{await resources.drain?.();}catch(error){cleanupErrors.push(error);}try{await resources.close();}catch(error){cleanupErrors.push(error);}}
   emit({kind:'stopped',cycle:cycles});
   if(cleanupErrors.length){state='failed';throw cleanupErrors[0];}
  }
 };
 return{run,stop,status:()=>({state,cycles,failedCycles:failed,stopRequested:stopController.signal.aborted})};
}
