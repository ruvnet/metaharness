import {describe,it,expect} from 'vitest';
import {createStrategicHandlers,nuclearConcern,parseFleetFeed,extractFleetData,NUCLEAR_SITES} from '../src/domains/strategic.js';
const now=()=>new Date('2026-11-17T00:00:00Z');
describe('strategic upstream contracts',()=>{
 it('scores bounded seismic concern by magnitude depth proximity and site status',()=>{
 expect(nuclearConcern(5,1,0,'active')).toEqual({concern_score:100,concern_level:'critical'});expect(nuclearConcern(1,50,90,'closed')).toEqual({concern_score:13,concern_level:'low'});
 });
 it('queries all five sites, filters radius, preserves upstream per-site cap',async()=>{
 let i=0;const h=createStrategicHandlers({now,transport:{text:async()=>'',json:async url=>{expect(url.searchParams.get('starttime')).toBe('2026-11-14T00:00:00');const s=NUCLEAR_SITES[i++]!;return {features:[...Array.from({length:7},()=>({geometry:{coordinates:[s.lon,s.lat,1]},properties:{mag:5,time:0}})),{geometry:{coordinates:[0,0,2]},properties:{mag:5}}]};}}});const r:any=await h.intel_nuclear_monitor!({});expect(i).toBe(5);expect(r.sites[0].events_detected).toBe(7);expect(r.total_flagged_events).toBe(25);expect(r.flagged_events).toHaveLength(20);
 });
 it('marks seismic source outages unknown, not zero',async()=>{
 const h=createStrategicHandlers({now,transport:{text:async()=>'',json:async()=>{throw new Error('offline');}}});const r:any=await h.intel_nuclear_monitor!({});expect(r.degraded).toBe(true);expect(r.data_gaps).toHaveLength(5);
 });
 it('extracts USS vessels, groups and totals from first full RSS article',()=>{
 const r=parseFleetFeed('<rss><channel><item><title>Fleet &amp; Marine</title><link>https://example.com/report</link><pubDate>today</pubDate><content:encoded><![CDATA[<p>Pacific USS Test (CVN-99). USS Test (CVN-99). Carrier Strike Group 4. 300 ships (250 USS, 50 USNS) 50 deployed (40 USS, 10 USNS) 20 underway (10 deployed, 10 local)</p>]]></content:encoded></item></channel></rss>');expect(r.report_title).toBe('Fleet & Marine');expect(r.ship_count).toBe(1);expect(r.ships[0]).toMatchObject({name:'USS Test',type:'Aircraft Carrier',region:'INDOPACOM'});expect(r.force_totals.battle_force.total).toBe(300);expect(r.strike_groups[0].name).toBe('CSG-4');
 });
 it('preserves pinned cutter prefix dedup behavior and rejects XML entities',()=>{
 expect(extractFleetData('USCGC A (WPC-1) USCGC B (WPC-2)').ship_count).toBe(1);expect(()=>parseFleetFeed('<!DOCTYPE test><rss/>')).toThrow('XML declarations');expect(()=>parseFleetFeed('<rss/>')).toThrow('no fleet');
 });
 it('posture aggregates injected flights and caches only complete live answers',async()=>{
 let calls=0;const h=createStrategicHandlers({now,militaryFlights:async()=>{calls++;return {source:'adsb.lol',aircraft:[{origin_country:'Test',callsign:'TEST'}]};}});const r:any=await h.intel_theater_posture!({});expect(r.total_military_aircraft).toBe(5);await h.intel_theater_posture!({});expect(calls).toBe(5);
 const absent=createStrategicHandlers({now});expect(await absent.intel_theater_posture!({})).toMatchObject({reason:'military_flights_unavailable',degraded:true});
 });
});
