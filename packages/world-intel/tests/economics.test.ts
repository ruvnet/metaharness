import {describe,it,expect,vi} from 'vitest';
import {createEconomicsHandlers,resolveMigrationPlace,validateMigrationUrl,UNHCR_MEASURE} from '../src/domains/economics.js';
const NOW=Date.parse('2026-11-17T12:00:00Z');
const countries=[{iso:'SYR',iso2:'SY',name:'Syrian Arab Rep.',region:'Western Asia',majorArea:'Asia'},{iso:'TUR',iso2:'TR',name:'Türkiye',region:'Western Asia',majorArea:'Asia'},{iso:'DEU',iso2:'DE',name:'Germany',region:'Western Europe',majorArea:'Europe'},{iso:'UNK',name:'Unknown'},{iso:'XXA',name:'Stateless'}];
const row=(coo_iso:string,coa_iso:string,refugees:number,extra={})=>({coo_iso,coa_iso,refugees,...extra});
const current=[row('SYR','TUR',600000,{asylum_seekers:'50000',oip:'-' }),row('SYR','DEU',100000),row('SYR','SYR',0,{idps:300000}),row('UNK','DEU',800000),row('TUR','DEU',20000)];
const prior=[row('SYR','TUR',100000),row('SYR','DEU',200000),row('TUR','DEU',20000)];
const wbCountry=(id:string,name:string,region='ECS',aggregate=false)=>({id,name,iso2Code:id==='SYR'?'SY':'DE',region:{id:aggregate?'NA':region,value:region==='ECS'?'Europe & Central Asia':'Middle East'},incomeLevel:{value:'High'},capitalCity:'Capital',latitude:'1.2',longitude:'3.4'});
const metas=[wbCountry('SYR','Syria','MEA'),wbCountry('DEU','Germany'),wbCountry('WLD','World','NA',true)];
const indicator=(iso:string,value:number|null,date='2025')=>({countryiso3code:iso,value,date});
function setup(custom?:(u:URL)=>unknown,extra={}) {
 const fetch=vi.fn(async(input:any)=>{const u=new URL(input);let data=custom?.(u);if(data===undefined){
  if(u.pathname.endsWith('/countries/'))data={items:countries,maxPages:1};
  else if(u.hostname==='api.unhcr.org')data={items:u.searchParams.get('yearFrom')==='2024'?prior:current,maxPages:1};
  else if(u.pathname.endsWith('/country'))data=[{pages:1},metas];
  else data=[{pages:1},[indicator('SYR',10000000),indicator('DEU',80000000)]];
 }return new Response(JSON.stringify(data));});
 return {fetch,h:createEconomicsHandlers({fetch,now:()=>NOW,...extra})};
}
describe('migration native contracts',()=>{
 it('registers five actual source handlers',()=>expect(Object.keys(createEconomicsHandlers())).toHaveLength(5));
 it('flows use ISO disambiguation, totals before limit, and prior stock changes',async()=>{
  const {h,fetch}=setup();const r:any=await h.intel_migration_flows!({origin:'SY',year:2025,limit:1});
  expect(r).toMatchObject({year:2025,origin_filter:{kind:'country',name:'Syria'},destination_filter:null,total_people:750000,corridor_count:2,prior_year_available:true,measure:UNHCR_MEASURE,source:'unhcr',timestamp:'2026-11-17T12:00:00Z'});
  expect(r.corridors).toEqual([{origin:'Syria',origin_iso3:'SYR',destination:'Türkiye',destination_iso3:'TUR',people:650000,refugees:600000,asylum_seekers:50000,other_in_need_of_protection:0,prior_year_people:100000,change:550000}]);
  expect(r.top_origins).toEqual([{name:'Syria',iso3:'SYR',people:750000,corridors:2}]);
  expect(fetch.mock.calls.filter(([u])=>new URL(u).pathname.endsWith('/population/')).every(([u])=>new URL(u).searchParams.get('cf_type')==='ISO')).toBe(true);
 });
 it('flows fallback from empty previous year and filter region/min people',async()=>{
  const {h}=setup(u=>u.pathname.endsWith('/population/')&&u.searchParams.get('yearFrom')==='2025'?{items:[],maxPages:1}:undefined);
  const r:any=await h.intel_migration_flows!({destination:'Europe',min_people:30000});expect(r.year).toBe(2024);expect(r.corridors).toHaveLength(1);expect(r.corridors[0].destination_iso3).toBe('DEU');expect(r.total_people).toBe(200000);
 });
 it('missing prior year is unknown, not zero',async()=>{const {h}=setup(u=>u.searchParams.get('yearFrom')==='2024'?{items:[],maxPages:1}:undefined);const r:any=await h.intel_migration_flows!({year:2025});expect(r.prior_year_available).toBe(false);expect(r.corridors[0].change).toBeNull();});
 it('surges exclude unknown origin from rankings and identify first-reported IDPs',async()=>{const {h}=setup();const r:any=await h.intel_migration_surges!({year:2025});expect(r.origin_outflow_increases[0]).toMatchObject({origin:'Syria',people_abroad:750000,prior_year_people_abroad:300000,change_abroad:450000,idps:300000,change_idps:300000,idps_first_reported:true,population:10000000,change_abroad_pct_of_population:4.5,level:'mass'});expect(r.unattributed_origin_changes[0].origin_iso3).toBe('UNK');expect(r.corridor_decreases[0].change).toBe(-100000);expect(r.corridor_increases.some((x:any)=>x.origin_iso3==='UNK')).toBe(false);expect(r.levels.basis).toContain('not a UNHCR classification');});
 it('surges expose missing comparison year',async()=>{const {h}=setup(u=>u.searchParams.get('yearFrom')==='2024'?{items:[],maxPages:1}:undefined);expect(await h.intel_migration_surges!({})).toMatchObject({degraded:true,reason:'no_comparison_year'});});
 it('history aggregates years, sorts and does not calculate waves across gaps',async()=>{
  const {h,fetch}=setup(u=>u.pathname.endsWith('/population/')?{items:[{year:2020,refugees:100},{year:2021,refugees:150},{year:2021,asylum_seekers:50,idps:30},{year:2023,refugees:1000}],maxPages:1}:undefined);
  const r:any=await h.intel_migration_history!({country:'Syria',role:'host',year_from:2020,year_to:2023});expect(r.years).toBe(3);expect(r.peak).toEqual({year:2023,people:1000});expect(r.largest_waves).toEqual([{year:2021,increase:100,people:200,pct_change:100}]);expect(r.series[1].idps).toBe(30);expect(fetch.mock.calls.some(([u])=>new URL(u).searchParams.get('coa')==='SYR')).toBe(true);
 });
 it('history errors are explicit for region, role and reversed range',async()=>{const {h}=setup();expect(await h.intel_migration_history!({country:'Europe'})).toHaveProperty('error',"'Europe' is a region; history needs one country");expect(await h.intel_migration_history!({country:'SYR',role:'invalid'})).toHaveProperty('error');expect(await h.intel_migration_history!({country:'SYR',year_from:2025,year_to:2020})).toHaveProperty('error');});
 it('country resolution supports aliases and rejects ambiguous names',()=>{const cc={AAA:{name:'Example One',names:[],iso2:'AA',region:'R'},BBB:{name:'Example Two',names:['alias'],iso2:'BB',region:'R'}};expect(resolveMigrationPlace('alias',cc).label).toBe('Example Two');expect(resolveMigrationPlace('R',cc).codes.size).toBe(2);expect(()=>resolveMigrationPlace('Example',cc)).toThrow('ambiguous');expect(()=>resolveMigrationPlace('no',cc)).toThrow('unknown');});
 it('UNHCR pagination is all-or-nothing and bounded',async()=>{const {h}=setup(u=>u.pathname.endsWith('/population/')?{items:current,maxPages:11}:undefined);expect(await h.intel_migration_flows!({year:2025})).toMatchObject({degraded:true,reason:'unhcr_fetch_failed'});});
 it('merges pages without duplication and caches defensive copies',async()=>{const {h,fetch}=setup(u=>u.pathname.endsWith('/population/')?{items:u.searchParams.get('page')==='1'?[current[0]]:[current[1]],maxPages:2}:undefined);const r:any=await h.intel_migration_flows!({year:2025});expect(r.total_people).toBe(750000);r.corridors[0].people=-1;const n=fetch.mock.calls.length;const next:any=await h.intel_migration_flows!({year:2025});expect(next.corridors[0].people).toBe(650000);expect(fetch.mock.calls.length).toBe(n);});
});
describe('World Bank and displacement',()=>{
 it('net migration ranking separates aggregates and applies region codes',async()=>{const {h}=setup(u=>u.pathname.endsWith('/SM.POP.NETM')?[{pages:1},[indicator('SYR',-100),indicator('DEU',200),indicator('WLD',100)]]:undefined);const r:any=await h.intel_net_migration!({});expect(r.net_total).toBe(100);expect(r.countries).toBe(2);expect(r.top_net_emigration[0].iso3).toBe('SYR');expect(r.world_regions[0].iso3).toBe('WLD');const region:any=await h.intel_net_migration!({region:'ECS'});expect(region.countries).toBe(1);expect(region.world_regions).toEqual([]);});
 it('net country history preserves zero, excludes null, and sorts',async()=>{const {h}=setup(u=>u.pathname.endsWith('/SM.POP.NETM')?[{pages:1},[indicator('SYR',100,'2025'),indicator('SYR',-20,'2023'),indicator('SYR',0,'2024'),indicator('SYR',null,'2022')]]:u.pathname.endsWith('/SP.POP.TOTL')?[{pages:1},[indicator('SYR',1000,'2025')]]:undefined);const r:any=await h.intel_net_migration!({country:'SY'});expect(r.series).toEqual([{year:2023,net_migration:-20,per_1000:null},{year:2024,net_migration:0,per_1000:null},{year:2025,net_migration:100,per_1000:100}]);expect(r.largest_net_outflow_years).toHaveLength(1);});
 it('displacement uses Tier1 names, safe numeric conversion and all-origin totals',async()=>{const {h}=setup(u=>u.pathname.endsWith('/population/')?{items:[{coo_iso:'SYR',coo_name:'Syrian Arab Rep.',refugees:'10',asylum_seekers:'-',idps:20,stateless:2,ooc:1},{coo_iso:'SYR',refugees:5},{coo_iso:'DEU',refugees:3}]}:undefined);const r:any=await h.intel_displacement_summary!({});expect(r.by_origin[0]).toEqual({country:'Syria',iso3:'SYR',refugees:15,asylum_seekers:0,internally_displaced:20,stateless:2,others_of_concern:1,total_displaced:38});expect(r.global_totals.grand_total).toBe(41);expect(r.count).toBe(2);});
 it('displacement outage differs from actual zero',async()=>{const {h}=setup(()=>null);expect(await h.intel_displacement_summary!({})).toMatchObject({degraded:true,reason:'unhcr_fetch_failed',count:0,global_totals:{grand_total:0}});});
 it('World Bank outage marks degradation',async()=>{const {h}=setup(()=>null);expect(await h.intel_net_migration!({})).toMatchObject({source:'worldbank',degraded:true});});
});
describe('source transport boundaries',()=>{
 it('rejects malicious URL variants',()=>{for(const u of ['https://api.unhcr.org:8443/population/v1/countries/','https://x:pw@api.unhcr.org/population/v1/countries/','https://api.unhcr.org/population/v1/countries/#x','https://api.unhcr.org.evil.test/population/v1/countries/','https://api.worldbank.org/v2/country/all/indicator/OTHER'])expect(()=>validateMigrationUrl(new URL(u))).toThrow();});
 it('deadlines hung fetch and caps response size',async()=>{const h=createEconomicsHandlers({fetch:vi.fn(()=>new Promise(()=>{})),timeoutMs:5,now:()=>NOW});expect(await h.intel_migration_flows!({})).toMatchObject({degraded:true});const c=setup(()=>({items:countries}),{maxBytes:2});expect(await c.h.intel_migration_flows!({})).toMatchObject({degraded:true});});
 it('does not dispatch invalid numeric bounds',async()=>{const {h,fetch}=setup();await expect(h.intel_migration_flows!({limit:10001})).rejects.toThrow();await expect(h.intel_migration_surges!({year:9999})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();});
});
// These cases preserve numeric assertions from the pinned MIT upstream tests,
// using statically extracted fixture literals rather than executing Python.
import {readFileSync} from 'node:fs';
const golden=JSON.parse(readFileSync(new URL('./fixtures/migration-upstream.json',import.meta.url),'utf8'));
function upstream(){return setup(u=>{
 if(u.pathname.endsWith('/countries/'))return golden._COUNTRIES;
 if(u.hostname==='api.unhcr.org')return {maxPages:1,items:u.searchParams.get('coo')==='SYR'?golden._HISTORY_SYR:golden._PAIRS[u.searchParams.get('yearFrom')!]??[]};
 if(u.pathname.endsWith('/country'))return golden._WB_COUNTRIES;
 const code=u.pathname.split('/').at(-1)!;return [{pages:1},Object.entries(golden._WB_LATEST[code]).map(([iso,value])=>({countryiso3code:iso,date:'2025',value}))];
});}
it('pinned upstream flows and annual wave assertions match',async()=>{const {h}=upstream();const r:any=await h.intel_migration_flows!({year:2025,origin:'SYR'});expect(r.corridors.map((c:any)=>c.destination_iso3)).toEqual(['TUR','DEU']);expect(r.corridors[0]).toMatchObject({people:2000000,prior_year_people:2900000,change:-900000});expect(r.total_people).toBe(2660000);const hist:any=await h.intel_migration_history!({country:'SYR',year_from:2011,year_to:2014});expect(hist.peak).toEqual({year:2014,people:3887000});expect(hist.largest_waves[0]).toEqual({year:2013,increase:1671000,people:2400000,pct_change:229.2});});
it('pinned upstream surge rankings and percentages match',async()=>{const {h}=upstream();const r:any=await h.intel_migration_surges!({year:2025});expect(r.origin_outflow_increases.map((o:any)=>o.origin_iso3)).toEqual(['SDN']);expect(r.origin_outflow_increases[0]).toMatchObject({change_abroad:800000,population:50000000,change_abroad_pct_of_population:1.6,level:'mass',change_idps:-2000000});expect(r.origin_outflow_decreases[0]).toMatchObject({origin_iso3:'SYR',change_abroad:-950000,level:null});expect(r.unattributed_origin_changes.map((o:any)=>o.origin_iso3)).toEqual(['UNK']);});
it('pinned upstream WB aggregate exclusion and rate ranking assertions match',async()=>{const {h}=upstream();const r:any=await h.intel_net_migration!({});expect(r.countries).toBe(4);expect(r.net_total).toBe(270000);expect(r.top_net_immigration.map((o:any)=>o.iso3)).toEqual(['SYR','SDN']);expect(r.top_net_emigration.map((o:any)=>o.iso3)).toEqual(['DEU','TCD']);expect(r.top_net_immigration[0]).toMatchObject({per_1000:16,migrant_stock_pct:3.6});expect(r.highest_rate_emigration[0].iso3).toBe('TCD');expect(r.world_regions.map((o:any)=>o.iso3)).toEqual(['WLD','SSF']);});
