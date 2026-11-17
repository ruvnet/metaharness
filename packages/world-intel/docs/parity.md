# World Intel parity audit

## Target and evidence boundary

The requested target is full native TypeScript + WASM parity with the pinned upstream revision. This inventory is **not** a claim that the target has been reached. No Python bridge, universal fallback, fabricated empty response, or tool-registration stub counts as implementation.

Pinned source: [`marc-shade/world-intel-mcp@fdebf9a8de6e00ed688053dd647cafedc179708b`](https://github.com/marc-shade/world-intel-mcp/tree/fdebf9a8de6e00ed688053dd647cafedc179708b). Version 0.11.0, MIT, Copyright (c) 2025–2026 Phoenix AGI. Full copyright/license text and its SHA-256 are included in `data/upstream-tools.json`; retain `THIRD_PARTY_NOTICES.md`.

## Static capture

`data/upstream-tools.json` records:

- 160 ordered tool definitions with exact names, descriptions and resolved input schemas.
- 20 domain modules, dispatch handler source text, direct call expressions and SHA-256 per handler.
- 29 research prompt specifications, arguments/defaults/ranges, ordered steps and limits.
- Three resource declarations, common prompt limits, answer shape and server instructions.
- SHA-256 for every one of the 259 upstream Python source files, including source adapters, runtime, cache/history, prompts and tests.

Extraction parsed Python source into AST and evaluated only whitelisted literals, constant references, string concatenation/formatting, container operations and dataclass-shaped declarations. It never imported or executed upstream modules. Preserved Python dispatch strings are audit reference data, not runtime dependencies. Static capture does not prove API responses, runtime state or rendered prompt equivalence.

## Acceptance levels

`missing`: no verified implementation. `partial`: a related subset exists but input/output compatibility differs. `implemented`: native handler exists, semantic tests still pending. `fixture_verified`: named fixtures pass, but complete behavior/live limitations remain. `verified`: every required parity evidence class is linked and reviewed. Only `verified` contributes to the 100% parity gate.

The source-adapter subset uses different names and/or shapes from upstream in places; those must not be counted as upstream-compatible merely because they fetch the same provider. Live network reachability is tracked separately from semantic fixture parity. A provider requiring credentials or unavailable at test time must retain an explicit unverified/degraded status.

## Reproducible offline gate

```sh
npm run build
node --experimental-strip-types scripts/parity-audit.ts
# Refresh the conservative evidence snapshot after rebuilding and running tests:
node --experimental-strip-types scripts/parity-audit.ts --refresh
node --experimental-strip-types scripts/parity-audit.ts --require-complete
# Optionally verify every captured source digest against a local pinned checkout:
node --experimental-strip-types scripts/parity-audit.ts --upstream=/path/to/world-intel-mcp
```

The default audit checks inventory hash, pinned revision, handler digests, unique registrations and manifest consistency. It connects an in-memory MCP client to the current built parity server, reads actual tools/prompts/resources lists, and compares every advertised input schema with the pinned snapshot. It reports registration separately from verified parity. No tool handlers or network providers are invoked. `--refresh` records registered handlers and links selected test files that mention the tool name; this is not an exhaustive equivalence oracle and tests must be run separately. The complete gate intentionally exits nonzero until all 160 tools, 29 prompts and three resources satisfy the declared evidence requirements. Evidence files must exist inside this package; existence alone does not establish their truth or adequacy, which requires review.

## Input/output and error-contract obligations

Tool definitions alone do not define full parity. Each source must cover defaults, bounds, credentials, retries/rate limits, empty/malformed/paginated responses, date/time semantics, units, stale fallback, and error/degraded markers. Stateful features additionally require persistence, revision/history semantics, replay and side-effect tests. Prompts need rendering and argument-validation equivalence plus implemented referenced tools. Dynamic resources must report actual local state, never canned upstream-looking health.

## Upstream inventory

| Domain | Tools |
| --- | ---: |
| markets | 16 |
| hazards | 12 |
| conflict | 9 |
| infrastructure | 14 |
| society | 21 |
| prediction_markets | 3 |
| intelligence | 15 |
| geospatial | 12 |
| synthesis | 8 |
| news_signals | 3 |
| finance | 12 |
| liquidity | 5 |
| news_market | 1 |
| vector | 8 |
| aoi | 13 |
| history | 4 |
| lagged_connections | 1 |
| day_timeline | 1 |
| history_backfill | 1 |
| system | 1 |

## Initial manifest status

At capture, no full semantic-parity evidence set had been established. This section intentionally avoids a stale hard-coded implementation total; run the audit for the current built registry and manifest. The manifest is conservative and requires explicit evidence promotion.

| Tool | Domain |
| --- | --- |
| `intel_market_quotes` | markets |
| `intel_crypto_quotes` | markets |
| `intel_stablecoin_status` | markets |
| `intel_etf_flows` | markets |
| `intel_sector_heatmap` | markets |
| `intel_macro_signals` | markets |
| `intel_commodity_quotes` | markets |
| `intel_gas_prices` | markets |
| `intel_residential_natgas` | markets |
| `intel_electricity_rates` | markets |
| `intel_energy_prices` | markets |
| `intel_fred_series` | markets |
| `intel_world_bank_indicators` | markets |
| `intel_country_stocks` | markets |
| `intel_btc_technicals` | markets |
| `intel_central_bank_rates` | markets |
| `intel_earthquakes` | hazards |
| `intel_wildfires` | hazards |
| `intel_climate_anomalies` | hazards |
| `intel_space_weather` | hazards |
| `intel_environmental_events` | hazards |
| `intel_disaster_alerts` | hazards |
| `intel_weather_alerts` | hazards |
| `intel_launch_schedule` | hazards |
| `intel_volcano_activity` | hazards |
| `intel_cyclones` | hazards |
| `intel_meteoalarm_alerts` | hazards |
| `intel_jtwc_cyclones` | hazards |
| `intel_acled_events` | conflict |
| `intel_ucdp_events` | conflict |
| `intel_humanitarian_summary` | conflict |
| `intel_military_flights` | conflict |
| `intel_theater_posture` | conflict |
| `intel_aircraft_details` | conflict |
| `intel_aircraft_batch` | conflict |
| `intel_nuclear_monitor` | conflict |
| `intel_usni_fleet` | conflict |
| `intel_internet_outages` | infrastructure |
| `intel_cable_health` | infrastructure |
| `intel_nav_warnings` | infrastructure |
| `intel_airport_delays` | infrastructure |
| `intel_aviation_domestic` | infrastructure |
| `intel_traffic_flow` | infrastructure |
| `intel_traffic_incidents` | infrastructure |
| `intel_webcams` | infrastructure |
| `intel_shipping_index` | infrastructure |
| `intel_service_status` | infrastructure |
| `intel_bgp_status` | infrastructure |
| `intel_jet_cohort_snapshot` | infrastructure |
| `intel_jet_activity_anomaly` | infrastructure |
| `intel_jet_excess_origins` | infrastructure |
| `intel_prediction_markets` | society |
| `intel_displacement_summary` | society |
| `intel_migration_flows` | society |
| `intel_migration_surges` | society |
| `intel_migration_history` | society |
| `intel_net_migration` | society |
| `intel_us_border_encounters` | society |
| `intel_uk_small_boat_arrivals` | society |
| `intel_cyber_threats` | society |
| `intel_news_feed` | society |
| `intel_trending_keywords` | society |
| `intel_gdelt_search` | society |
| `intel_ai_releases` | society |
| `intel_disease_outbreaks` | society |
| `intel_sanctions_search` | society |
| `intel_election_calendar` | society |
| `intel_social_signals` | society |
| `intel_hacker_news` | society |
| `intel_trending_repos` | society |
| `intel_arxiv_papers` | society |
| `intel_usa_spending` | society |
| `intel_kalshi_markets` | prediction_markets |
| `intel_prediction_compare` | prediction_markets |
| `intel_prediction_settled` | prediction_markets |
| `intel_country_brief` | intelligence |
| `intel_country_dossier` | intelligence |
| `intel_risk_scores` | intelligence |
| `intel_instability_index` | intelligence |
| `intel_signal_convergence` | intelligence |
| `intel_focal_points` | intelligence |
| `intel_signal_summary` | intelligence |
| `intel_temporal_anomalies` | intelligence |
| `intel_unrest_events` | intelligence |
| `intel_hotspot_escalation` | intelligence |
| `intel_military_surge` | intelligence |
| `intel_vessel_snapshot` | intelligence |
| `intel_cascade_analysis` | intelligence |
| `intel_alert_digest` | intelligence |
| `intel_weekly_trends` | intelligence |
| `intel_military_bases` | geospatial |
| `intel_strategic_ports` | geospatial |
| `intel_pipelines` | geospatial |
| `intel_nuclear_facilities` | geospatial |
| `intel_undersea_cables` | geospatial |
| `intel_ai_datacenters` | geospatial |
| `intel_spaceports` | geospatial |
| `intel_critical_minerals` | geospatial |
| `intel_stock_exchanges` | geospatial |
| `intel_trade_routes` | geospatial |
| `intel_cloud_regions` | geospatial |
| `intel_financial_centers` | geospatial |
| `intel_extract_entities` | synthesis |
| `intel_classify_event` | synthesis |
| `intel_news_clusters` | synthesis |
| `intel_keyword_spikes` | synthesis |
| `intel_strategic_posture` | synthesis |
| `intel_world_brief` | synthesis |
| `intel_fleet_report` | synthesis |
| `intel_population_exposure` | synthesis |
| `intel_hostility_timeline` | news_signals |
| `intel_situations` | news_signals |
| `intel_top_stories` | news_signals |
| `intel_forex_rates` | finance |
| `intel_forex_timeseries` | finance |
| `intel_major_crosses` | finance |
| `intel_yield_curve` | finance |
| `intel_bond_indices` | finance |
| `intel_earnings_calendar` | finance |
| `intel_earnings_surprise` | finance |
| `intel_sec_filings` | finance |
| `intel_company_filings` | finance |
| `intel_recent_8k` | finance |
| `intel_company_profile` | finance |
| `intel_macro_composite` | finance |
| `intel_liquidity_board` | liquidity |
| `intel_net_liquidity` | liquidity |
| `intel_money_supply` | liquidity |
| `intel_fed_liquidity_series` | liquidity |
| `intel_ecb_series` | liquidity |
| `intel_news_market_reaction` | news_market |
| `intel_semantic_search` | vector |
| `intel_similar_events` | vector |
| `intel_timeline` | vector |
| `intel_vector_stats` | vector |
| `intel_collect` | vector |
| `intel_cross_correlate` | vector |
| `intel_domain_summary` | vector |
| `intel_trend_detection` | vector |
| `intel_daily_digest` | aoi |
| `intel_aoi_define` | aoi |
| `intel_aoi_list` | aoi |
| `intel_aoi_delete` | aoi |
| `intel_aoi_brief` | aoi |
| `intel_aoi_escalation` | aoi |
| `intel_aoi_update` | aoi |
| `intel_aoi_define_polygon` | aoi |
| `intel_aoi_define_corridor` | aoi |
| `intel_aoi_changes` | aoi |
| `intel_aoi_digest` | aoi |
| `intel_situation_brief` | aoi |
| `intel_generate_report` | aoi |
| `intel_collection_health` | history |
| `intel_capture_history` | history |
| `intel_series_history` | history |
| `intel_revisions` | history |
| `intel_lagged_connections` | lagged_connections |
| `intel_day_timeline` | day_timeline |
| `intel_history_backfill` | history_backfill |
| `intel_status` | system |

## Reviewed implementation snapshot

The default registry advertises **83 of 160** upstream tool names with exact input schemas, plus 29 prompts and 3 resources. All 220 tests across 24 files passed on 2026-11-17 in this workspace. This is selected fixture/transport validation, **not 100% parity**, and no live provider coverage is implied. Run the audit again after integration changes; `data/parity.json` contains the exact missing-name list and prompt-by-prompt unimplemented references.

Four history handlers exist behind an explicitly configured `HistoryStore`; they are not advertised or counted in the default no-store audit. No store is silently created by the audit. A present source file without default registry wiring is likewise not counted.

| Domain | Default registered | Upstream target |
| --- | ---: | ---: |
| markets | 16 | 16 |
| hazards | 12 | 12 |
| conflict | 8 | 9 |
| infrastructure | 2 | 14 |
| society | 9 | 21 |
| prediction_markets | 0 | 3 |
| intelligence | 2 | 15 |
| geospatial | 12 | 12 |
| synthesis | 4 | 8 |
| news_signals | 0 | 3 |
| finance | 12 | 12 |
| liquidity | 5 | 5 |
| news_market | 0 | 1 |
| vector | 0 | 8 |
| aoi | 0 | 13 |
| history | 0 | 4 |
| lagged_connections | 0 | 1 |
| day_timeline | 0 | 1 |
| history_backfill | 0 | 1 |
| system | 0 | 1 |

### Explicit review dispositions and divergences

- Finance transport: fixed HTTPS host/path allowlist now also rejects nondefault ports and fragments, userinfo, off-origin suffixes, and disallowed paths. A targeted regression test verifies these checks. Redirects remain rejected; timeout and body-size bounds remain active.
- Finance SEC calls require an explicitly configured contact User-Agent. The port does not impersonate the upstream author's contact address or discover credentials automatically.
- Finance composites label absent market inputs as degraded instead of presenting upstream neutral placeholder scores as observed evidence. This intentionally changes the error contract and prevents a full-parity claim.
- MetaHarness wraps responses with governance receipts and marks degraded/error provider outputs as MCP errors. This is an intentional integration-layer divergence from plain upstream result delivery.
- Transport deadlines, maximum payloads, fixed source allowlists, and finite argument bounds are intentional safety limits. Upstream retry/cache/stale fallback and all malformed-provider branches have not been certified equivalent.
- Prompt rendering/argument fixtures pass, but prompts referencing missing tools cannot complete their research plans. The manifest records those references. The source-health resource describes actual local coverage rather than fabricating upstream health.
- Migration is unimplemented: four UNHCR/World Bank handlers require porting annual-stock, pagination, country/region resolution, surge/history and net-flow semantics; two border handlers additionally require the upstream CBP/Home Office file-discovery, CSV/XLSX parsing and freshness/safety rules. No generic response or schema-only handler substitutes for these six capabilities.
- Fixture evidence is deliberately narrower than exhaustive output/error/state equivalence. `verified` remains zero and `--require-complete` must fail until every declared evidence requirement is genuinely established.

- Write permissions are explicitly gated rather than inherited from upstream defaults: persistent state mutations and tracked-keyword changes require the parity server's `allowWrites` option. Nested degraded/stale outputs are rejected by governance instead of letting a healthy-looking outer response conceal failed inputs. These are intentional permission/trust-boundary changes, not accidental claims of identical upstream behavior.
