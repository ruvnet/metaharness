// A live provider integration experiment, NOT an Arena or recursive-improvement gate.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { digest, canonical, freezeSpec, once, proposeHF } from '../src/index.mjs';

export async function run(directory, { token, fetchImpl=fetch }={}) {
  const base=fileURLToPath(new URL('.',import.meta.url));
  const sourceFiles=['hf_e2e.py','hf_e2e.mjs','hf_evaluate.py','local_learning.py','ruos_secret.py','../src/index.mjs','../src/providers.mjs'];
  const hashes={};
  for (const file of sourceFiles) hashes[file]=createHash('sha256').update(await readFile(join(base,file))).digest('hex');
  const settings={trainingSeeds:[7,19,31],confirmationSeeds:[10007,10019,10031],updatesPerStage:1200,
    stages:3,learningRate:0.04,confirmationWidths:[4,8],examplesPerWidth:1000,
    incumbentWidth:4,knob:'cost_width',step:1,gate:'strict paired accuracy gain with no seed regression',
    acceptanceScope:'synthetic integration only; no Arena, transfer or RSI promotion'};
  const {spec,specHash}=freezeSpec({version:1,id:'hf-e2e-cpu-policy-v1',sourceHash:digest(hashes),
    verifierHash:hashes['hf_evaluate.py'],trainerHash:hashes['local_learning.py'],settingsHash:digest(settings),
    model:'local/two-parameter-policy',modelRevision:hashes['local_learning.py'].slice(0,40),
    dataScope:'synthetic',rounds:1,trainingFamilies:['synthetic-option-selection'],
    confirmationFamilies:['synthetic-width-shift'],discoverySeeds:['7','19','31'],
    confirmationSeeds:['10007','10019','10031'],cells:['width4','width8'],attempts:4,
    budget:{maxCalls:1,maxTokens:4096,maxSeconds:120,maxUsd:0.01},
    knob:{name:'cost_width',min:1,max:8,step:1},incumbent:4,minimumTransferGain:0.05});
  await mkdir(directory,{recursive:true,mode:0o700});
  const frozen={spec,specHash,settings,hashes,authorization:{userCeilingUsd:5,runReservationUsd:0.01},
    proposer:{model:'openai/gpt-oss-120b:groq',revision:null,effectiveThinkingVerified:false},
    modelRevisionMeaning:'local trainer source SHA256 prefix, not a Hugging Face model revision'};
  const planPath=join(directory,'frozen.json');
  try { await writeFile(planPath,canonical(frozen)+'\n',{flag:'wx',mode:0o600}); }
  catch(e) { if(e.code!=='EEXIST'||await readFile(planPath,'utf8')!==canonical(frozen)+'\n') throw Error('frozen_plan_changed'); }
  const authorization={specHash,owner:'ruv-authorized-hf-e2e',operations:['hf_propose'],
    expiresAt:Date.now()+120000,model:'openai/gpt-oss-120b:groq',maxRequestUsd:0.01};
  let requests=0;
  const trackedFetch=(...args)=>{requests++; return fetchImpl(...args);};
  const args={spec,directory:join(directory,'provider'),authorization,token,fetchImpl:trackedFetch};
  const proposal=await proposeHF(args);
  const replay=await proposeHF(args);
  if(!replay.reused || requests>1) throw Error('reuse_failed');
  let evaluation=null;
  if(proposal.status==='PROPOSED') {
    evaluation=await once(join(directory,'evaluation'),{specHash,proposalHash:proposal.proposalHash},async()=>{
      const stdout=execFileSync('python3',[join(base,'hf_evaluate.py'),directory,String(proposal.proposal.value)],
        {env:{PATH:'/usr/local/bin:/usr/bin:/bin'},timeout:30000,maxBuffer:65536,stdio:['ignore','pipe','pipe']});
      return JSON.parse(stdout.toString());
    });
  }
  const usage=proposal.usage;
  const summary={status:proposal.status==='PROPOSED' && evaluation?.status==='complete' ? 'E2E_COMPLETE' : 'INCONCLUSIVE',
    specHash,sourceHash:spec.sourceHash,proposal,receiptReuseVerified:replay.reused,networkRequestsThisInvocation:requests,
    evaluation,estimatedInferenceUsd:usage ? (usage.prompt_tokens*0.15+usage.completion_tokens*0.60)/1e6 : null,
    estimateBasis:'Groq public per-million token rates checked 2026-10-12; HF billing unverified',
    billedInferenceUsd:null,desktopCostUsd:null,runReservationUsd:0.01,authorizedCeilingUsd:5,
    decision:'HOLD',rsi:'NOT_ESTABLISHED',arena:'UNMEASURED',promote:false,signed:false};
  summary.receiptHash=digest(summary);
  return summary;
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const token=process.env.HF_TOKEN;
  delete process.env.HF_TOKEN;
  try { console.log(JSON.stringify(await run(process.argv[2],{token}))); }
  catch { console.log('{"status":"INCONCLUSIVE","reason":"e2e_failed","retry":false}'); process.exitCode=1; }
}
