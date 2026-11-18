// SPDX-License-Identifier: MIT
import {createRequire} from 'node:module';
import type {DatabaseSync} from 'node:sqlite';
import type {AOI,AOIStorage,Snapshot} from './aoi.js';
const requireNative=createRequire(import.meta.url);
const key=(n:string)=>n.trim().toLowerCase();
/** Opening this explicit capability is the only filesystem-writing operation.
 * Parent directories are deliberately not created and no default path is used.
 */
export class SQLiteAOIStorage implements AOIStorage {
 private db:DatabaseSync;
 constructor(path:string){if(!path)throw new Error('An explicit AOI database path is required.');const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<13))throw new Error('AOI SQLite requires Node >=22.13; memory storage remains available.');let Ctor:typeof import('node:sqlite').DatabaseSync;try{Ctor=(requireNative('node:sqlite') as typeof import('node:sqlite')).DatabaseSync}catch{throw new Error('Native node:sqlite is unavailable; AOI persistence cannot be enabled.')}this.db=new Ctor(path);try{this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS aois(name_key TEXT PRIMARY KEY,name TEXT NOT NULL,lat REAL NOT NULL,lon REAL NOT NULL,radius_km REAL NOT NULL,created_at REAL NOT NULL,kind TEXT NOT NULL DEFAULT 'circle',geometry TEXT); CREATE TABLE IF NOT EXISTS aoi_snapshots(name_key TEXT PRIMARY KEY,taken_at REAL NOT NULL,snapshot TEXT NOT NULL);`);const cols=this.db.prepare('PRAGMA table_info(aois)').all().map(r=>r.name);if(!cols.includes('kind'))this.db.exec("ALTER TABLE aois ADD COLUMN kind TEXT NOT NULL DEFAULT 'circle'");if(!cols.includes('geometry'))this.db.exec('ALTER TABLE aois ADD COLUMN geometry TEXT');}catch(error){try{this.db.close()}catch{}throw error}}
 private row(r:any):AOI|null {if(!r)return null;let geometry=null;try{geometry=r.geometry?JSON.parse(r.geometry):null}catch{}return {name:r.name,lat:r.lat,lon:r.lon,radius_km:r.radius_km,created_at:r.created_at,kind:r.kind||'circle',geometry}}
 get(n:string){return this.row(this.db.prepare('SELECT * FROM aois WHERE name_key=?').get(key(n)))}
 list(){return this.db.prepare('SELECT * FROM aois ORDER BY name').all().map(r=>this.row(r)!)}
 put(a:AOI,previous?:string){this.db.exec('BEGIN IMMEDIATE');try{if(previous&&key(previous)!==key(a.name)){this.db.prepare('UPDATE aois SET name_key=? WHERE name_key=?').run(key(a.name),key(previous));this.db.prepare('UPDATE aoi_snapshots SET name_key=? WHERE name_key=?').run(key(a.name),key(previous))}this.db.prepare('INSERT INTO aois VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(name_key) DO UPDATE SET name=excluded.name,lat=excluded.lat,lon=excluded.lon,radius_km=excluded.radius_km,created_at=excluded.created_at,kind=excluded.kind,geometry=excluded.geometry').run(key(a.name),a.name,a.lat,a.lon,a.radius_km,a.created_at,a.kind,a.geometry?JSON.stringify(a.geometry):null);this.db.exec('COMMIT')}catch(e){this.db.exec('ROLLBACK');throw e}}
 delete(n:string){this.db.exec('BEGIN IMMEDIATE');try{const r=this.db.prepare('DELETE FROM aois WHERE name_key=?').run(key(n));this.deleteSnapshot(n);this.db.exec('COMMIT');return Number(r.changes)>0}catch(e){this.db.exec('ROLLBACK');throw e}}
 getSnapshot(n:string):Snapshot|null{const r=this.db.prepare('SELECT taken_at,snapshot FROM aoi_snapshots WHERE name_key=?').get(key(n));if(!r)return null;try{return {taken_at:Number(r.taken_at),domains:JSON.parse(String(r.snapshot))}}catch{return null}}
 putSnapshot(n:string,s:Snapshot){this.db.prepare('INSERT OR REPLACE INTO aoi_snapshots VALUES(?,?,?)').run(key(n),s.taken_at,JSON.stringify(s.domains))}
 deleteSnapshot(n:string){this.db.prepare('DELETE FROM aoi_snapshots WHERE name_key=?').run(key(n))}
 close(){this.db.close()}
}
