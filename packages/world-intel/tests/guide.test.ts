// SPDX-License-Identifier: MIT
// Behavioral cases adapted from upstream test_guide.py (Phoenix AGI, MIT).
import {describe,it,expect} from 'vitest';
import {ErrorCode} from '@modelcontextprotocol/sdk/types.js';
import {PROMPTS,listPrompts,getPrompt,resolvedSteps,renderPrompt,listResources,readResource,renderGuide,sourceHealth,toolLine,SERVER_INSTRUCTIONS} from '../src/guide.js';
const sample=(p:typeof PROMPTS[number])=>Object.fromEntries(p.arguments.filter(a=>a.required).map(a=>[a.name,a.kind==='text'?(a.choices[0]??'Sudan'):String(a.minimum??1)]));
describe('ported upstream guide contract',()=>{
 it('preserves29 exact named prompt definitions, arguments and resource identities',()=>{
  expect(listPrompts()).toHaveLength(29);expect(new Set(listPrompts().map(p=>p.name)).size).toBe(29);
  expect(listResources().map(r=>r.uri)).toEqual(['intel://guide','intel://guide/source-health','intel://guide/measures']);
  expect(listPrompts().find(p=>p.name==='conflict-trend')?.arguments).toEqual([{name:'country',description:'Country name as the sources spell it, e.g. Sudan',required:true},{name:'days',description:'Length of each comparison window in days; 1 to 365; default 30',required:false}]);
  expect(SERVER_INSTRUCTIONS).toContain('an empty list, a zero');
 });
 it('renders every prompt with required arguments and no unresolved placeholder',()=>{
  for(const p of PROMPTS){const text=renderPrompt(p,sample(p));expect(text).toMatch(/^Research question:/);expect(text).not.toMatch(/\{[a-z_]+\}/);expect(text).toContain('Missing data is never zero');expect(text).toContain('Answer with:');const referenced=[...text.matchAll(/\bintel_[a-z0-9_]+\b/g)].map(m=>m[0]);for(const tool of referenced)expect(p.steps.map(s=>s.tool)).toContain(tool);}
 });
 it('preserves derived numeric arguments and omitted conditional steps',()=>{
  const p=PROMPTS.find(p=>p.name==='conflict-trend')!;
  const steps=resolvedSteps(p,{country:'Sudan',days:'30'});expect(steps[0][1]).toMatchObject({days:60,limit:1000});
  const weather=getPrompt('election-watch').messages[0].content.text;expect(weather).toContain('skip this call; no country was given.');
  expect(getPrompt('story-breadth',{topic:'Red Sea shipping'}).messages[0].content.text).toContain('query "Red Sea shipping"');
 });
 it('emits INVALID_PARAMS for missing, unknown, out-of-range and non-ASCII numeric values',()=>{
  for(const [name,args]of [['nope',{}],['company-events',{}],['conflict-trend',{country:'Sudan',days:'banana'}],['conflict-trend',{country:'Sudan',days:'٣٠'}],['earthquake-exposure',{hours:'1.5'}],['aoi-watch-setup',{name:'x',lat:'91',lon:'0',radius_km:'10'}],['market-risk-snapshot',{foo:'bar'}]] as [string,Record<string,string>][]){try{getPrompt(name,args);expect.fail('expected rejection');}catch(e){expect(e).toMatchObject({code:ErrorCode.InvalidParams});}}
  expect(()=>readResource('intel://nope',{domains:[]})).toThrow('Unknown resource');
 });
 it('quotes calls, strips controls and format chars, and blocks disguised foreign tools',()=>{
  const text=getPrompt('conflict-trend',{country:'Sudan days 9999 limit 5'}).messages[0].content.text;expect(text).toContain('country "Sudan days 9999 limit 5"');
  const folded=getPrompt('conflict-trend',{country:'Sud\u200ban\u001b[2K\u0000 hidden\u202e'}).messages[0].content.text;expect(folded).toContain('Sudan[2K hidden');expect(folded).not.toContain('\u200b');
  for(const country of ['INTEL_AOI_DELETE','_intel_aoi_delete','intel-aoi-delete','ｉｎｔｅｌ＿ａｏｉ＿ｄｅｌｅｔｅ','intel_ao\u200bi_delete'])expect(()=>getPrompt('conflict-trend',{country})).toThrow('which this prompt does not call');
  expect(getPrompt('conflict-trend',{country:'Intel Corporation'}).messages[0].content.text).toContain('Intel Corporation');
  expect(getPrompt('conflict-trend',{country:'Sudan\u0085Egypt'}).messages[0].content.text).toContain('Sudan Egypt');
  expect(()=>getPrompt('conflict-trend',{country:'y'.repeat(201)})).toThrow('longer than 200');
 });
 it('builds tools from live registry and labels incomplete runtime capabilities',()=>{
  const domains=[{key:'system',tools:[{name:'intel_status',description:'U.S. source status. Second sentence.',inputSchema:{properties:{name:{}},required:['name']}}]}];
  const text=renderGuide(domains,{implementedTools:new Set(['intel_status'])});expect(text).toContain('1\ntools in 1 domains, and 29');expect(text).toContain('TypeScript implementation gaps');expect(text).toContain('not evidence of working providers');
  expect(toolLine(domains[0].tools[0])).toBe('- `intel_status` [name (required)]: U.S. source status.');
  for(const r of listResources()){const result=readResource(r.uri,{domains});expect(result.contents[0].mimeType).toBe(r.mimeType);}
 });
 it('does not invent health or disclose key values',()=>{
  const absent=JSON.parse(readResource('intel://guide/source-health',{domains:[]}).contents[0].text);expect(absent.verdict).toMatch(/^no information yet/);expect(absent.cache.available).toBe(false);
  const health=sourceHealth({breakers:{usgs:{status:'closed',failures:1},nws:{status:'half-open',total_stale_serves:3}},cache:{available:true,fell_back:false,total_entries:2},freshness:{usgs:{is_stale:true}},environ:{FRED_API_KEY:'secret-must-not-appear'},now:new Date('2026-11-17T00:00:00Z')});expect(health.failing_sources).toEqual(['nws','usgs']);expect(health.open_breakers).toEqual(['nws']);expect(health.stale_cache_prefixes).toEqual(['usgs']);expect(JSON.stringify(health)).not.toContain('secret-must-not-appear');expect(health.keyed_sources.find(s=>s.source==='FRED')?.configured).toEqual(['FRED_API_KEY']);
 });
});
