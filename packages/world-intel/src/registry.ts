// SPDX-License-Identifier: MIT
import type { DomainHandlers } from './domain-runtime.js';
import { geospatialHandlers } from './domains/geospatial.js';
import { createHazardHandlers } from './domains/hazards.js';
import { createMarketHandlers, type MarketOptions } from './domains/markets.js';
import { createLiquidityHandlers } from './domains/liquidity.js';
import { createFinanceHandlers, type FinanceOptions } from './domains/finance.js';
import { createTechHandlers } from './domains/tech.js';
import { createNewsHandlers, NewsClient, outletFor } from './domains/news.js';
import { createSynthesisHandlers } from './domains/synthesis.js';
import { createHistoryHandlers } from './domains/history.js';
import { createSecurityHandlers } from './domains/security.js';
import { createElectionHandlers } from './domains/elections.js';
import { createConflictHandlers } from './domains/conflict.js';
import { createAviationHandlers } from './domains/aviation.js';
import { createIntelligenceHandlers } from './domains/intelligence.js';
import { createStrategicHandlers } from './domains/strategic.js';
import { createMilitaryFlightHandlers } from './domains/military-flights.js';
import type { HistoryStore } from './history.js';
export interface NativeRegistryOptions {markets?:MarketOptions;finance?:FinanceOptions;news?:NewsClient;history?:HistoryStore;conflict?:Parameters<typeof createConflictHandlers>[0];intelligence?:Parameters<typeof createIntelligenceHandlers>[0]}
/** Construct handlers without network calls, reading secrets, or creating persistent storage. */
export function createNativeRegistry(options:NativeRegistryOptions={}):DomainHandlers {
 const news=options.news??new NewsClient();
 const military=createMilitaryFlightHandlers();
 const handlers:DomainHandlers={...geospatialHandlers,...createAviationHandlers(),...createIntelligenceHandlers(options.intelligence),...military,...createStrategicHandlers({militaryFlights:military.intel_military_flights}),...createConflictHandlers(options.conflict),...createElectionHandlers(),...createSecurityHandlers(),...createHazardHandlers(),...createMarketHandlers(options.markets),...createLiquidityHandlers(options.markets),...createFinanceHandlers(options.finance),...createTechHandlers(),...createNewsHandlers(news),...createSynthesisHandlers({newsFeed:a=>news.newsFeed(a),trendingKeywords:a=>news.trendingKeywords(a),outletFor})};
 // History methods only advertise a real configured durable store.
 if(options.history)Object.assign(handlers,createHistoryHandlers(options.history));
 return handlers;
}
