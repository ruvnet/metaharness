import {describe,it,expect} from 'vitest';
import {createSecurityHandlers,createSecurityTransport,normalizeCyberFeed} from '../src/domains/security.js';
const now=()=>new Date('2026-11-17T00:00:00Z');
describe('native public security feeds',()=>{
 it('normalizes all four upstream feeds, severity then recency, counts only selected items',async()=>{
 const fixtures=[ [{ip_address:'192.0.2.1',status:'online',malware:'fixture',first_seen:'2026-11-01'}],{vulnerabilities:[{cveID:'CVE-fixture',vendorProject:'Example',product:'test',vulnerabilityName:'test',dateAdded:'2026-11-16',knownRansomwareCampaignUse:'Known'},{cveID:'old',dateAdded:'2026-10-17'}]},[{ip:'192.0.2.2',attacks:3,firstseen:'2026-11-16'},{attacks:1}],{urls:[{url:'https://example.invalid/test',url_status:'offline',dateadded:'2026-11-17'}]} ];let i=0;
 const h=createSecurityHandlers({now,transport:{json:async()=>fixtures[i++]}});const r:any=await h.intel_cyber_threats!({limit:3});
 expect(r.count).toBe(3);expect(r.feeds_successful).toBe(4);expect(r.threats.map((t:any)=>t.indicator)).toEqual(['CVE-fixture','192.0.2.1','192.0.2.2']);expect(r.by_severity).toEqual({critical:2,high:1});expect(r.threats[0].details.due_date).toBeNull();
 });
 it('uses inclusive 30-day boundary and handles missing feeds without invented data',async()=>{
 expect(normalizeCyberFeed('cisa-kev',{vulnerabilities:[{dateAdded:'2026-10-18'},{dateAdded:'2026-10-17'}]},now())).toHaveLength(1);
 const h=createSecurityHandlers({now,transport:{json:async()=>{throw new Error('offline');}}});const r:any=await h.intel_cyber_threats!({});expect(r).toMatchObject({count:0,feeds_successful:0,feeds_attempted:4,degraded:true});expect(r.data_gaps).toHaveLength(4);
 });
 it('filters HDX by lowercase group and shapes nullable organization and notes',async()=>{
 let captured='';const h=createSecurityHandlers({now,transport:{json:async url=>{captured=url.href;return {result:{results:[{name:'test',notes:'x'.repeat(201),organization:{title:'Example'}}]}};}}});
 const r:any=await h.intel_humanitarian_summary!({country:'CAN'});expect(new URL(captured).searchParams.get('fq')).toBe('groups:can');expect(r.datasets[0].notes).toHaveLength(203);expect(r.datasets[0].organization).toBe('Example');expect(r.timestamp).toBe('2026-11-17T00:00:00Z');
 });
 it('caps batches at 20, preserves request identifiers and omits missing aircraft',async()=>{
 let calls=0;const h=createSecurityHandlers({now,transport:{json:async()=>{calls++;return {Registration:'TEST'};}}});const r:any=await h.intel_aircraft_batch!({icao24_list:Array(30).fill('abc123')});expect(calls).toBe(20);expect(r.requested).toBe(20);expect(r.aircraft[0]).toMatchObject({icao24:'abc123',Registration:'TEST'});
 expect(await h.intel_aircraft_details!({icao24:'../../secret'})).toMatchObject({error:'invalid_icao24'});expect(calls).toBe(20);
 });
 it('restricts transport URLs, refuses redirects and bounds fetched JSON',async()=>{
 let calls=0;const transport=createSecurityTransport((async(_url:any,options:any)=>{calls++;expect(options.redirect).toBe('error');return new Response(JSON.stringify({ok:true}));}) as typeof fetch);
 await expect(transport.json(new URL('https://example.com/private'))).rejects.toThrow('Unapproved');
 const url=new URL('https://hexdb.io/api/v1/aircraft/abc123');expect(await transport.json(url)).toEqual({ok:true});expect(await transport.json(url)).toEqual({ok:true});expect(calls).toBe(1);
 });
});
