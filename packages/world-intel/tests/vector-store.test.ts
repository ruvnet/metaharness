import {realpathSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {NativeVectorStore,vectorDataText,type EmbeddingProvider} from '../src/vector-store.js';
import {createVectorHandlers} from '../src/domains/vector.js';
const [major,minor]=process.versions.node.split('.').map(Number);const supported=major!>22||(major===22&&minor!>=13);
const fixture:EmbeddingProvider={model:'fixture-not-bge',dimensions:2,embed:async text=>text.includes('quake')?[1,0]:[0,1]};const now=()=>1000000;
describe.skipIf(!supported)('native vector archive with explicit fixture embeddings',()=>{
 it('persists archive and rejects embedding-space changes',async()=>{
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'vector-'));let store=new NativeVectorStore(join(dir,'db.sqlite'),{embedding:fixture,now});try{await store.store('usgs',{summary:'A strong quake occurred',count:3,country:'Test'});store.close();store=new NativeVectorStore(join(dir,'db.sqlite'),{embedding:fixture,now});expect(store.collectionStats()).toMatchObject({points_count:1,embedding_model:'fixture-not-bge',backend:'sqlite'});expect(()=>new NativeVectorStore(join(dir,'db.sqlite'),{embedding:{...fixture,model:'other'}})).toThrow('differ');}finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('uses cosine with filters, cross-domain matching and honest missing provider errors',async()=>{
 const store=new NativeVectorStore(':memory:',{embedding:fixture,now});try{await store.store('usgs',{summary:'quake reported',count:2});await store.store('news',{summary:'quake in the news',count:1});await store.store('markets',{summary:'Stocks rally',count:5});expect(await store.store('markets',{error:'failed'})).toBe(false);
 const results:any=await store.semanticSearch('quake',10);expect(results.results[0].score).toBe(1);expect(results.results.at(-1).score).toBe(0);expect((await store.semanticSearch('quake',10,'usgs')).count).toBe(1);expect((await store.findSimilar('markets','quake')).count).toBe(3);expect((await store.crossCorrelate('quake',24,1)).domains_found).toBe(3);
 }finally{store.close();}const missing=new NativeVectorStore(':memory:');try{expect(await missing.semanticSearch('test')).toHaveProperty('error');await expect(missing.store('news',{summary:'A sufficiently long news story'})).rejects.toThrow('not configured');}finally{missing.close();}
 });
 it('preserves upstream earliest-scroll then descending timeline subset and summary',async()=>{
 const s=new NativeVectorStore(':memory:',{embedding:fixture,now});try{for(let i=0;i<4;i++)await s.store('news',{summary:'A long story number '+i,count:i},now()-4+i);const timeline:any=s.timeline(undefined,undefined,24,2);expect(timeline.entries.map((x:any)=>x.timestamp)).toEqual([now()-3,now()-4]);expect(s.domainSummary().summary[0]).toMatchObject({data_points:4,total_events_tracked:6});expect(Object.keys(createVectorHandlers(s))).toHaveLength(7);}finally{s.close();}
 });
 it('detects surge/drop and counts shared window boundary as upstream does',async()=>{
 const s=new NativeVectorStore(':memory:',{embedding:fixture,now});try{await s.store('usgs',{summary:'quake baseline'},now()-24*3600);for(let i=0;i<4;i++)await s.store('usgs',{summary:'quake recent '+i},now()-i);await s.store('news',{summary:'old news with enough text'},now()-24*3600);const r=s.trendDetection();expect(r.trends.find(x=>x.category==='Natural Disasters')?.trend).toBe('SURGE');expect(r.trends.find(x=>x.category==='News & Media')?.trend).toBe('DROP');}finally{s.close();}
 });
 it('rejects nonfinite/wrong-dimension embeddings and bounded-scan overflow',async()=>{
 const bad=new NativeVectorStore(':memory:',{embedding:{...fixture,embed:async()=>[NaN,0]},now});try{await expect(bad.store('news',{summary:'Long enough data payload'})).rejects.toThrow('finite');}finally{bad.close();}const s=new NativeVectorStore(':memory:',{embedding:fixture,now,maxSearchPoints:1});try{await s.store('news',{summary:'long first fixture'},now());await s.store('news',{summary:'long second fixture'},now()+1);expect(await s.semanticSearch('fixture')).toHaveProperty('error');}finally{s.close();}
 });
});
it('extracts the first recognized payload list and top-level context only',()=>{expect(vectorDataText('news',{events:[{title:'First',country:'Test'}],items:[{title:'Ignored'}],source:'rss',count:2})).toBe('Domain: news | First | Test | source: rss | count: 2');});
