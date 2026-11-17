// SPDX-License-Identifier: MIT
// Separate injectable dashboard entrypoint; no top-level startup or environment discovery.
import {startDashboard,type DashboardListenOptions} from './dashboard-http.js';
import type {DashboardOptions} from './dashboard.js';
export function parseDashboardArgs(argv:readonly string[],env:Readonly<Record<string,string|undefined>>={}):DashboardListenOptions{
 let host=env.WORLD_INTEL_DASHBOARD_HOST??'127.0.0.1',port=Number(env.WORLD_INTEL_DASHBOARD_PORT??env.PORT??8501),allowRemote=false;
 for(let i=0;i<argv.length;i++){const a=argv[i];if(a==='--host'&&argv[i+1])host=argv[++i];else if(a==='--port'&&argv[i+1]){if(!/^\d+$/.test(argv[i+1]))throw Error('Port must be an integer');port=Number(argv[++i]);}else if(a==='--allow-remote')allowRemote=true;else throw Error('Usage: intel-dashboard --host HOST --port PORT [--allow-remote]');}
 return {host,port,allowRemote};
}
/** Caller wires its approved persistent capabilities; no default data directory or daemon. */
export async function runDashboardCli(argv:readonly string[],options:DashboardOptions,env:Readonly<Record<string,string|undefined>>={}){
 return startDashboard(options,parseDashboardArgs(argv,env));
}
