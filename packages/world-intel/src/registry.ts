import {SourceRuntime,mergeSourceRules,withSourceRuntimeProvenance,sourceRuntimeTelemetry,attachSourceRuntime,type SourceRule} from './source-runtime.js';
import {readFileSync} from 'node:fs';
import {createCollectorHandlers,type CollectorSource} from './collector.js';
import {createPostureHandlers} from './domains/posture.js';
import {createNewsMarketHandlers} from './domains/news-market.js';
import {guardDomainHandlers} from './execution-policy.js';
import {createAOINewsTimeline} from './domains/aoi-escalation.js';
import {createPlaceContext} from './domains/geocode.js';
import {createConvergenceHandlers} from './domains/convergence.js';
import {createSystemHandlers} from './domains/system.js';
import {createVesselHandlers} from './domains/vessels.js';
import {createHistoryAnalysisHandlers} from './domains/history-analysis.js';
import {createHostilityHandlers} from './domains/hostility.js';
import type {NativeVectorStore} from './vector-store.js';
import { createVectorHandlers } from './domains/vector.js';
import { createJetOriginHandlers } from './domains/jet-origins.js';
import { createJetActivityHandlers } from './domains/jet-activity.js';
import { createJetSnapshotHandlers, MemoryCohortStore, jetRef } from './domains/jet-cohort.js';
import { createDailyDigestHandlers } from './domains/daily-digest.js';
import { createReportHandlers } from './domains/reports.js';
import { createSituationHandlers } from './domains/situation.js';
import { createAOIHandlers, createAOIGather } from './domains/aoi.js';
import { createFleetHandlers } from './domains/fleet.js';
import { createNewsSignalHandlers } from './domains/news-signals.js';
import { createExposureHandlers } from './domains/exposure.js';
import { createBriefHandlers } from './domains/briefs.js';
import { createEscalationHandlers } from './domains/escalation.js';
import { createDossierHandlers } from './domains/dossier.js';
import { createInstabilityHandlers } from './domains/instability.js';
import { createIntelligenceCompositeHandlers, type TemporalBaseline } from './domains/intelligence-composites.js';
import { createPredictionHandlers } from './domains/prediction.js';
import { createBorderHandlers } from './domains/borders.js';
import { createEconomicsHandlers } from './domains/economics.js';
import { createMaritimeHandlers } from './domains/maritime.js';
import { createInfrastructureHandlers,INFRASTRUCTURE_ENDPOINTS } from './domains/infrastructure.js';
import { createPublicSourceHandlers,publicSourceRules } from './domains/public-sources.js';
// SPDX-License-Identifier: MIT
import type { DomainHandlers } from './domain-runtime.js';
import { geospatialHandlers } from './domains/geospatial.js';
import { createHazardHandlers } from './domains/hazards.js';
import { createMarketHandlers,marketSourceRules, type MarketOptions } from './domains/markets.js';
import { createLiquidityHandlers } from './domains/liquidity.js';
import { createFinanceHandlers,financeSourceRules, type FinanceOptions } from './domains/finance.js';
import { createTechHandlers } from './domains/tech.js';
import { createNewsHandlers, NewsClient, outletFor,newsSourceRules } from './domains/news.js';
import { createSynthesisHandlers } from './domains/synthesis.js';
import { createHistoryHandlers } from './domains/history.js';
import { createSecurityHandlers } from './domains/security.js';
import { createElectionHandlers } from './domains/elections.js';
import { createConflictHandlers, createConflictClient } from './domains/conflict.js';
import { createAviationHandlers } from './domains/aviation.js';
import { createIntelligenceHandlers, IntelligenceClient } from './domains/intelligence.js';
import { createStrategicHandlers } from './domains/strategic.js';
import { createMilitaryFlightHandlers } from './domains/military-flights.js';
import type { HistoryStore } from './history.js';
export interface NativeRegistryOptions {sourceRuntime?:SourceRuntime;markets?:MarketOptions;finance?:FinanceOptions;news?:NewsClient;history?:HistoryStore;conflict?:Parameters<typeof createConflictHandlers>[0];intelligence?:Parameters<typeof createIntelligenceHandlers>[0];publicSources?:Parameters<typeof createPublicSourceHandlers>[0];infrastructure?:Parameters<typeof createInfrastructureHandlers>[0];hazards?:Parameters<typeof createHazardHandlers>[0];aoi?:Parameters<typeof createAOIHandlers>[0];reports?:Parameters<typeof createReportHandlers>[1];vector?:NativeVectorStore;temporal?:TemporalBaseline;readBaselines?:Parameters<typeof createBriefHandlers>[0]['readBaselines'];jetStore?:Parameters<typeof createJetSnapshotHandlers>[0]}
/** Construct handlers without network calls, reading secrets, or creating persistent storage. */
export function createNativeRegistry(options:NativeRegistryOptions={}):DomainHandlers {
 const sourceRuntime=options.sourceRuntime??new SourceRuntime({rules:nativeSourceRules()});const news=options.news??new NewsClient({sourceRuntime});const markets={...options.markets,sourceRuntime:sourceRuntime??options.markets?.sourceRuntime},finance={...options.finance,sourceRuntime:sourceRuntime??options.finance?.sourceRuntime};
 const military=createMilitaryFlightHandlers(markets);
 const conflict=createConflictClient(options.conflict);
 const handlers:DomainHandlers={...geospatialHandlers,...createAviationHandlers(),...createIntelligenceHandlers(options.intelligence??new IntelligenceClient({acledQuery:conflict.acledQuery})),...military,...createStrategicHandlers({militaryFlights:military.intel_military_flights}),...conflict.handlers,...createElectionHandlers(),...createSecurityHandlers(),...createHazardHandlers(options.hazards),...createMarketHandlers(markets),...createLiquidityHandlers(markets),...createFinanceHandlers(finance),...createTechHandlers(),...createNewsHandlers(news),...createSynthesisHandlers({newsFeed:a=>news.newsFeed(a),trendingKeywords:a=>news.trendingKeywords(a),outletFor})};
 const jetStore=options.jetStore?.store??new MemoryCohortStore();
 Object.assign(handlers,createPublicSourceHandlers({...options.publicSources,sourceRuntime:sourceRuntime??options.publicSources?.sourceRuntime}),createInfrastructureHandlers({...options.infrastructure,sourceRuntime:sourceRuntime??options.infrastructure?.sourceRuntime}),createMaritimeHandlers({sourceRuntime}),createEconomicsHandlers(),createBorderHandlers(),createPredictionHandlers(markets),createJetSnapshotHandlers({...options.jetStore,store:jetStore,sourceRuntime:sourceRuntime??options.jetStore?.sourceRuntime}),createJetActivityHandlers({store:jetStore}),createJetOriginHandlers({store:jetStore}));
 const call=async(name:string,args:Record<string,unknown>):Promise<Record<string,any>>=>{const handler=handlers[name];if(!handler)return{error:`Native dependency not implemented: ${name}`,degraded:true};const value=await handler(args);if(!value||typeof value!=='object'||Array.isArray(value))return{error:`Invalid native dependency result: ${name}`,degraded:true};return value as Record<string,any>;};
 Object.assign(handlers,createVesselHandlers(call),createSystemHandlers({telemetry:sourceRuntime?sourceRuntimeTelemetry(sourceRuntime):undefined,vectorStats:options.vector?()=>options.vector!.collectionStats():undefined}),createHostilityHandlers({timeline:(q,m,d)=>news.gdeltTimeline(q,m,d)}));
 Object.assign(handlers,createConvergenceHandlers());
 Object.assign(handlers,createNewsMarketHandlers({newsFeed:a=>news.newsFeed(a),secUserAgent:options.finance?.secUserAgent}));
 const composite={call,acledQuery:conflict.acledQuery,temporal:options.temporal};
 Object.assign(handlers,createIntelligenceCompositeHandlers(composite),createInstabilityHandlers(composite),createDossierHandlers(composite),createEscalationHandlers(composite),createBriefHandlers({...composite,readBaselines:options.readBaselines}),createExposureHandlers(composite),createNewsSignalHandlers(composite),createFleetHandlers(composite),createPostureHandlers(composite));
 const placeContext=createPlaceContext({sourceRuntime});
 Object.assign(handlers,createAOIHandlers({...options.aoi,gather:options.aoi?.gather??createAOIGather(handlers,{placeContext}),newsTimeline:options.aoi?.newsTimeline??createAOINewsTimeline(handlers,placeContext,q=>news.gdeltAreaTimeline(q))}),createSituationHandlers(handlers),createDailyDigestHandlers(handlers,{vectorStore:options.vector?{trendDetection:async a=>options.vector!.trendDetection(undefined,a.recent_hours,a.baseline_hours),timeline:async a=>options.vector!.timeline(undefined,undefined,a.hours,a.limit)}:undefined}),createReportHandlers(handlers,options.reports));
 if(options.vector){
  Object.assign(handlers,createVectorHandlers(options.vector));
  const roster=JSON.parse(readFileSync(new URL('../data/public/collector.json',import.meta.url),'utf8')) as [string,string,string,Record<string,unknown>][];
  const aliases:Record<string,string>={displacement:'displacement_summary',domestic_flights:'aviation_domestic',bizjet_cohort:'jet_cohort_snapshot',military_cohort:'jet_cohort_snapshot',ai_watch:'ai_releases'};
  const sources:CollectorSource[]=roster.map(([name,_module,_fn,args])=>({name,collect:async signal=>{if(signal.aborted)throw Error('Collection cancelled');return call('intel_'+(aliases[name]??name),args);}}));
  Object.assign(handlers,createCollectorHandlers({sources,vectorStore:options.vector,historyStore:options.history}));
 }
 // History methods only advertise a real configured durable store.
 if(options.history)Object.assign(handlers,createHistoryHandlers(options.history),createHistoryAnalysisHandlers(options.history));
 if(sourceRuntime)Object.assign(handlers,withSourceRuntimeProvenance(handlers));const guarded=guardDomainHandlers(handlers);return sourceRuntime?attachSourceRuntime(guarded,sourceRuntime):guarded;
}

/** All URLs are pinned provider endpoints; constructing policies starts no fetches. */
export function nativeSourceRules():Record<string,SourceRule>{return mergeSourceRules(marketSourceRules(),financeSourceRules(),newsSourceRules(),publicSourceRules([...INFRASTRUCTURE_ENDPOINTS,'https://nominatim.openstreetmap.org/reverse','https://api.adsb.lol/v2/mil','https://api.adsb.lol/v2/type/'+jetRef.BIZJET_TYPES.join(',')]));}
