// SPDX-License-Identifier: MIT
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {createRequire} from 'node:module';
import {existsSync,lstatSync} from 'node:fs';
import {resolve,parse} from 'node:path';
export type HistoryRow=Record<string,any>;
/** Read-only transaction. A missing path remains missing; no schemas or files are created. */
export class HistoryReader {
 private db?:DatabaseSync;
 readonly tables:Set<string>;
 constructor(path:string){
 const full=resolve(path);let cursor=parse(full).root;for(const part of full.slice(cursor.length).split('/')){cursor=resolve(cursor,part);if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())throw new Error('History read path must not contain symlinks');}
 if(!existsSync(full)){this.tables=new Set();return;}const [major,minor]=process.versions.node.split('.').map(Number);if(major!<22||(major===22&&minor!<13))throw new Error('History reads require Node >=22.13');const SQLite=(createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;this.db=new SQLite(full,{readOnly:true});this.db.exec('PRAGMA busy_timeout=10000; BEGIN');this.tables=new Set(this.all("SELECT name FROM sqlite_master WHERE type='table'").map(r=>r.name));
 }
 all(sql:string,...args:SQLInputValue[]):HistoryRow[]{return this.db?this.db.prepare(sql).all(...args) as HistoryRow[]:[];}
 one(sql:string,...args:SQLInputValue[]):HistoryRow{return this.all(sql,...args)[0]??{};}
 close(){this.db?.close();}
}
