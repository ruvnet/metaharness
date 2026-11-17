// SPDX-License-Identifier: MIT
// Tool contracts ported from marc-shade/world-intel-mcp tools/history.py (MIT).
import type { HistoryStore } from '../history.js';
// Pinned upstream collector roster, not the MCP tool registry.
export const HISTORY_COLLECTOR_SOURCES:readonly string[] = ["market_quotes", "crypto_quotes", "macro_signals", "sector_heatmap", "stablecoin_status", "etf_flows", "commodity_quotes", "btc_technicals", "energy_prices", "gas_prices", "residential_natgas", "electricity_rates", "central_bank_rates", "liquidity_board", "net_liquidity", "earthquakes", "wildfires", "weather_alerts", "volcano_activity", "cyclones", "acled_events", "ucdp_events", "displacement", "migration_surges", "net_migration", "military_flights", "internet_outages", "cable_health", "service_status", "nav_warnings", "climate_anomalies", "news_feed", "trending_keywords", "situations", "top_stories", "prediction_markets", "kalshi_markets", "prediction_compare", "airport_delays", "domestic_flights", "bizjet_cohort", "military_cohort", "cyber_threats", "space_weather", "launch_schedule", "ai_watch", "disease_outbreaks", "election_calendar", "shipping_index", "social_signals", "nuclear_monitor", "traffic_flow", "traffic_incidents", "risk_scores", "signal_convergence", "alert_digest", "weekly_trends", "strategic_posture", "fleet_report", "usni_fleet", "aoi_digest"];
export type HistoryHandler = (args:Record<string,unknown>) => unknown;
/** Explicit injection keeps importing/registering tools free of filesystem writes. */
export function createHistoryHandlers(store:HistoryStore|undefined, roster:readonly string[]=HISTORY_COLLECTOR_SOURCES):Record<string,HistoryHandler> {
 const string=(v:unknown):string|undefined=>typeof v==='string'?v:undefined;
 const unavailable={error:'History storage is not configured. Enable an explicit local history database path; no collection history is available until captures are recorded.'};
 return {
  intel_collection_health:a=>store?store.collectionHealth([...roster],string(a.source)):unavailable,
  intel_capture_history:a=>!a.source?{error:'source is required (a collector source name)'}:store?store.captureHistory(String(a.source),a.limit??20,a.capture_id):unavailable,
  intel_series_history:a=>store?store.seriesHistory(string(a.series_key),string(a.source),a.limit??(a.series_key?100:200)):unavailable,
  intel_revisions:a=>store?store.revisions(string(a.source),string(a.series_key),a.limit??100):unavailable,
 };
}
