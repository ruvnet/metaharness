import {describe,it,expect} from 'vitest';
import {createConvergenceHandlers} from '../src/domains/convergence.js';
describe('geographic signal convergence',()=>{
 it('uses actual bounding box requests and upstream score heuristic',async()=>{const urls:URL[]=[];const h=createConvergenceHandlers({now:()=>Date.parse('2026-11-17T00:00:00Z'),transport:async u=>{urls.push(u);return {features:Array(10).fill({})};}});expect(await h.intel_signal_convergence({lat:40,lon:50,radius_deg:2})).toMatchObject({hotspots:[{name:'custom',signals:{earthquakes:10},convergence_score:2.5}]});expect(urls[0].searchParams.get('minlatitude')).toBe('38');expect(urls[0].searchParams.get('starttime')).toBe('2026-10-18T00:00:00');});
 it('cannot interpret USGS failure as zero earthquakes',async()=>{const h=createConvergenceHandlers({transport:async()=>{throw new Error('down');}});const r:any=await h.intel_signal_convergence({});expect(r.degraded).toBe(true);expect(r.hotspots).toHaveLength(5);expect(r.hotspots.every((r:any)=>r.signals.earthquakes===null&&r.convergence_score===null)).toBe(true);});
});
