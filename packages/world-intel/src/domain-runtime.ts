// SPDX-License-Identifier: MIT
import { AgentPool, AlgorithmRouter, HarnessKernel, PolicyGate, allowTools, VerifierRegistry, predicateVerifier } from '@metaharness/harness';
export type DomainArgs = Record<string, unknown>;
export type DomainHandler = (args: DomainArgs) => unknown | Promise<unknown>;
export type DomainHandlers = Record<string, DomainHandler>;
/** Conservative provider-state check; this does not establish factual truth. */
export function hasUnacceptedProviderState(value:unknown,depth=0):boolean {
 if(depth>32)return true;
 if(!value||typeof value!=='object')return false;
 if(Array.isArray(value))return value.some(x=>hasUnacceptedProviderState(x,depth+1));
 const row=value as Record<string,unknown>;
 if(row.degraded===true||row._stale===true||row.stale===true||typeof row.error==='string'&&row.error.length>0)return true;
 return Object.values(row).some(x=>hasUnacceptedProviderState(x,depth+1));
}
/** Policy/receipt wrapper for upstream-shaped domain results. It does not assert source truth. */
export async function runDomainTool(name: string, args: DomainArgs, handler: DomainHandler, permitted = true) {
  const pool = new AgentPool([{id:'world-intel-domain',model:'deterministic-typescript',handles:[name],run:async()=>{
    const started=performance.now();
    try {
      const result=await handler(args);
      if (JSON.stringify(result).length>4_000_000) throw new Error('Tool output exceeds 4 MB limit');
      return {output:result,quality:1,confidence:1,risk:0.1,costUsd:0,latencyMs:performance.now()-started};
    } catch(error) {
      return {output:{error:error instanceof Error?error.message:'Domain call failed',degraded:true},quality:0,confidence:0,risk:0.1,costUsd:0,latencyMs:performance.now()-started};
    }
  }}]);
  const verifiers=new VerifierRegistry().register(predicateVerifier('domain-result','schema',value=>{
    if (!value || typeof value!=='object' || Array.isArray(value)) return false;
    const r=value as Record<string,unknown>;
    return !r.error && !r.degraded && !hasUnacceptedProviderState(r);
  },'Provider error, degraded or stale result; not accepted as a current successful observation'));
  const kernel=new HarnessKernel({pool,verifiers,router:new AlgorithmRouter({intel:{intent:'intel',steps:[{kind:name}]}}),policy:new PolicyGate(permitted?[allowTools([name],0.1)]:[]),budget:{costUsd:0,risk:0.1,retries:0,confidence:1}});
  return kernel.run({text:'Read bounded upstream-shaped intelligence',intent:'intel',context:{tool:name}});
}
