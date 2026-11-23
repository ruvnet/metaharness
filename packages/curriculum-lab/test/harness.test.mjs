import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {freezeSpec,digest,validateProposal,mixedFitness,reviewComparison,once,proposeHF,dispatchVast,reserve} from '../src/index.mjs';
import {proposeDarwin} from '../src/darwin.mjs';
const fixture=JSON.parse(await readFile(new URL('../examples/spec.json',import.meta.url),'utf8'));
const spec=()=>structuredClone(fixture);
const dir=async t=>{const p=await mkdtemp(join(tmpdir(),'curriculum-'));t.after(()=>rm(p,{recursive:true,force:true}));return p;};
const response=d=>({ok:true,text:async()=>JSON.stringify(d)});
const permit=s=>({specHash:digest(s),owner:'test-owner',operations:['hf_propose','vast_dispatch'],expiresAt:Date.now()+60000,model:'openai/gpt-oss-120b:groq',maxRequestUsd:.01,instanceId:42,maxJobUsd:.1,runnerHash:'a'.repeat(64),manifestHash:'b'.repeat(64)});

test('completed receipt survives stale lock without re-execution',async t=>{
 const d=await dir(t),identity={case:'crash_after_commit'};let calls=0;
 await once(d,identity,async()=>{calls++;return {status:'complete'};});
 await writeFile(join(d,digest(identity)+'.lock'),'');
 const result=await once(d,identity,async()=>{calls++;return {status:'wrong'};});
 assert.equal(result.reused,true);assert.equal(result.status,'complete');assert.equal(calls,1);
});
const episodes=(s,mixed)=>s.cells.flatMap(cell=>Array.from({length:s.attempts},(_,attempt)=>({cell,attempt,status:'complete',success:mixed ? attempt===0 : false,trajectoryHash:digest({cell,attempt})})));

test('registration rejects seed/family overlap, invalid accounting and NaN',()=>{
 assert.equal(freezeSpec(spec()).specHash,digest(spec()));
 for(const change of [s=>s.confirmationSeeds=['11'],s=>s.confirmationFamilies=['office-dependencies'],s=>s.budget.maxUsd=NaN,s=>s.attempts=3,s=>s.modelRevision='main']) {
  const s=spec();change(s);assert.throws(()=>freezeSpec(s));
 }
});
test('mutation only allows one knob one step',()=>{
 const s=spec();assert.deepEqual(validateProposal(s,{parameter:'distractors',value:3}),{parameter:'distractors',value:3});
 for(const p of [{parameter:'reward',value:3},{parameter:'distractors',value:5},{parameter:'distractors',value:3,code:'unsafe'}])assert.throws(()=>validateProposal(s,p));
});
test('contaminated and missing episodes invalidate cells without shrinking denominator',()=>{
 const s=spec(), es=episodes(s,true);es[0].status='truncated';
 assert.deepEqual(mixedFitness(s,es),{mixed:1,denominator:2,fitness:.5,excluded:['office-d2']});
 assert.equal(mixedFitness(s,es.slice(1)).denominator,2);
 assert.throws(()=>mixedFitness(s,[...es,es[0]]));
});
test('synthetic evidence and missing transfer cannot make promotion eligible',()=>{
 const s=spec(), es=episodes(s,true);
 const r=reviewComparison(s,{specHash:digest(s),provenance:'synthetic',discovery:{incumbent:episodes(s,false),candidate:es},confirmation:{incumbent:episodes(s,false),candidate:es}});
 assert.equal(r.verdict,'HOLD');assert.equal(r.promote,false);assert.ok(r.reasons.includes('not_real_model'));
});
test('durable success and failed operations replay without calling twice',async t=>{
 const d=await dir(t);let n=0;
 const a=await once(d,{id:'success'},async()=>({status:'ok',n:++n}));
 const b=await once(d,{id:'success'},async()=>{throw Error('must not run');});
 assert.equal(a.n,1);assert.equal(b.reused,true);
 await once(d,{id:'failure'},async()=>{n++;throw Error('secret');});
 const c=await once(d,{id:'failure'},async()=>{n++;});
 assert.equal(n,2);assert.equal(c.status,'INCONCLUSIVE');assert.equal(c.reused,true);
});
test('unfinished intent and corrupt receipts fail closed',async t=>{
 const d=await dir(t),ident={id:'crash'},key=digest(ident);
 await writeFile(join(d,key+'.intent.json'),'{}');
 await assert.rejects(once(d,ident,async()=>{assert.fail('rerun');}));
 const identity={id:'corrupt'};await once(d,identity,async()=>({status:'ok'}));
 await writeFile(join(d,digest(identity)+'.json'),'{}');
 await assert.rejects(once(d,identity,async()=>{assert.fail('rerun');}),/receipt_corrupt/);
});
test('exclusive execution prevents simultaneous duplicate calls',async t=>{
 const d=await dir(t);let release;const pending=once(d,{id:1},()=>new Promise(resolve=>{release=resolve;}));
 while(!release) await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(once(d,{id:1},async()=>({})),/operation_locked/);
 release({status:'ok'});await pending;
});
test('reservations survive failed calls and cannot exceed or reset spec ceiling',async t=>{
 const d=await dir(t),s=spec();await reserve(d,s,{calls:3,tokens:0,usd:0,seconds:0});
 await assert.rejects(reserve(d,s,{calls:1,tokens:0,usd:0,seconds:0}),/budget_exhausted/);
 const s2=spec();s2.budget.maxCalls=100;
 await assert.rejects(reserve(d,s2,{calls:1,tokens:0,usd:0,seconds:0}),/budget_spec_mismatch/);
});
test('HF end-to-end uses exact provider, hides confirmation, validates proposal and reuses receipt',async t=>{
 const d=await dir(t),s=spec();let calls=0;
 const fetchImpl=async(url,opts)=>{calls++;assert.equal(url,'https://router.huggingface.co/v1/chat/completions');assert.equal(opts.redirect,'error');
  assert.ok(!opts.body.includes('industrial-constraints'));assert.ok(!opts.body.includes('confirmationSeeds'));
  return response({choices:[{finish_reason:'stop',message:{content:'{"parameter":"distractors","value":3}'}}],usage:{prompt_tokens:30,completion_tokens:20,total_tokens:50}});};
 const args={spec:s,directory:d,authorization:permit(s),token:'test-secret',fetchImpl};
 const first=await proposeHF(args);assert.equal(first.status,'PROPOSED');assert.equal((await proposeHF(args)).reused,true);assert.equal(calls,1);
 for(const f of await readdir(d))assert.ok(!(await readFile(join(d,f),'utf8')).includes('test-secret'));
});
test('HF failure charges reservation, drops raw error and never retries',async t=>{
 const s=spec(),d=await dir(t);let n=0;
 const args={spec:s,directory:d,authorization:permit(s),token:'secret',fetchImpl:async()=>{n++;throw Error('secret');}};
 assert.equal((await proposeHF(args)).status,'INCONCLUSIVE');await proposeHF(args);assert.equal(n,1);
 assert.equal(JSON.parse(await readFile(join(d,'budget.json'),'utf8')).calls,1);
});
test('HF missing usage, malformed proposal and truncation never become PROPOSED',async t=>{
 for(const data of [
  {choices:[]},
  {choices:[{finish_reason:'stop',message:{content:'{"parameter":"verifier","value":3}'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}},
  {choices:[{finish_reason:'length',message:{content:'{}'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}
 ]){const s=spec();assert.notEqual((await proposeHF({spec:s,directory:await dir(t),authorization:permit(s),token:'x',fetchImpl:async()=>response(data)})).status,'PROPOSED');}
});
test('live calls require unexpired spec-bound host authority',async t=>{
 const s=spec(),authorization=permit(s);authorization.expiresAt=0;
 await assert.rejects(proposeHF({spec:s,directory:await dir(t),authorization,token:'x',fetchImpl:()=>assert.fail('network')}),/host_authorization_required/);
});
test('Vast only queues pinned runner on existing owned running instance',async t=>{
 const s=spec(),d=await dir(t),authorization=permit(s);let count=0;
 const fetchImpl=async(url,opts)=>{count++;
  if(opts.method==='GET')return response({instances:[{id:42,actual_status:'running'}]});
  assert.match(url,/\/instances\/command\/42$/);const body=JSON.parse(opts.body);
  assert.ok(body.command.includes('env -i'));assert.ok(body.command.includes('sha256sum -c -'));assert.ok(!body.command.includes('test-secret'));
  return response({success:true,result_url:'http://169.254.169.254/secret'});
 };
 const args={spec:s,directory:d,authorization,token:'test-secret',job:{instanceId:42,runnerHash:authorization.runnerHash,manifestHash:authorization.manifestHash,maxSeconds:60,maxUsd:.1},fetchImpl};
 assert.equal((await dispatchVast(args)).status,'QUEUED_UNVERIFIED');assert.equal((await dispatchVast(args)).reused,true);assert.equal(count,2);
});
test('Vast job rejects foreign ownership, unpinned source, and stopped instance',async t=>{
 const s=spec(),authorization=permit(s),job={instanceId:42,runnerHash:authorization.runnerHash,manifestHash:authorization.manifestHash,maxSeconds:60,maxUsd:.1};
 await assert.rejects(dispatchVast({spec:s,directory:await dir(t),authorization,token:'x',job:{...job,instanceId:43}}),/instance_not_authorized/);
 assert.equal((await dispatchVast({spec:s,directory:await dir(t),authorization,token:'x',job,fetchImpl:async()=>response({instances:[{id:42,actual_status:'stopped'}]})})).status,'INCONCLUSIVE');
});
test('actual repository Darwin mutator produces one bounded parameter proposal',async()=>{
 const runtime=await import('../../darwin-mode/src/numeric-mutator.ts');
 const result=await proposeDarwin(spec(),7,1,runtime);
 assert.equal(result.status,'PROPOSED');assert.equal(result.engine,'@metaharness/darwin');
 assert.equal(Math.abs(result.proposal.value-spec().incumbent),1);
});

test('review requires frozen provenance, phase seeds and complete transfer; never signs or promotes',()=>{
 const s=spec(),phase=()=>({incumbent:episodes(s,false),candidate:episodes(s,true)});
 const e={specHash:digest(s),sourceHash:s.sourceHash,verifierHash:s.verifierHash,trainerHash:s.trainerHash,settingsHash:s.settingsHash,modelRevision:s.modelRevision,
 provenance:'real_model',effectiveSettingsVerified:true,baselineCheckpoint:'a'.repeat(64),candidateCheckpoint:'b'.repeat(64),
 discovery:{...phase(),seeds:s.discoverySeeds},confirmation:{...phase(),seeds:s.confirmationSeeds},
 transfer:s.confirmationFamilies.flatMap(family=>s.confirmationSeeds.map(seed=>({family,seed,status:'complete',baseline:false,candidate:true,baselineTrajectory:digest({family,seed,arm:0}),candidateTrajectory:digest({family,seed,arm:1})}))),
 accountingVerified:true,actualUsd:.1,independentReviewVerified:true};
 const r=reviewComparison(s,e);assert.equal(r.verdict,'READY_FOR_INDEPENDENT_REVIEW');assert.equal(r.promote,false);assert.equal(r.signed,false);
 assert.equal(reviewComparison(s,{...e,modelRevision:'other'}).verdict,'HOLD');
 assert.equal(reviewComparison(s,{...e,transfer:e.transfer.slice(1)}).verdict,'HOLD');
 assert.equal(reviewComparison(s,{...e,transfer:[...e.transfer,e.transfer[0]]}).verdict,'HOLD');
 assert.equal(reviewComparison(s,{...e,confirmation:{...e.confirmation,seeds:s.discoverySeeds}}).verdict,'HOLD');
});

test('training manifest strips sealed families and is bound to exact bytes',async()=>{
 const {trainingManifest}=await import('../src/index.mjs');
 const {createHash}=await import('node:crypto');
 const s=spec(),m=trainingManifest(s,{parameter:'distractors',value:3},60);
 assert.equal(m.manifestHash,createHash('sha256').update(m.bytes).digest('hex'));
 assert.ok(!m.bytes.includes('industrial-constraints'));assert.ok(!m.bytes.includes('confirmationSeeds'));
});
