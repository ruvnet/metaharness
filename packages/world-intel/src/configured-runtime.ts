import {SourceRuntime,SqliteSourceCache} from './source-runtime.js';
// SPDX-License-Identifier: MIT
import {mkdirSync,lstatSync,openSync,writeSync,closeSync,constants} from 'node:fs';
import pathApi,{resolve,join,basename} from 'node:path';
import {HistoryStore} from './history.js';
import {NativeVectorStore,type EmbeddingProvider} from './vector-store.js';
import {SQLiteAOIStorage} from './domains/aoi-storage.js';
import {SQLiteCohortStore} from './domains/jet-cohort.js';
import {SqliteTemporalStore,TemporalBaseline} from './domains/intelligence-composites.js';
import {createNativePDFRenderer} from './domains/reports-pdf.js';
import {createNativeRegistry,nativeSourceRules,type NativeRegistryOptions} from './registry.js';
/** Enumerate platform-native ancestors, including Windows drive and UNC paths. */
export function dataDirectoryAncestors(directory:string,paths:Pick<typeof pathApi,'parse'|'join'|'sep'>=pathApi):string[]{let current=paths.parse(directory).root;const result:string[]=[];for(const segment of directory.slice(current.length).split(paths.sep).filter(Boolean)){current=paths.join(current,segment);result.push(current)}return result;}
export function explicitDataDirectory(path:string):string{const directory=resolve(path);const check=()=>{for(const current of dataDirectoryAncestors(directory)){try{const stat=lstatSync(current);if(stat.isSymbolicLink())throw Error('Data directory cannot contain symlinks');if(!stat.isDirectory())throw Error('Data directory ancestor is not a directory');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}};check();mkdirSync(directory,{recursive:true,mode:0o700});check();return directory;}
/** Only call after an explicit local-storage configuration choice. No network or model download. */
export function createConfiguredRuntime(dataDirectory:string,options:NativeRegistryOptions&{embedding?:EmbeddingProvider}={}){
 const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||major===22&&minor<13)throw Error('Configured runtime requires Node >=22.13');
 const root=explicitDataDirectory(dataDirectory);
 for(const name of ['history.sqlite','vectors.sqlite','aois.sqlite','cohorts.sqlite','baselines.sqlite','cache.sqlite'])for(const suffix of ['','-wal','-shm','-journal']){try{const stat=lstatSync(join(root,name+suffix));if(stat.isSymbolicLink())throw Error('Configured SQLite file or sidecar cannot be a symlink');if(!stat.isFile())throw Error('Configured SQLite file or sidecar must be a regular file');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 const opened:{close():void}[]=[];
 const own=<T extends {close():void}>(store:T):T=>{opened.push(store);return store};
 let closed=false;
 const close=()=>{if(closed)return;closed=true;let failed=false,failure:unknown;for(const store of [...opened].reverse())try{store.close()}catch(e){if(!failed){failure=e;failed=true}}if(failed)throw failure};
 try{
 const history=own(new HistoryStore(join(root,'history.sqlite'))),vector=own(new NativeVectorStore(join(root,'vectors.sqlite'),{embedding:options.embedding})),aoi=own(new SQLiteAOIStorage(join(root,'aois.sqlite'))),cohorts=own(new SQLiteCohortStore(join(root,'cohorts.sqlite'))),baselines=own(new SqliteTemporalStore(join(root,'baselines.sqlite')));
 const write=async(name:string,bytes:Uint8Array)=>{if(basename(name)!==name||!/^report-\d{8}-\d{6}\.(?:html|pdf)$/.test(name))throw Error('Unsafe report filename');if(bytes.byteLength>16000000)throw Error('Report exceeds16MB limit');const directory=explicitDataDirectory(join(root,'reports')),path=join(directory,name),fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{let at=0;while(at<bytes.length)at+=writeSync(fd,bytes,at,bytes.length-at);}finally{closeSync(fd);}return path;};
 const sourceRuntime=options.sourceRuntime??own(new SourceRuntime({rules:nativeSourceRules(),cache:new SqliteSourceCache(join(root,'cache.sqlite')),...(options.embedding?{vectorStore:vector}:{})}));
 const handlers=createNativeRegistry({...options,sourceRuntime,history,vector,aoi:{...options.aoi,store:aoi},jetStore:{...options.jetStore,store:cohorts},temporal:new TemporalBaseline(baselines),readBaselines:async()=>baselines.snapshot(),reports:{write,pdf:createNativePDFRenderer(),...options.reports}});
 return{handlers,history,vector,aoi,root,sourceRuntime,healthSnapshot:()=>sourceRuntime.health(),close};
 }catch(error){try{close()}catch{/* Preserve the original initialization failure after attempting every cleanup. */}throw error}
}
