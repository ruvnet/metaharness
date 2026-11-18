// SPDX-License-Identifier: MIT
// Explicit one-shot collector. Never starts a background loop or adds sources implicitly.
import type {HistoryStore,SourceOutcome} from './history.js';
import {recordingStaleServes} from './source-runtime.js';
import {recordWriteFailure} from './history-failures.js';
import type {NativeVectorStore} from './vector-store.js';
import {hasUnacceptedProviderState,type DomainHandlers} from './domain-runtime.js';
import {HISTORY_COLLECTOR_SOURCES} from './domains/history.js';
export interface CollectorSource {name:string;collect(signal:AbortSignal):Promise<unknown>;timeoutSeconds?:number}
export interface CollectorOptions {sources:readonly CollectorSource[];vectorStore:NativeVectorStore;historyStore?:HistoryStore;now?:()=>number;timeoutSeconds?:number}
export async function collectOnce(options:CollectorOptions,sourceFilter?:ReadonlySet<string>):Promise<Record<string,unknown>> {
 const now=options.now??(()=>Date.now()/1000),started=now(),sources=options.sources.filter(s=>!sourceFilter||sourceFilter.has(s.name));if(new Set(sources.map(s=>s.name)).size!==sources.length)throw new Error('Collector source names must be unique');
 const outcomes=await Promise.all(sources.map(async s=>{const began=performance.now(),controller=new AbortController(),budget=s.timeoutSeconds??options.timeoutSeconds??(s.name==='aoi_digest'?240:45);if(!Number.isFinite(budget)||budget<=0)throw new Error('Collector timeout must be positive');let timer:ReturnType<typeof setTimeout>|undefined;
 try{const {value:payload,staleServes}=await recordingStaleServes(()=>Promise.race([s.collect(controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error(`timeout (${budget}s)`));},budget*1000);})]));return {source:s.name,collected_at:now(),duration_s:(performance.now()-began)/1000,payload,stale_serves:staleServes} as SourceOutcome;}catch(e){return {source:s.name,collected_at:now(),duration_s:(performance.now()-began)/1000,error:(e instanceof Error?e.message:String(e)).slice(0,120)} as SourceOutcome;}finally{if(timer)clearTimeout(timer);}
 }));
 let successes=0,failures=0;const errors:string[]=[],upstreamErrors:string[]=[],stale:string[]=[],vectorWriteErrors:string[]=[],rejected:string[]=[];
 for(const o of outcomes){if(o.error){failures++;errors.push(`${o.source}: ${o.error}`);}else if(o.payload!=null){successes++;const data=o.payload as Record<string,unknown>;if(typeof data==='object'&&data.error)upstreamErrors.push(`${o.source}: ${String(data.error).slice(0,100)}`);else if(o.stale_serves?.length||typeof data==='object'&&(data._stale===true||data.stale===true))stale.push(o.source);else if(hasUnacceptedProviderState(data))rejected.push(o.source);else try{await options.vectorStore.store(o.source,o.payload,o.collected_at);}catch(e){vectorWriteErrors.push(`${o.source}: ${(e as Error).message}`);}}else failures++;}
 let history:unknown={error:'History store not configured; this cycle was not recorded in history'};if(options.historyStore)try{history=recordHistoryWithRetry(options.historyStore,outcomes,now());}catch(e){const record=recordWriteFailure(options.historyStore.dbPath,outcomes,(e as Error).message,now());history={error:'History write failed: '+(e as Error).message,write_failure_record:record};}
 const stats=options.vectorStore.collectionStats(),missing=HISTORY_COLLECTOR_SOURCES.filter(s=>!options.sources.some(c=>c.name===s));
 return {cycle_time_s:Math.round((now()-started)*10)/10,sources_attempted:sources.length,successes,failures,errors:errors.slice(0,10),upstream_errors:upstreamErrors,stale_not_stored:stale,...(rejected.length?{unaccepted_not_stored:rejected,degraded:true}:{}),vector_store_points:stats.points_count,history,...(vectorWriteErrors.length?{vector_write_errors:vectorWriteErrors,degraded:true}:{}),...(missing.length?{scope:'explicit configured sources only',unconfigured_upstream_sources:missing}:{})};
}
/** Registers a real one-shot writer only when the caller supplies source functions and stores. */
export function createCollectorHandlers(options:CollectorOptions):DomainHandlers{return {intel_collect:async args=>collectOnce(options,args.sources===undefined?undefined:new Set(String(args.sources).split(',').filter(Boolean)))};}

/** Retry only SQLite operational failures, once. recordCycle rolls back failed transactions. */
export function recordHistoryWithRetry(store:Pick<HistoryStore,'recordCycle'>,outcomes:SourceOutcome[],now:number):unknown{
 for(let attempt=0;;attempt++)try{return store.recordCycle(outcomes,now);}catch(error){
 const e=error as {code?:string;errcode?:number};
 // Python sqlite3.OperationalError equivalents, excluding constraints, corruption and programmer misuse.
 const operational=e.code==='ERR_SQLITE_ERROR'&&typeof e.errcode==='number'&&[1,2,3,5,6,8,9,10,13,14,15].includes(e.errcode&255);
 if(attempt!==0||!operational)throw error;
 }
}
