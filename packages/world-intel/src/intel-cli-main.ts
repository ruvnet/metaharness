#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import {pathToFileURL} from 'node:url';
import {readFileSync,copyFileSync,constants,realpathSync} from 'node:fs';
import {resolve,join,basename,dirname} from 'node:path';
import {parseIntelCommand,executeIntelCommand,intelHelp,IntelUsageError} from './intel-cli.js';
import {createNativeRegistry} from './registry.js';
import {createConfiguredRuntime} from './configured-runtime.js';
import {attachedSourceRuntime} from './source-runtime.js';
import {createLocalBgeEmbedding} from './local-embedding.js';
import {readResource,GUIDE_URI,MEASURES_URI} from './guide.js';
import {runDashboardMain} from './dashboard-main.js';
export async function runIntelCliMain(argv:readonly string[]=process.argv.slice(2),io:{out?:(text:string)=>void;err?:(text:string)=>void}={}):Promise<number>{
 const out=io.out??(s=>process.stdout.write(s)),err=io.err??(s=>process.stderr.write(s));let dataDir:string|undefined,modelDir:string|undefined,allowWrites=false,receipts=false;const args:string[]=[];
 try{
  for(let i=0;i<argv.length;i++){const a=argv[i];if(a==='--data-dir'||a==='--embedding-model-dir'){const value=argv[++i];if(!value||value.startsWith('--'))throw new IntelUsageError(a+' requires a directory');if(a==='--data-dir')dataDir=value;else modelDir=value;}else if(a==='--allow-writes')allowWrites=true;else if(a==='--receipts')receipts=true;else args.push(a);}
  if(!args.length||args.length===1&&['--help','-h'].includes(args[0])){out(intelHelp());return 0;}
  const parsed=parseIntelCommand(args);if(parsed.help){out(intelHelp(parsed.command));return 0;}
  if((allowWrites||modelDir)&&!dataDir)throw new IntelUsageError('--allow-writes and --embedding-model-dir require --data-dir');
  if(parsed.command.target==='$dashboard'){
   if(!dataDir)throw new IntelUsageError('Dashboard requires --data-dir');
   // Separate executable owns long-lived resources; do not create a second runtime here.
   let accepted=true;const result=await executeIntelCommand(parsed,{handlers:{},onGovernance:g=>{accepted=g.accepted;if(receipts)err(JSON.stringify({governance:g})+'\n');},dashboard:async a=>{await runDashboardMain(['--data-dir',dataDir!,'--host',String(a.host),'--port',String(a.port),...(modelDir?['--embedding-model-dir',modelDir]:[])]);return {started:true,host:a.host,port:a.port};}});
   out(JSON.stringify(result,null,2)+'\n');return accepted?0:1;
  }
  const embedding=modelDir?await createLocalBgeEmbedding(modelDir):undefined;let configured:ReturnType<typeof createConfiguredRuntime>|undefined;let handlers:ReturnType<typeof createNativeRegistry>|undefined;
  try{
   configured=dataDir?createConfiguredRuntime(dataDir,{embedding}):undefined;handlers=configured?.handlers??createNativeRegistry();const runtime=configured?.sourceRuntime??attachedSourceRuntime(handlers)!;
   const definitions=JSON.parse(readFileSync(new URL('../data/upstream-tools.json',import.meta.url),'utf8')).tools,domains=[...new Set<string>(definitions.map((t:any)=>t.upstream.module))].map(key=>({key,tools:definitions.filter((t:any)=>t.upstream.module===key)}));
   let accepted=true;
   const result=await executeIntelCommand(parsed,{handlers,allowWrites,
    onGovernance:g=>{accepted=g.accepted;if(receipts)err(JSON.stringify({governance:g})+'\n');},
    status:()=>({circuit_breakers:runtime.breaker.status(),cache:runtime.cache.stats()}),
    guide:measures=>{const uri=measures?MEASURES_URI:GUIDE_URI,c=readResource(uri,{domains,implementedTools:new Set(Object.keys(handlers!))}).contents[0];return {uri,mime_type:c.mimeType,text:c.text};},
    sync:source=>source?{status:'not_implemented',message:`Force sync not yet implemented for specific source '${source}'`,workaround:'cache entries expire naturally based on TTL'}:{evicted:runtime.cache.evictExpired()},
    report:async(a,output)=>{
     // Explicit output remains bounded to the configured reports directory; never overwrite.
     let destination:string|undefined;
     if(output){if(!configured)throw new IntelUsageError('Report output requires --data-dir');const folder=join(configured.root,'reports');destination=resolve(folder,output);if(dirname(destination)!==folder||!/^[-A-Za-z0-9_][A-Za-z0-9_.-]{0,180}\.(?:html|pdf)$/.test(basename(destination)))throw new IntelUsageError('Report --output must name a file inside the configured reports directory');}
     const result=await handlers!.intel_generate_report!(a) as Record<string,any>;
     if(destination&&!result.error){const folder=realpathSync(join(configured!.root,'reports')),source=realpathSync(String(result.path));if(dirname(source)!==folder)throw Error('Generated report path outside configured directory');if(source!==destination){copyFileSync(source,destination,constants.COPYFILE_EXCL);result.path=destination;}}
     return result;
    }});
   if(parsed.command.target==='$guide'&&!parsed.jsonOutput&&result&&typeof result==='object'&&'text'in result)out(String(result.text));else out(JSON.stringify(result,null,2)+'\n');
   return accepted?0:1;
  }finally{
   const errors:unknown[]=[];try{if(configured)configured.close();else if(handlers)attachedSourceRuntime(handlers)?.close();}catch(e){errors.push(e);}try{await embedding?.dispose();}catch(e){errors.push(e);}if(errors.length)throw new AggregateError(errors,'CLI cleanup failed');
  }
 }catch(e){err(JSON.stringify({error:e instanceof Error?e.message:String(e)})+'\n');return e instanceof IntelUsageError?2:1;}
}
const isEntrypoint=()=>{try{return Boolean(process.argv[1])&&import.meta.url===pathToFileURL(realpathSync(resolve(process.argv[1]))).href;}catch{return false;}};
if(isEntrypoint())void runIntelCliMain().then(code=>{process.exitCode=code;},e=>{console.error(e);process.exitCode=1;});
