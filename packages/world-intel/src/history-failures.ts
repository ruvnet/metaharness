// SPDX-License-Identifier: MIT
// Lost-cycle journal contract from World Intel history.py, native filesystem implementation.
import {openSync,closeSync,lstatSync,fstatSync,readFileSync,writeFileSync,fsyncSync,renameSync,unlinkSync,constants} from 'node:fs';
import {randomBytes} from 'node:crypto';
import type {SourceOutcome} from './history.js';
type Row=Record<string,any>;
export const writeFailuresPath=(path:string)=>path+'-history-write-failures.jsonl';
function readRecord(path:string):{text:string|null;refused:string|null}{
 try{const stat=lstatSync(path);if(stat.isSymbolicLink())return {text:null,refused:'is a symlink; not followed'};if(!stat.isFile())return {text:null,refused:'is not a regular file; not read'};}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {text:null,refused:null};throw e;}
 let fd:number|undefined;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=fstatSync(fd);if(!stat.isFile())return {text:null,refused:'is not a regular file; not read'};if(stat.size>4000000)return {text:null,refused:'exceeds the 4 MB journal read cap'};return {text:readFileSync(fd,'utf8'),refused:null};}catch(e){if(['ELOOP','EMLINK'].includes((e as NodeJS.ErrnoException).code??''))return {text:null,refused:'is a symlink; not followed'};if((e as NodeJS.ErrnoException).code==='ENOENT')return {text:null,refused:null};throw e;}finally{if(fd!==undefined)closeSync(fd);}
}
export function recordWriteFailure(dbPath:string,outcomes:readonly SourceOutcome[],error:string,now=Date.now()/1000):string|null {
 if(dbPath===':memory:')return null;const path=writeFailuresPath(dbPath),temp=path+'.'+randomBytes(12).toString('hex')+'.tmp';let fd:number|undefined;
 try{const old=readRecord(path),record:Row={failed_at:new Date(now*1000).toISOString().replace(/\.\d{3}Z$/,'Z'),failed_at_ts:Math.round(now*1000)/1000,error:String(error).slice(0,500),sources:[...new Set(outcomes.map(o=>o.source))].sort()};if(old.refused)record.replaced_unread=path+' '+old.refused;const lines=(old.text??'').split(/\r?\n/).filter(Boolean);lines.push(JSON.stringify(record));fd=openSync(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);writeFileSync(fd,lines.slice(-500).join('\n')+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,path);return path;}catch{return null;}finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{}}
}
export function readWriteFailures(dbPath:string,now=Date.now()/1000,captureDays=30):{records:Row[];unreadable:number;refused:string|null}{
 if(dbPath===':memory:')return {records:[],unreadable:0,refused:null};let read;try{read=readRecord(writeFailuresPath(dbPath));}catch{return {records:[],unreadable:1,refused:null};}if(read.refused)return {records:[],unreadable:1,refused:read.refused};const records:Row[]=[],cutoff=captureDays>0?now-captureDays*86400:null;let unreadable=0;for(const line of (read.text??'').split(/\r?\n/)){if(!line.trim())continue;try{const r=JSON.parse(line),time=Number(r.failed_at_ts);if(r===null||typeof r!=='object'||Array.isArray(r)||!Number.isFinite(time))throw new Error('invalid record');if(cutoff===null||time>=cutoff)records.push(r);}catch{unreadable++;}}return {records,unreadable,refused:null};
}
