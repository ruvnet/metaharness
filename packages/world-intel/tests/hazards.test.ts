import { describe,it,expect,vi } from 'vitest';
import { createHazardHandlers,createHazardTransport } from '../src/domains/hazards.js';
const now=()=>new Date('2026-11-17T00:00:00Z');
describe('native hazard adapters',()=>{
 it('USGS converts snake case args, GeoJSON and epoch time',async()=>{
 const transport=vi.fn(async()=>({features:[{id:'eq',properties:{mag:5,time:0,place:'Here',tsunami:0},geometry:{coordinates:[3,4,5]}}]}));
 const result=await createHazardHandlers({transport,now}).intel_earthquakes({min_magnitude:5,hours:1,limit:2});
 expect(result).toMatchObject({count:1,query:{min_magnitude:5,hours:1},earthquakes:[{id:'eq',magnitude:5,time:'1970-01-01T00:00:00Z',latitude:4,longitude:3,depth_km:5,felt_reports:null}],source:'usgs'});
 expect(transport.mock.calls[0]![0].searchParams.get('starttime')).toBe('2026-11-16T23:00:00');
 });
 it('USGS failure is not a quiet planet',async()=>{const h=createHazardHandlers({transport:async()=>{throw Error('down');},now});expect(await h.intel_earthquakes({})).toMatchObject({degraded:true,reason:'usgs_fetch_failed',count:0});});
 it('NWS handles zone-only geometry and polygons, normalizes filters, limits locally',async()=>{
 let seen:URL|undefined;const h=createHazardHandlers({now,transport:async u=>{seen=u;return {features:[{id:'one',properties:{severity:'Severe'},geometry:null},{id:'two',properties:{},geometry:{type:'Polygon',coordinates:[[[0,0],[3,0],[3,3],[0,0]]]}}]};}});
 const r=await h.intel_weather_alerts({area:' tx ',severity:'SEVERE',limit:2});expect(r).toMatchObject({coverage:'US',query:{area:'TX',severity:'Severe'},by_severity:{Severe:1,Unknown:1},alerts:[{latitude:null,longitude:null},{latitude:1,longitude:2}]});expect(seen!.searchParams.has('limit')).toBe(false);
 });
 it('EONET uses latest geometry and source links',async()=>{
 const h=createHazardHandlers({now,transport:async()=>({events:[{id:'a',title:'Fire',categories:[{title:'Wildfires'}],geometry:[{coordinates:[1,2],date:'old'},{coordinates:[3,4],date:'new'}],sources:[{url:'https://example.org'}]}]})});expect(await h.intel_environmental_events({})).toMatchObject({events:[{id:'a',lat:4,lon:3,date:'new',closed:null,sources:['https://example.org']}]});
 });
 it('GDACS handles object severity/report/population',async()=>{
 const h=createHazardHandlers({now,transport:async()=>({features:[{properties:{eventid:1,eventname:'flood',severity:{severity_value:2},url:{report:'url'},population:{value:42}},geometry:{coordinates:[5,6]}}]})});expect(await h.intel_disaster_alerts({})).toMatchObject({alerts:[{event_id:1,name:'flood',severity:2,url:'url',population_affected:42,lat:6,lon:5}]});
 });
 it('launches preserve success status and trim description',async()=>{
 const h=createHazardHandlers({now,transport:async()=>({results:[{id:'l',status:{name:'Launch Successful'},pad:{latitude:'12',longitude:'bad'},mission:{description:'a'.repeat(600)}}]})});const r=await h.intel_launch_schedule({});expect(r).toMatchObject({launches:[{status:'Launch Successful',latitude:12,longitude:null,mission_description:'a'.repeat(500)}]});
 });
 it('SWPC handles dictionary Kp, flare class and alerts',async()=>{
 const h=createHazardHandlers({now,transport:async u=>u.pathname.includes('k-index')?[{time_tag:'t0',Kp:'2'},{time_tag:'t1',Kp:6}]:u.pathname.includes('xrays')?[{flux:0.0002}]:[{message:'x'.repeat(210)}]});expect(await h.intel_space_weather({})).toMatchObject({current_kp:6,kp_level:'G2 Moderate',latest_flare_class:'X2.0',solar_wind_speed_km_s:null,alerts:[{message:'x'.repeat(200)}]});
 });
 it('transport rejects arbitrary origins, redirects and oversized bodies',async()=>{
 const fetcher=vi.fn(async()=>new Response('x'.repeat(4_000_001)));const get=createHazardTransport(fetcher as typeof fetch);
 await expect(get(new URL('https://evil.test'),1)).rejects.toThrow('Unapproved');expect(fetcher).not.toHaveBeenCalled();
 await expect(get(new URL('https://api.weather.gov/alerts/active'),1)).rejects.toThrow('too large');expect(fetcher.mock.calls[0]![1]).toMatchObject({redirect:'error'});
 });
 it('rejects invalid limits before any fetch',async()=>{const transport=vi.fn();await expect(createHazardHandlers({transport}).intel_earthquakes({limit:-1})).rejects.toThrow();expect(transport).not.toHaveBeenCalled();});
});
describe('additional hazard domains',()=>{
 it('ports all twelve names',()=>expect(Object.keys(createHazardHandlers())).toHaveLength(12));
 it('NHC maps basin and retains missing forecasts as explicit gap',async()=>{
 const h=createHazardHandlers({now,transport:async()=>({activeStorms:[{id:'al01',name:'A',classification:'HU',intensity:'85',pressure:'990',publicAdvisory:{url:'url'}}]})});expect(await h.intel_cyclones({include_forecast:true})).toMatchObject({storms:[{basin:'atlantic',classification_name:'Hurricane',intensity_kt:85,forecast:{track_status:'not_linked',cone_status:'not_linked'}}]});
 });
 it('computes climate baseline anomalies and unavailable-zone outcome',async()=>{
 const h=createHazardHandlers({now,transport:async u=>({daily:{temperature_2m_max:[u.searchParams.get('start_date')!.startsWith('2026')?20:10],temperature_2m_min:[0],precipitation_sum:[2]}})});expect(await h.intel_climate_anomalies({zones:['arctic']})).toMatchObject({zones:{arctic:{temp_anomaly_c:5,is_significant:true}},significant_anomalies:['arctic']});
 const fail=createHazardHandlers({now,transport:async()=>{throw Error();}});expect(await fail.intel_climate_anomalies({zones:['arctic']})).toMatchObject({reason:'open_meteo_fetch_failed',unavailable_zones:['arctic']});
 });
 it('volcano RSS decodes title and georss point',async()=>{
 const xml='<rss><channel><pubDate>today</pubDate><item><title>Etna (Italy) - Report for week - New Eruptive Activity</title><georss:point>37 15</georss:point><description><![CDATA[<p>Hello world</p>]]></description><guid>url</guid></item></channel></rss>';
 expect(await createHazardHandlers({now,transport:async()=>xml}).intel_volcano_activity({})).toMatchObject({count:1,new_activity_count:1,volcanoes:[{name:'Etna',country:'Italy',report_week:'week',latitude:37,longitude:15,summary:'Hello world',link:'url'}]});
 });
 it('Meteoalarm roster, aliases, per-country totals and limit',async()=>{
 const xml='<feed><updated>today</updated><entry><title>Yellow Thunderstorm</title><cap:severity>Moderate</cap:severity><cap:event>Storm</cap:event><link href="https://example.com"/></entry><entry><title>Red Warning</title><cap:severity>Severe</cap:severity></entry></feed>';
 const h=createHazardHandlers({now,transport:async()=>xml});expect(await h.intel_meteoalarm_alerts({})).toMatchObject({country:null,count:0});expect(await h.intel_meteoalarm_alerts({country:'UK',limit:1})).toMatchObject({country:'united-kingdom',count:1,total_entries:2,by_color:{yellow:1,red:1},alerts:[{link:'https://example.com',event:'Storm'}]});
 });
 it('JTWC parses separate storm segments and quiet basin',async()=>{
 const xml='<rss><channel><item><guid>NWPAC-NIO-WARNINGS</guid><description><![CDATA[Tropical Storm 17W (Saudel) Warning #42 Issued at 01/2100Z <a href="oneweb.txt">a</a> Typhoon 18W (Next) Warning #1 <a href="twoweb.txt">b</a>]]></description></item><item><guid>SH-WARNINGS</guid><description>No Current Tropical Cyclone Warnings</description></item></channel></rss>';
 expect(await createHazardHandlers({now,transport:async()=>xml}).intel_jtwc_cyclones({})).toMatchObject({count:2,by_basin:{southern_hemisphere:0},storms:[{id:'17W',warning_number:42,warning_text_url:'oneweb.txt',issued_at:'01/2100Z'},{id:'18W',warning_text_url:'twoweb.txt',issued_at:null}]});
 });
 it('blocks DTD and external entity XML',async()=>{
 const xml='<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel><item>&xxe;</item></channel></rss>';expect(await createHazardHandlers({now,transport:async()=>xml}).intel_volcano_activity({})).toMatchObject({degraded:true,reason:'gvp_fetch_failed'});
 });
 it('FIRMS requires explicit key, clusters and discards low confidence',async()=>{
 expect(await createHazardHandlers().intel_wildfires({})).toEqual({error:'NASA_FIRMS_API_KEY not configured'});
 const csv='latitude,longitude,confidence,frp\n1.25,2.25,n,5\n1.25,2.25,h,9\n1,2,l,3';const h=createHazardHandlers({now,firmsApiKey:'testonlykey',transport:async()=>csv});expect(await h.intel_wildfires({region:'europe'})).toMatchObject({total_fires:2,fires_by_region:{europe:{count:2,cluster_count:1,top_clusters:[{lat:1,lon:2,fire_count:2,max_frp:9}]}}});
 });
});

it('hazard transport rejects nonstandard ports and credentials',async()=>{const fetcher=vi.fn();const get=createHazardTransport(fetcher);for(const u of ['https://api.weather.gov:8443/a','https://user@api.weather.gov/a'])await expect(get(new URL(u),1)).rejects.toThrow('Unapproved');expect(fetcher).not.toHaveBeenCalled();});
it('hazard transport bounds a fetch that ignores abort',async()=>{vi.useFakeTimers();try{const get=createHazardTransport((()=>new Promise(()=>{})) as typeof fetch);const p=get(new URL('https://api.weather.gov/alerts/active'),1);const assertion=expect(p).rejects.toThrow('timed out');await vi.advanceTimersByTimeAsync(15001);await assertion;}finally{vi.useRealTimers();}});
