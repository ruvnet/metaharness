// SPDX-License-Identifier: MIT
import type {DomainHandlers} from '../domain-runtime.js';
import type {HistoryStore} from '../history.js';
import {dayTimeline} from '../history-timeline.js';
import {laggedConnections} from '../lagged-connections.js';
import {historyBackfill,type BackfillTransport,createBackfillTransport} from '../history-backfill.js';
/** Explicit configured store, no startup reads, writes, network calls or collector loop. */
export function createHistoryAnalysisHandlers(store:HistoryStore,options:{now?:()=>number;backfillTransport?:BackfillTransport}={}):DomainHandlers {
 const now=options.now??(()=>Date.now()/1000),transport=options.backfillTransport??createBackfillTransport();
 return {
  intel_history_backfill:a=>historyBackfill(store,a.provider,a.series,a.start,{transport,now}),
  intel_lagged_connections:a=>laggedConnections(store,a),
  intel_day_timeline:a=>{
   if(!('day'in a))return {error:'day is required (YYYY-MM-DD, a UTC calendar date)'};
   if(store.dbPath===':memory:')return {error:'Day timeline requires an explicit file-backed history store for a separate read-only snapshot'};
   return store.withBackfillDatabase((_db,settings)=>dayTimeline(store.dbPath,a.day,{by:a.by,source:a.source,limit:a.limit,perSourceLimit:a.per_source_limit,now:now(),retention:settings}));
  },
 };
}
