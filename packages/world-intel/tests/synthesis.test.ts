import {realpathSync} from 'node:fs';
// SPDX-License-Identifier: MIT
import {describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {extractEntities,classifyEvent,clusterArticles,newsClusters,KeywordSpikeDetector,SqliteBaselineStore,createSynthesisHandlers} from '../src/domains/synthesis.js';
const now=()=>new Date('2026-11-17T00:00:00Z');
describe('native synthesis ports',()=>{
 it('matches longest entities and country plurals without substring false positives',()=>{
  const r=extractEntities('Americans meet Vladimir Putin and the United Nations. Apple tracks CVE-2026-12345 and APT28. thousand usable apples.',now);
  expect(r.entities.countries.map(c=>c.iso3)).toContain('USA');expect(r.entities.leaders.map(l=>l.name)).toEqual(['Vladimir Putin']);expect(r.entities.organizations.map(o=>o.name)).toEqual(['UN']);expect(r.entities.companies.map(c=>c.name)).toEqual(['Apple']);expect(r.entities.cves).toEqual(['CVE-2026-12345']);expect(r.entities.apt_groups).toContain('apt28');
 });
 it('preserves keyword classifier boundaries, ranking, severity and output shape',()=>{
  expect(classifyEvent('patriotic portfolio couple regimen carbonated deadline aptitude denied',now)).toMatchObject({primary_category:'unclassified',severity:0,category_count:0});
  const r=classifyEvent('nuclear warhead radiation emergency',now);expect(r).toMatchObject({primary_category:'nuclear',severity:10,confidence:.9,source:'keyword-classifier'});expect(r.all_categories[0].keywords).toEqual(['nuclear','warhead','radiation']);
 });
 it('uses representative-based clustering, distinct publisher mapping and outage passthrough',()=>{
  const items=[{title:'Major earthquake strikes city',feed_name:'A',link:'a'},{title:'Earthquake strikes city today',feed_name:'B',link:'b'},{title:'Unrelated economy discussion'}];
  expect(clusterArticles(items,.3).map(c=>c.member_count)).toEqual([2,1]);
  const r=newsClusters({items,feeds_failed:1,degraded:true},.3,now,()=> 'one publisher');expect(r).toMatchObject({cluster_count:1,singleton_count:1,total_items:3,degraded:true,feeds_failed:1});expect(r.clusters[0]).toMatchObject({outlet_count:1,size:2});
 });
 it.skipIf(Number(process.versions.node.split('.')[0])<22 || (Number(process.versions.node.split('.')[0])===22 && Number(process.versions.node.split('.')[1])<13))('warms baselines, detects ratio/z spikes, and persists compatible SQLite rows',()=>{
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'intel-spikes-'));const path=join(dir,'kw.db');let store=new SqliteBaselineStore(path);let detector=new KeywordSpikeDetector(store,now);
  for(let i=0;i<3;i++)expect(detector.detect({quake:2})).toEqual([]);expect(detector.detect({quake:8})).toEqual([{keyword:'quake',current_count:8,baseline_mean:2,ratio:4,z_score:null,detection:'ratio'}]);store.close();store=new SqliteBaselineStore(path);expect(store.get('quake')[0]).toBe(4);detector=new KeywordSpikeDetector(store,now);expect(detector.detect({quake:30})[0].detection).toBe('z_score');store.close();rmSync(dir,{recursive:true});
 });
 it('uses actual injected news dependencies, with no fabricated feed',async()=>{
  let requests=0;const handlers=createSynthesisHandlers({now,newsFeed:async()=>{requests++;return {items:[{title:'CVE-2026-12345 APT28 Ukraine'}]};},trendingKeywords:async()=>({keywords:[{keyword:'ukraine',count:3}]})});
  expect(await handlers.intel_extract_entities({})).toMatchObject({input_source:'news_feed',items_analyzed:1});expect(await handlers.intel_keyword_spikes({})).toMatchObject({cve_mentions:['CVE-2026-12345'],apt_mentions:['apt28'],keywords_analyzed:1});expect(requests).toBe(2);
 });
});
