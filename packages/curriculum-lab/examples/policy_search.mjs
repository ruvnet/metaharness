// Bounded outer policy experiment. Actual Darwin engine; manually proposed sigma change.
import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {canonical,digest,once} from '../src/index.mjs';
registerHooks({resolve(s,c,n){if(s.startsWith('.')&&s.endsWith('.js')&&c.parentURL){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return n(u.href,c);}return n(s,c);}});
const {evolveNumeric}=await import('../../darwin-mode/src/numeric-evolve.ts');
const dir=resolve(process.argv[2]);await mkdir(dir,{recursive:true,mode:0o700});
const base=fileURLToPath(new URL('.',import.meta.url));
const worker=spawn(process.env.CURRICULUM_PYTHON||'python3',[join(base,'policy_worker.py')],{env:{PATH:process.env.PATH,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'},stdio:['pipe','pipe','inherit']});
let pending;const lines=createInterface({input:worker.stdout});
lines.on('line',line=>{const p=pending;pending=null;const r=JSON.parse(line);r.error?p.reject(Error(r.error)):p.resolve(r);});
worker.on('exit',code=>{if(pending)pending.reject(Error(`worker_exit_${code}`));});
function request(r){if(pending)throw Error('concurrent_request');return new Promise((resolve,reject)=>{pending={resolve,reject};worker.stdin.write(JSON.stringify(r)+'\n');});}
const timer=setTimeout(()=>worker.kill(),300000);
try{
const splits=[32001,32101,32201,32301,32401,32501,32601,32701];
const sources={};for(const p of ['policy_search.mjs','policy_worker.py','tabular_learning.py','../src/index.mjs','../../darwin-mode/src/numeric-evolve.ts','../../darwin-mode/src/numeric-mutator.ts'])sources[p]=digest((await readFile(join(base,p))).toString());
const plan={schema:1,sources,manifest:await request({op:'manifest',splits}),splits,discoverySeeds:[701,709],confirmationSeeds:[809,811,821,823],
 families:['compact_noisy','wide_sparse'],genomeSpec:{learning_rate:{min:.05,max:1,type:'float',scale:'log',default:.4}},
 incumbentSigma:.35,candidateSigma:.12,uniqueDiscoveryBudget:7,updates:64,batchSize:64,hardFraction:.5,
 method:'Actual evolveNumeric with identical seed per paired policy, concurrency 1, crossover false, childrenPerGeneration 2; stop before eighth unique evaluation. Duplicates cached. Reject experiment if 20 generations cannot fill seven unique slots. Select highest discovery score among all evaluated candidates, with first-evaluated tie break. Random uses seven independent log-uniform candidates including the same .4 anchor.',
 rationale:'Prior exposed benchmark showed boundary clamping and both upper-bound winners regressed against anchor. Only policy mutationSigma changes; learning semantics and budgets fixed.',
 acceptance:'Candidate minus each incumbent Darwin, random, fixed anchor: mean macro gain >=.005; descriptive paired population-seed 95% lower bound >0 (t7=2.365); nonnegative mean gain in each family. Eight populations retained; no post-outcome retries or threshold changes.',
 limits:'Hand-proposed policy change, not an automatically improved optimizer or LLM weight training. Two synthetic configurations from one generator; limited transfer evidence even if successful.',externalCalls:0,promote:false};
const bytes=canonical(plan)+'\n';try{await writeFile(join(dir,'frozen.json'),bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||await readFile(join(dir,'frozen.json'),'utf8')!==bytes)throw Error('plan_changed');}
const started=Date.now();let executed=0;const memo=new Map();
async function score(split,rate,phase){const q={split,rate,phase,seeds:phase==='discovery'?plan.discoverySeeds:plan.confirmationSeeds};const key=digest(q);if(!memo.has(key))memo.set(key,once(join(dir,'evaluations'),{planHash:digest(plan),...q},async()=>{if(Date.now()-started>300000)throw Error('budget');executed++;const r=await request(q);if(!Number.isFinite(r.primary))throw Error('invalid_score');return r;}));const r=await memo.get(key);if(!Number.isFinite(r.primary))throw Error('invalid_receipt');return r;}
function pool(seed){let state=seed>>>0;const a=[.4];while(a.length<7){state=(Math.imul(1664525,state)+1013904223)>>>0;a.push(Math.exp(Math.log(.05)+(state/4294967296)*Math.log(20)));}return a;}
async function search(split,sigma){return once(join(dir,'search'),{planHash:digest(plan),split,sigma},async()=>{
 const seen=new Map();const callbacks=[];let stopped=false;
 try{await evolveNumeric({genomeSpec:plan.genomeSpec,seed:split+70000,generations:20,childrenPerGeneration:2,mutationSigma:sigma,concurrency:1,crossover:false,workRoot:join(dir,`darwin-${split}-${sigma}`),evaluator:{async evaluate(genome,variantId){
 const rate=genome.learning_rate;if(!seen.has(rate)&&seen.size===7)throw Error('FIXED_BUDGET_COMPLETE');const r=await score(split,rate,'discovery');if(!seen.has(rate))seen.set(rate,{rate,primary:r.primary});callbacks.push({variantId,rate,primary:r.primary});return {variantId,primary:r.primary,regressed:false,noopRate:0,costPerWin:0};}}});}
 catch(e){if(e.message!=='FIXED_BUDGET_COMPLETE')throw e;stopped=true;}
 if(seen.size!==7)throw Error('budget_not_filled');const candidates=[...seen.values()];const winner=[...candidates].sort((a,b)=>b.primary-a.primary)[0];
 return {candidates,callbacks,winner,stoppedAtBudget:stopped,archiveNote:'Engine stops during a generation. Complete evaluation list is candidates/callbacks; archive may omit final partial generation scores.'};});}
const rows=[];
for(const split of splits){
 const searches={};searches.incumbent=await search(split,.35);searches.candidate=await search(split,.12);
 for(const r of Object.values(searches))if(!r.winner||r.candidates.length!==7)throw Error('incomplete_search');
 const random=[];for(const rate of pool(split+90000)){const r=await score(split,rate,'discovery');random.push({rate,primary:r.primary});}
 searches.random={candidates:random,winner:[...random].sort((a,b)=>b.primary-a.primary)[0]};
 const rates={...Object.fromEntries(Object.entries(searches).map(([k,v])=>[k,v.winner.rate])),anchor:.4};const confirmation={};
 for(const [arm,rate] of Object.entries(rates)){const r=await score(split,rate,'confirmation');confirmation[arm]={primary:r.primary,familyMeans:r.familyMeans};}
 rows.push({split,searches,rates,confirmation,uniqueDiscoveryBudgetPerSearch:7,discoveryFitsPerSearch:28,confirmationFitsPerArm:8});console.log(JSON.stringify({split,rates,confirmation}));
}
const comparisons=['incumbent','random','anchor'].map(control=>{const deltas=rows.map(r=>r.confirmation.candidate.primary-r.confirmation[control].primary);const gain=deltas.reduce((a,b)=>a+b)/8;const sd=Math.sqrt(deltas.reduce((s,x)=>s+(x-gain)**2,0)/7);const lower95=gain-2.365*sd/Math.sqrt(8);const familyGains=Object.fromEntries(plan.families.map(f=>[f,rows.reduce((s,r)=>s+r.confirmation.candidate.familyMeans[f]-r.confirmation[control].familyMeans[f],0)/8]));return {control,gain,lower95,familyGains,pass:gain>=.005&&lower95>0&&Object.values(familyGains).every(x=>x>=0)};});
const report={planHash:digest(plan),rows,comparisons,decision:comparisons.every(r=>r.pass)?'MEASURED_POLICY_TRANSFER_GAIN':'HOLD_NO_CONFIRMED_POLICY_GAIN',executedEvaluations:executed,seconds:(Date.now()-started)/1000,externalCalls:0,providerCostUsd:0,rsi:'NOT_ESTABLISHED',signed:false,promote:false,limits:plan.limits};
try{await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;await writeFile(join(dir,`replay-${digest(report)}.json`),JSON.stringify(report,null,2));}console.log(JSON.stringify({decision:report.decision,comparisons,executed,seconds:report.seconds}));
}finally{clearTimeout(timer);worker.stdin.end();lines.close();}
