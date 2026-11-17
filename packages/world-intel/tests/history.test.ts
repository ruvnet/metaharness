import {realpathSync} from 'node:fs';
import { describe,it,expect } from 'vitest';
import { mkdtempSync,rmSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryStore,normalizeObservedAt,periodDate,payloadHash,registerHistoryExtractor } from '../src/history.js';
import { createHistoryHandlers } from '../src/domains/history.js';
const [nodeMajor,nodeMinor]=process.versions.node.split('.').map(Number);
const supportsSqlite=nodeMajor!>22||(nodeMajor===22&&nodeMinor!>=13);
const options={payloadDays:0,captureDays:0,historyDays:0};
registerHistoryExtractor('fixture',p=>p.points);
const outcome=(value:number,collected_at=1000)=>({source:'fixture',collected_at,payload:{points:[{series_key:'value',value,observed_at:'2024-01',published_at:'2024-02-02T00:00:00Z'}]}});
describe.skipIf(!supportsSqlite)('dated SQLite history',()=>{
 it('persists dates and successive revisions, not unchanged observations',()=>{
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'history-'));const path=join(dir,'history.sqlite');
  let store=new HistoryStore(path,options);
  try{
   expect(store.recordCycle([outcome(1)]).observations_stored).toBe(1);
   expect(store.recordCycle([outcome(1,1001)]).observations_stored).toBe(0);
   expect(store.recordCycle([outcome(2,1002)]).observations_stored).toBe(1);
   store.close();store=new HistoryStore(path,options);
   const rows=store.seriesHistory('fixture:value').observations;
   expect(rows).toHaveLength(2);expect(rows[0]).toMatchObject({value:2,observed_at:'2024-01',published_at:'2024-02-02T00:00:00Z',collected_at:'1970-01-01T00:16:42Z'});
   expect(store.revisions().revisions[0]).toMatchObject({previous_value:1,revised_value:2,delta:1});
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('does not promote stale cache copies into observations or live successes',()=>{
  const store=new HistoryStore(':memory:',options);try{
   store.recordCycle([outcome(1,1000)]);
   store.recordCycle([{...outcome(2,1100),stale_serves:[{age_seconds:20}]}]);
   expect(store.seriesHistory('fixture:value').observations).toHaveLength(1);
   expect(store.collectionHealth(['fixture','never'],undefined,1101).sources).toEqual(expect.arrayContaining([expect.objectContaining({source:'fixture',state:'stale',last_success_at:'1970-01-01T00:16:40Z'}),expect.objectContaining({source:'never',state:'never_run'})]));
  }finally{store.close();}
 });
 it('deduplicates volatile top-level metadata and explains earlier replay body',()=>{
  const store=new HistoryStore(':memory:',options);try{
   store.recordCycle([{source:'plain',collected_at:100,payload:{value:1,timestamp:'a'}},{source:'plain',collected_at:101,payload:{value:1,timestamp:'b'}}]);
   expect(store.storageStats().payload_bodies).toBe(1);
   const replay=store.captureHistory('plain',20,2).capture;
   expect(replay.payload.timestamp).toBe('a');expect(replay.payload_note).toContain('not this one');
  }finally{store.close();}
 });
 it('rolls back the entire cycle and applies replay bounds',()=>{
  const store=new HistoryStore(':memory:',{...options,replayMaxBytes:5});try{
   expect(()=>store.recordCycle([outcome(1),{...outcome(2),source:''}])).toThrow();expect(store.storageStats().captures).toBe(0);
   store.recordCycle([outcome(1)]);expect(store.captureHistory('fixture',20,1).capture.payload).toBeNull();expect(store.captureHistory('fixture',20,1).capture.payload_outline).toHaveProperty('points');
  }finally{store.close();}
 });
 it('prunes by collected time rather than observation period',()=>{
  const store=new HistoryStore(':memory:',{payloadDays:1,captureDays:1,historyDays:1});try{
   store.recordCycle([outcome(1,1000)],1000);store.recordCycle([outcome(2,100000)],100000);
   expect(store.storageStats().captures).toBe(1);expect(store.seriesHistory('fixture:value').observations[0].observed_at).toBe('2024-01');
  }finally{store.close();}
 });
 it('rejects symlink database destinations',()=>{
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'history-link-'));try{symlinkSync(join(dir,'target'),join(dir,'link'));expect(()=>new HistoryStore(join(dir,'link'))).toThrow('symlinks');}finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('keeps handlers opt-in and exact tool names',()=>{
  const h=createHistoryHandlers(undefined);expect(Object.keys(h)).toEqual(['intel_collection_health','intel_capture_history','intel_series_history','intel_revisions']);
  expect(h.intel_capture_history!({})).toEqual({error:'source is required (a collector source name)'});expect(h.intel_collection_health!({})).toHaveProperty('error');
 });
});
describe('publisher dates and stable identity',()=>{
 it('rejects invented dates and naive timestamps, preserves periods',()=>{
  for(const bad of ['2023-02-29','2024-13','２０２４',true,'2024-01-01T12:00:00'])expect(normalizeObservedAt(bad)).toBeNull();
  expect(normalizeObservedAt('2024-02-29')).toBe('2024-02-29');expect(normalizeObservedAt('2024-01-01 12:00:00',true)).toBe('2024-01-01T12:00:00Z');expect(normalizeObservedAt('2024-01-01T12:00:00+02:00')).toBe('2024-01-01T10:00:00Z');
  expect(periodDate('2024-W01')).toBe('2024-01-07');expect(periodDate('2021-W53')).toBeNull();
 });
 it('ignores top-level metadata only',()=>{
  expect(payloadHash({a:1,timestamp:'a'})).toBe(payloadHash({timestamp:'b',a:1}));expect(payloadHash({a:{timestamp:'a'}})).not.toBe(payloadHash({a:{timestamp:'b'}}));
 });
});
describe.skipIf(!supportsSqlite)('upstream source extraction contracts',()=>{
 it('extracts publisher periods, ignores derived board rows, uses reverse repo own day',()=>{
 const store=new HistoryStore(':memory:',options);try{
 store.recordCycle([
 {source:'liquidity_board',collected_at:1,payload:{indicators:[{indicator:'m3',latest_value:2,observed_at:'2024-W01',previous_value:1,previous_observed_at:'2023-12',units:'EUR'},{indicator:'net_liquidity',latest_value:9,observed_at:'2024-01-01'}]}},
 {source:'net_liquidity',collected_at:1,payload:{units:'USD billions',points:[{value:3,fed_total_assets:6,treasury_general_account:2,reverse_repo:1,observed_at:'2024-01-03',reverse_repo_observed_at:'2024-01-02'}]}},
 {source:'net_migration',collected_at:1,payload:{top_net_immigration:[{iso3:'CAN',year:2024,net_migration:5}],world_regions:[{iso3:'CAN',year:2024,net_migration:5}]}},
 ]);
 expect(store.seriesHistory('liquidity_board:m3').observations).toHaveLength(2);
 expect(store.seriesHistory('liquidity_board:m3').observations[0].observed_at).toBe('2024-01-07');
 expect(store.seriesHistory('net_liquidity:reverse_repo').observations[0].observed_at).toBe('2024-01-02');
 expect(store.seriesHistory('net_migration:CAN').observations).toHaveLength(1);
 expect(store.seriesHistory(undefined,'liquidity_board').total_series).toBe(1);
 }finally{store.close();}
 });
 it('keeps quote dates unknown, skips curated policy rates and invalid publisher periods',()=>{
 const store=new HistoryStore(':memory:',options);try{
 store.recordCycle([
 {source:'market_quotes',collected_at:1,payload:{quotes:[{symbol:'^GSPC',price:5000,currency:'USD'}]}},
 {source:'central_bank_rates',collected_at:1,payload:{rates:[{source:'curated',bank:'ECB',rate:2,as_of:'2024-01-01'},{source:'fred',bank:'Fed',label:'Federal funds',rate:5,as_of:'2024-01-01'}]}},
 {source:'liquidity_board',collected_at:1,payload:{indicators:[{indicator:'bad',latest_value:1,observed_at:'unknown'}]}},
 ]);
 expect(store.seriesHistory('market_quotes:^GSPC:price').observations[0]).toMatchObject({observed_at:null,unit:'index points',label:'^GSPC (USD)'});
 expect(store.seriesHistory(undefined,'central_bank_rates').total_series).toBe(1);
 expect(store.captureHistory('liquidity_board').captures[0].extract_error).toBe('1 invalid point(s) skipped');
 }finally{store.close();}
 });
});
