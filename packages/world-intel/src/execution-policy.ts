// SPDX-License-Identifier: MIT
import {AsyncLocalStorage} from 'node:async_hooks';
import type {DomainHandlers} from './domain-runtime.js';
/** Side-effect capability follows async dependency dispatch, not just public tool names. */
export const MUTATING_TOOLS=new Set(['intel_keyword_spikes','intel_jet_cohort_snapshot','intel_temporal_anomalies','intel_military_surge','intel_hotspot_escalation','intel_aoi_define','intel_aoi_define_polygon','intel_aoi_define_corridor','intel_aoi_update','intel_aoi_delete','intel_aoi_changes','intel_aoi_digest','intel_collect','intel_history_backfill','intel_generate_report']);
const policy=new AsyncLocalStorage<{allowWrites:boolean}>();
export const withExecutionPolicy=<T>(allowWrites:boolean,fn:()=>Promise<T>):Promise<T>=>policy.run({allowWrites},fn);
export function guardDomainHandlers(handlers:DomainHandlers):DomainHandlers{for(const name of MUTATING_TOOLS){const original=handlers[name];if(!original)continue;handlers[name]=args=>{if(policy.getStore()?.allowWrites!==true)return{error:`Write capability required for ${name}`,degraded:true,reason:'write_policy_denied'};return original(args);};}return handlers;}
