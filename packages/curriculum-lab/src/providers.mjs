import { open, readFile, rename, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { digest, freezeSpec, validateProposal, once } from './index.mjs';

function ensure(ok, code) { if (!ok) throw new Error(code); }
const hex = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);

// This is caller authorization, not authentication. Only trusted host code may supply it.
function permit(s, p, operation) {
  ensure(p && p.specHash === digest(s) && p.operations?.includes(operation) && p.owner &&
    Number.isFinite(p.expiresAt) && p.expiresAt > Date.now(), 'host_authorization_required');
}

// Durable reservations are never refunded after a request may have reached a provider.
export async function reserve(directory, spec, amount) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const file=join(directory,'budget.json'), lockFile=join(directory,'budget.lock');
  let lock;
  try { lock=await open(lockFile,'wx',0o600); } catch { throw new Error('budget_locked'); }
  try {
    let ledger={specHash:digest(spec),calls:0,tokens:0,usd:0,seconds:0};
    try { ledger=JSON.parse(await readFile(file,'utf8')); } catch(e) { if(e.code!=='ENOENT') throw new Error('budget_corrupt'); }
    ensure(ledger.specHash===digest(spec), 'budget_spec_mismatch');
    for (const [key,limit] of [['calls','maxCalls'],['tokens','maxTokens'],['usd','maxUsd'],['seconds','maxSeconds']]) {
      ensure(Number.isFinite(amount[key]) && amount[key]>=0 && Number.isFinite(ledger[key]) && ledger[key]>=0, 'invalid_reservation');
      ledger[key]+=amount[key]; ensure(ledger[key]<=spec.budget[limit], 'budget_exhausted');
    }
    const f=await open(file+'.next','wx',0o600);
    try { await f.writeFile(JSON.stringify(ledger)); await f.sync(); } finally { await f.close(); }
    await rename(file+'.next',file);
    return ledger;
  } finally { await lock.close(); await unlink(lockFile); }
}

async function request(fetchImpl, url, token, method, body, timeoutMs) {
  ensure(typeof token==='string' && token.length>0,'credential_unavailable');
  let response;
  try {
    response=await fetchImpl(url,{method,redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      ...(body ? {body:JSON.stringify(body)} : {}),signal:AbortSignal.timeout(timeoutMs)});
  } catch { throw new Error('provider_transport_uncertain'); }
  // Never include provider bodies or raw exceptions in logs/errors.
  ensure(response.ok,Number.isInteger(response.status) && response.status>=100 && response.status<=599 ? `provider_http_${response.status}` : 'provider_http_failure');
  const raw=await response.text(); ensure(raw.length<=262144,'provider_response_oversized');
  try { return JSON.parse(raw); } catch { throw new Error('provider_invalid_json'); }
}

export async function proposeHF({spec:input,directory,authorization,token,model='openai/gpt-oss-120b:groq',fetchImpl=fetch}) {
  const {spec:s}=freezeSpec(input); permit(s,authorization,'hf_propose');
  ensure(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(model),'explicit_provider_required');
  ensure(authorization.model===model,'model_not_authorized');
  const body={model,temperature:0,reasoning_effort:'low',max_tokens:2048,response_format:{type:'json_object'},messages:[
    {role:'system',content:'Propose exactly one numeric curriculum parameter step. Respond only with valid JSON using {"parameter":string,"value":number}. Never output code.'},
    {role:'user',content:JSON.stringify({knob:s.knob,incumbent:s.incumbent,trainingFamilies:s.trainingFamilies})}
  ]};
  // Conservative UTF-8 byte upper reservation plus output limit. No sealed inputs in prompt.
  const tokens=Buffer.byteLength(JSON.stringify(body),'utf8')+2048;
  ensure(Number.isFinite(authorization.maxRequestUsd) && authorization.maxRequestUsd>0,'request_cost_bound_required');
  return once(directory,{operation:'hf_propose',specHash:digest(s),requestHash:digest(body)},async()=>{
    await reserve(directory,s,{calls:1,tokens,seconds:60,usd:authorization.maxRequestUsd});
    const start=performance.now();
    const data=await request(fetchImpl,'https://router.huggingface.co/v1/chat/completions',token,'POST',body,60000);
    const usage=data.usage;
    const usageValid=usage && ['prompt_tokens','completion_tokens','total_tokens'].every(k=>Number.isSafeInteger(usage[k]) && usage[k]>=0) && usage.total_tokens===usage.prompt_tokens+usage.completion_tokens && usage.total_tokens<=tokens;
    const common={model,requestHash:digest(body),latencyMs:performance.now()-start,billedUsd:null,reservedUsd:authorization.maxRequestUsd};
    if(!usageValid) return {...common,status:'INCONCLUSIVE',reason:'usage_missing_or_exceeded'};
    const choice=data.choices?.[0];
    if(choice?.finish_reason!=='stop') return {...common,status:'REJECTED',reason:'incomplete_generation',usage};
    try {
      const proposal=validateProposal(s,JSON.parse(choice.message.content));
      return {...common,status:'PROPOSED',proposal,proposalHash:digest(proposal),usage,promote:false};
    } catch { return {...common,status:'REJECTED',reason:'invalid_proposal',usage}; }
  });
}

export async function listVastInstances({token,fetchImpl=fetch}) {
  const data=await request(fetchImpl,'https://console.vast.ai/api/v0/instances/',token,'GET',null,30000);
  ensure(Array.isArray(data.instances),'invalid_instance_inventory');
  return data.instances.map(i=>({id:i.id,status:i.actual_status,gpu:i.gpu_name,gpus:i.num_gpus,hourlyUsd:i.dph_total}));
}

// Deliberately no rent/start/destroy or candidate-provided shell command API.
// A reviewed runner and manifest must already exist on the owned, running instance.
export async function dispatchVast({spec:input,directory,authorization,token,job,fetchImpl=fetch}) {
  const {spec:s}=freezeSpec(input); permit(s,authorization,'vast_dispatch');
  ensure(Number.isSafeInteger(job.instanceId) && job.instanceId>0 && authorization.instanceId===job.instanceId,'instance_not_authorized');
  ensure(hex(job.manifestHash) && hex(job.runnerHash) && authorization.runnerHash===job.runnerHash && authorization.manifestHash===job.manifestHash,'job_not_pinned');
  ensure(Number.isSafeInteger(job.maxSeconds) && job.maxSeconds>0 && job.maxSeconds<=s.budget.maxSeconds,'invalid_job_timeout');
  ensure(Number.isFinite(job.maxUsd) && job.maxUsd>0 && job.maxUsd<=authorization.maxJobUsd,'invalid_job_budget');
  return once(directory,{operation:'vast_dispatch',specHash:digest(s),job},async()=>{
    const instances=await listVastInstances({token,fetchImpl});
    ensure(instances.some(i=>i.id===job.instanceId && i.status==='running'),'owned_running_instance_required');
    await reserve(directory,s,{calls:1,tokens:0,seconds:job.maxSeconds,usd:job.maxUsd});
    // Fixed paths; all interpolated content validated as integer or lowercase SHA256.
    const runner='/workspace/curriculum-lab/runner.py';
    const command=`echo '${job.runnerHash}  ${runner}' | sha256sum -c - && timeout -s KILL ${job.maxSeconds}s env -i PATH=/usr/local/bin:/usr/bin:/bin python3 ${runner} --manifest-sha256 ${job.manifestHash}`;
    ensure(command.length<=512,'command_too_long');
    const data=await request(fetchImpl,`https://console.vast.ai/api/v0/instances/command/${job.instanceId}`,token,'PUT',{command},30000);
    ensure(data.success===true,'job_not_acknowledged');
    // Do not fetch result_url: it may be arbitrary and may expose unsigned logs.
    return {status:'QUEUED_UNVERIFIED',instanceId:job.instanceId,manifestHash:job.manifestHash,runnerHash:job.runnerHash,commandHash:digest(command),reservedUsd:job.maxUsd,billedUsd:null,complete:false,promote:false};
  });
}
