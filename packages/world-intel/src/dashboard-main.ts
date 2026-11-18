#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Explicit executable only. Merely importing reusable dashboard modules never starts it.
import {createConfiguredRuntime} from './configured-runtime.js';
import {createLocalBgeEmbedding} from './local-embedding.js';
import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startDashboard,validateDashboardListen} from './dashboard-http.js';
import {parseDashboardArgs} from './dashboard-cli.js';
export async function runDashboardMain(args:readonly string[]=process.argv.slice(2)){
 const listenArgs:string[]=[];let dataDir:string|undefined,modelDir:string|undefined;
 for(let i=0;i<args.length;i++){if(args[i]==='--data-dir'&&args[i+1])dataDir=args[++i];else if(args[i]==='--embedding-model-dir'&&args[i+1])modelDir=args[++i];else listenArgs.push(args[i]);}
 if(!dataDir)throw Error('Dashboard requires explicit --data-dir DIRECTORY; no default private filesystem access');
 const listen=parseDashboardArgs(listenArgs);validateDashboardListen(listen);const embedding=modelDir?await createLocalBgeEmbedding(modelDir):undefined;
 let runtime:ReturnType<typeof createConfiguredRuntime>|undefined;
 try{
  runtime=createConfiguredRuntime(dataDir,{embedding});const active=runtime;
  const countryCoordinates=async()=>{
   const raw=await active.sourceRuntime.getJson('https://api.worldbank.org/v2/country',{source:'worldbank',params:{format:'json',per_page:1000},cacheTtl:604800});
   if(!Array.isArray(raw)||!Array.isArray(raw[1]))return null;const result:Record<string,any>=Object.create(null);
   for(const c of raw[1]){if(!c||!String(c.id??'').match(/^[A-Z0-9]{3}$/))continue;const coord=(v:any)=>v!==''&&v!=null&&Number.isFinite(Number(v))?Number(v):null;result[c.id]={aggregate:c.region?.id==='NA',capital:String(c.capitalCity??'').trim()||null,latitude:coord(c.latitude),longitude:coord(c.longitude)};}
   return result;
  };
  const started=await startDashboard({handlers:active.handlers,health:()=>active.sourceRuntime.health(),vector:active.vector,
    aoiStore:active.aoi,countryCoordinates,historyPath:active.history.dbPath,
    collectionHealth:async source=>await active.handlers.intel_collection_health!({source}) as Record<string,any>},listen);
  let closing:Promise<void>|undefined;
  const onSignal=()=>{void close().catch(e=>{console.error('Dashboard cleanup failed: '+(e instanceof Error?e.message:String(e)));process.exitCode=1;});};
  const close=()=>closing??=(async()=>{const errors:unknown[]=[];
   try{await started.close();}catch(e){errors.push(e);}
   try{active.close();}catch(e){errors.push(e);}
   try{await embedding?.dispose();}catch(e){errors.push(e);}
   finally{process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);}
   if(errors.length)throw new AggregateError(errors,'Dashboard resource cleanup failed');
  })();
  process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);started.server.once('close',()=>{if(!closing)onSignal();});
  console.error('World Intel dashboard listening at '+JSON.stringify(started.address));
 }catch(e){
  const errors:unknown[]=[e];try{runtime?.close();}catch(cleanup){errors.push(cleanup);}
  try{await embedding?.dispose();}catch(cleanup){errors.push(cleanup);}
  if(errors.length>1)throw new AggregateError(errors,'Dashboard startup and cleanup failed');throw e;
 }
}
const isEntrypoint=()=>{try{return Boolean(process.argv[1])&&import.meta.url===pathToFileURL(realpathSync(resolve(process.argv[1]))).href;}catch{return false;}};
if(isEntrypoint())runDashboardMain().catch(e=>{console.error(e instanceof Error?e.message:'Dashboard failed');process.exitCode=1;});
