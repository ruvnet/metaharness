// SPDX-License-Identifier: MIT
import type {NativeVectorStore} from '../vector-store.js';
import type {DomainHandlers} from '../domain-runtime.js';
/** Register only when explicit storage is configured; never starts collectors/models. */
export function createVectorHandlers(store:NativeVectorStore):DomainHandlers {
 const str=(v:unknown)=>typeof v==='string'?v:undefined;
 const num=(v:unknown,d:number)=>v===undefined?d:typeof v==='number'?v:NaN;
 return {
 intel_semantic_search:a=>store.semanticSearch(String(a.query??''),num(a.limit,20),str(a.domain),str(a.category),a.hours===undefined?undefined:num(a.hours,24)),
 intel_similar_events:a=>store.findSimilar(String(a.domain??'unknown'),String(a.text??''),num(a.limit,10),a.hours===undefined?undefined:num(a.hours,24)),
 intel_timeline:a=>store.timeline(str(a.domain),str(a.category),num(a.hours,24),num(a.limit,50)),
 intel_vector_stats:()=>store.collectionStats(),
 intel_cross_correlate:a=>store.crossCorrelate(String(a.query??''),num(a.hours,24),num(a.limit_per_domain,5)),
 intel_domain_summary:a=>store.domainSummary(num(a.hours,24)),
 intel_trend_detection:a=>store.trendDetection(str(a.category),num(a.recent_hours,6),num(a.baseline_hours,48)),
 };
}
