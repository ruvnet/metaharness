import {describe,it,expect} from 'vitest';
import {createConflictHandlers,createConflictTransport,type ConflictTransport} from '../src/domains/conflict.js';
const now=()=>new Date('2026-11-17T00:00:00Z');
const transport:ConflictTransport={token:async()=>({access_token:'fixture-token',expires_in:86400}),get:async()=>null};
describe('ACLED native contract',()=>{
 it('distinguishes missing, refused and fetch failure without exposing credentials',async()=>{
 const a=createConflictHandlers({now,transport});expect(await a.intel_acled_events!({})).toMatchObject({reason:'acled_unconfigured'});
 const b=createConflictHandlers({now,credentials:{acledEmail:'test',acledPassword:'secret'},transport:{...transport,token:async()=>{throw new Error('secret');}}});const failure:any=await b.intel_acled_events!({});expect(failure.reason).toBe('acled_auth_failed');expect(JSON.stringify(failure)).not.toContain('secret');
 const c=createConflictHandlers({now,credentials:{acledEmail:'test',acledPassword:'secret'},transport});expect(await c.intel_acled_events!({})).toMatchObject({reason:'acled_fetch_failed',degraded:true});
 });
 it('shares in-flight sign-in, passes bounded query, retains stale provenance and stable sorting',async()=>{
 let signs=0;const h=createConflictHandlers({now,credentials:{acledEmail:'test',acledPassword:'secret'},transport:{token:async()=>{signs++;return {access_token:'token',expires_in:86400};},get:async(url,headers)=>{expect(url.searchParams.get('event_date')).toBe('2026-11-10|2026-11-17');expect(headers.Authorization).toBe('Bearer token');return {data:{data:[{event_id_cnty:'a',fatalities:'2',event_date:'2026-11-01'},{event_id_cnty:'b',fatalities:2,event_date:'2026-11-16'},{event_id_cnty:'c',fatalities:3}]},fetchedAt:now().getTime()/1000-100,staleAgeSeconds:100};}}});
 const [a]:any[]=await Promise.all([h.intel_acled_events!({}),h.intel_acled_events!({})]);expect(signs).toBe(1);expect(a.events.map((x:any)=>x.event_id_cnty)).toEqual(['c','b','a']);expect(a).toMatchObject({_stale:true,_stale_age_seconds:100,fetched_at:'2026-11-16T23:58:20Z'});
 });
 it('falls back from rejected refresh to password without recursive lock',async()=>{
 const grants:string[]=[];const h=createConflictHandlers({now,credentials:{acledEmail:'test',acledPassword:'secret',acledRefreshToken:'old'},transport:{...transport,token:async form=>{grants.push(form.get('grant_type')!);if(grants.length===1)throw new Error('refused');return {access_token:'new'};},get:async()=>({data:{data:[]}})}});
 expect(await h.intel_acled_events!({})).toMatchObject({count:0});expect(grants).toEqual(['refresh_token','password']);
 });
});
describe('UCDP native paginated contract',()=>{
 it('fetches all pages despite page-size limit, marks failed pages and filters dates',async()=>{
 const calls:number[]=[];const h=createConflictHandlers({now,credentials:{ucdpAccessToken:'fixture'},transport:{...transport,get:async(url,headers)=>{expect(headers['x-ucdp-access-token']).toBe('fixture');expect(url.searchParams.get('pagesize')).toBe('1');const p=Number(url.searchParams.get('page'));calls.push(p);return p===1?null:{data:{TotalPages:3,Result:[{id:p,date_start:'2026-11-01',best:'2',type_of_violence:'3'},{id:10,date_start:'2026-01-01'},{id:11,date_start:'2026-02-30'}]}};}}});
 const r:any=await h.intel_ucdp_events!({limit:1});expect(calls).toEqual([0,1,2]);expect(r).toMatchObject({count:2,total_fatalities_best:4,reason:'ucdp_partial',pages_failed:[1],pages_total:3});expect(r.events[0].type_of_violence_label).toBe('one-sided');
 });
 it('never presents a refused first page as peace',async()=>{
 const h=createConflictHandlers({now,transport});expect(await h.intel_ucdp_events!({})).toMatchObject({degraded:true,reason:'ucdp_unconfigured',count:0});
 });
 it('bounds oversized pagination explicitly and surfaces stale pages',async()=>{
 let calls=0;const h=createConflictHandlers({now,maxPages:2,transport:{...transport,get:async()=>{calls++;return {data:{TotalPages:5,Result:[]},staleAgeSeconds:10};}}});const r:any=await h.intel_ucdp_events!({});expect(calls).toBe(2);expect(r.pages_failed).toEqual([2,3,4]);expect(r._stale).toBe(true);expect(r.data_gaps.join(' ')).toContain('Safety page budget');
 });
 it('restricts credential-bearing transport to exact source endpoints',async()=>{
 let calls=0;const t=createConflictTransport((async()=>{calls++;return new Response('{}');}) as typeof fetch);await expect(t.get(new URL('https://example.com/api'),{Authorization:'secret'},10)).rejects.toThrow('Unapproved');expect(calls).toBe(0);
 });
});
