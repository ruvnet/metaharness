#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
import {createCollectorDaemon,type CollectorDaemonOptions} from './collector-daemon.js';
import {createConfiguredRuntime} from './configured-runtime.js';
import {createLocalBgeEmbedding} from './local-embedding.js';
import type {DomainHandlers} from './domain-runtime.js';
import type {EmbeddingProvider} from './vector-store.js';
export const COLLECTOR_USAGE='world-intel-collect --data-dir DIRECTORY --allow-writes [--once] [--interval SECONDS] [--sources DOMAIN_OR_SOURCE,...] [--embedding-model-dir DIRECTORY]';
export interface CollectorCLIArguments{dataDirectory:string;allowWrites:true;once:boolean;intervalSeconds:number;sourceFilter?:string;embeddingModelDirectory?:string}
export function parseCollectorArguments(args:readonly string[]):CollectorCLIArguments{
 let dataDirectory:string|undefined,embeddingModelDirectory:string|undefined,sourceFilter:string|undefined,allowWrites=false,once=false,intervalSeconds=300;const seen=new Set<string>();
 for(let i=0;i<args.length;i++){const flag=args[i];if(seen.has(flag))throw Error('Duplicate collector option: '+flag);seen.add(flag);
 if(flag==='--allow-writes'){allowWrites=true;continue;}if(flag==='--once'){once=true;continue;}
 if(!['--data-dir','--embedding-model-dir','--sources','--interval'].includes(flag))throw Error(COLLECTOR_USAGE);
 const value=args[++i];if(value===undefined||value.startsWith('--'))throw Error('Missing value for '+flag);
 if(flag==='--data-dir')dataDirectory=value;else if(flag==='--embedding-model-dir')embeddingModelDirectory=value;else if(flag==='--sources')sourceFilter=value;else{if(!/^\d+$/.test(value))throw Error('Interval must be an integer');intervalSeconds=Number(value);}}
 if(!dataDirectory?.trim()||dataDirectory===':memory:'||/^[a-z][a-z0-9+.-]*:\/\//i.test(dataDirectory))throw Error('Collector requires an explicit local --data-dir');
 if(!allowWrites)throw Error('Collector requires explicit --allow-writes');
 if(!Number.isSafeInteger(intervalSeconds)||intervalSeconds<1||intervalSeconds>86400)throw Error('Interval must be from 1 to 86400 seconds');
 if(embeddingModelDirectory!==undefined&&!embeddingModelDirectory.trim())throw Error('Embedding model directory cannot be empty');
 return {dataDirectory,allowWrites:true,once,intervalSeconds,sourceFilter,embeddingModelDirectory};
}
interface CollectorCLIRuntime{handlers:DomainHandlers;sourceRuntime:{cache:{evictExpired():number}};close():void}
export interface CollectorCLIDependencies{
 createRuntime?:(directory:string,options:{embedding?:EmbeddingProvider})=>CollectorCLIRuntime;
 createEmbedding?:(directory:string)=>Promise<EmbeddingProvider&{dispose():Promise<void>}>;
 signals?:CollectorDaemonOptions['signals'];wait?:CollectorDaemonOptions['wait'];signal?:AbortSignal;onEvent?:CollectorDaemonOptions['onEvent'];
}
/** Import-safe; explicit invocation alone starts collection. */
export async function runCollectorCLI(args:readonly string[],dependencies:CollectorCLIDependencies={}){
 const config=parseCollectorArguments(args);
 return createCollectorDaemon({dataDirectory:config.dataDirectory,allowWrites:true,mode:config.once?'once':'daemon',intervalSeconds:config.intervalSeconds,sourceFilter:config.sourceFilter,signals:dependencies.signals,signal:dependencies.signal,wait:dependencies.wait,onEvent:dependencies.onEvent,
 open:async({dataDirectory})=>{
 const embedding=config.embeddingModelDirectory?await(dependencies.createEmbedding??createLocalBgeEmbedding)(config.embeddingModelDirectory):undefined;
 let runtime:CollectorCLIRuntime;
 try{runtime=(dependencies.createRuntime??createConfiguredRuntime)(dataDirectory,{embedding});if(!runtime.handlers.intel_collect){runtime.close();throw Error('Configured runtime has no collector');}}catch(error){await embedding?.dispose();throw error;}
 return {collect:async context=>{
 const sources=context.sourceFilter===undefined?undefined:[...context.sourceFilter].join(',');
 return await runtime.handlers.intel_collect(sources===undefined?{}:{sources}) as Record<string,unknown>;
 },evictExpiredCache:()=>runtime.sourceRuntime.cache.evictExpired(),close:async()=>{try{runtime.close();}finally{await embedding?.dispose();}}};
 }}).run();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
 const signals:NonNullable<CollectorCLIDependencies['signals']>={subscribe(callback){const interrupt=()=>callback('SIGINT'),terminate=()=>callback('SIGTERM');process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);return()=>{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);};}};
 runCollectorCLI(process.argv.slice(2),{signals,onEvent:event=>console.error(JSON.stringify(event))}).then(result=>{if(result.failedCycles)process.exitCode=1;}).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
}
