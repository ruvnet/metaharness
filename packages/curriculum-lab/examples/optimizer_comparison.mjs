// Equal realized unique-evaluation budgets, fixed before outcomes; no provider calls.
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
const worker=spawn(process.env.CURRICULUM_PYTHON||'python3',[join(base,'optimizer_worker.py')],{env:{PATH:process.env.PATH,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'},stdio:['pipe','pipe','inherit']});
let pending;const lines=createInterface({input:worker.stdout});
lines.on('line',line=>{const p=pending;pending=null;const r=JSON.parse(line);r.error?p.reject(Error(r.error)):p.resolve(r);});
worker.on('exit',code=>{if(pending)pending.reject(Error(`worker_exit_${code}`));});
function request(r){if(pending)throw Error('concurrent_worker_request');return new Promise((resolve,reject)=>{pending={resolve,reject};worker.stdin.write(JSON.stringify(r)+'\n');});}
const timer=setTimeout(()=>{worker.kill();},300000);
try{
const splits=[28001,28101,28201,28301,28401,28501,28601,28701];
const sources={};for(const p of ['optimizer_comparison.mjs','optimizer_worker.py','tabular_learning.py','../src/index.mjs','../../darwin-mode/src/numeric-evolve.ts','../../darwin-mode/src/numeric-mutator.ts'])sources[p]=digest((await readFile(join(base,p))).toString());
const plan={schema:1,sources,manifest:await request({op:'manifest',splits}),splits,
 discoverySeeds:[401,409],confirmationSeeds:[503,509,521,523],families:['digits','wine','breast_cancer'],
 genomeSpec:{learning_rate:{min:.05,max:1,type:'float',scale:'log',default:.4}},hardFraction:.5,updates:64,batchSize:64,
 generations:3,childrenPerGeneration:2,mutationSigma:.35,concurrency:1,crossover:false,
 budgetRule:'Random evaluates the same number of distinct genomes as Darwin, including shared .4 anchor; independent log-uniform draws precomputed before discovery. Duplicate Darwin genomes are cached. Maximum 11 unique discovery genomes per method per split. Confirmation uses selected winners and anchor only, same four fit seeds.',
 acceptance:'Darwin minus random macro gain >= .005, positive descriptive paired split 95% lower bound (t7=2.365), no mean family regression; same requirements against fixed .4 anchor. All eight predeclared splits retained.',
 limits:'Repeated partitions of three public datasets overlap; intervals describe this benchmark, not independent population evidence. Discovery chooses only learning rate, not the optimizer source. Even a pass is not general RSI.',
 externalCalls:0,maxSeconds:300,promote:false};
const planText=canonical(plan)+'\n';try{await writeFile(join(dir,'frozen.json'),planText,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||await readFile(join(dir,'frozen.json'),'utf8')!==planText)throw Error('plan_changed');}
const start=Date.now();let executed=0;const memo=new Map();
async function score(split,rate,phase){const r={split,rate,phase,seeds:phase==='discovery'?plan.discoverySeeds:plan.confirmationSeeds};const k=digest(r);if(!memo.has(k))memo.set(k,once(join(dir,'evaluations'),{planHash:digest(plan),...r},async()=>{if(Date.now()-start>300000)throw Error('time_budget');executed++;return request(r);}));return memo.get(k);}
function randomRates(seed){let state=seed>>>0;const rates=[.4];while(rates.length<11){state=(Math.imul(1664525,state)+1013904223)>>>0;rates.push(Math.exp(Math.log(.05)+(state/4294967296)*Math.log(20)));}return rates;}
const rows=[];
for(const split of splits){
 const randomPool=randomRates(split+90000);const unique=new Set();
 const darwin=await once(join(dir,'search'),{planHash:digest(plan),split},()=>evolveNumeric({...plan,seed:split+70000,workRoot:join(dir,`darwin-${split}`),evaluator:{async evaluate(genome,variantId){unique.add(genome.learning_rate);if(unique.size>11)throw Error('budget');const r=await score(split,genome.learning_rate,'discovery');return {variantId,primary:r.primary,regressed:false,noopRate:0,costPerWin:0,raw:{familyMeans:r.familyMeans}};}}}));
 const count=new Set(darwin.records.map(r=>r.variant.genome.learning_rate)).size;
 const candidates=[];for(const rate of randomPool.slice(0,count)){const r=await score(split,rate,'discovery');candidates.push({rate,primary:r.primary});}
 candidates.sort((a,b)=>b.primary-a.primary);
 const rates={darwin:darwin.winner.variant.genome.learning_rate,random:candidates[0].rate,anchor:.4};
 const confirmation={};for(const [arm,rate] of Object.entries(rates)){const r=await score(split,rate,'confirmation');confirmation[arm]={primary:r.primary,familyMeans:r.familyMeans};}
 rows.push({split,uniqueEvaluationsPerMethod:count,searchFitBudgetPerMethod:count*6,confirmationFitBudgetPerArm:12,rates,randomPool,randomDiscovery:candidates,darwinLineage:darwin.winnerLineage,confirmation});
 console.log(JSON.stringify({split,count,rates,confirmation}));
}
function comparison(control){const deltas=rows.map(r=>r.confirmation.darwin.primary-r.confirmation[control].primary);const mean=deltas.reduce((a,b)=>a+b)/deltas.length;const sd=Math.sqrt(deltas.reduce((s,x)=>s+(x-mean)**2,0)/7);const familyGains=Object.fromEntries(plan.families.map(f=>[f,rows.reduce((s,r)=>s+r.confirmation.darwin.familyMeans[f]-r.confirmation[control].familyMeans[f],0)/rows.length]));const lower95=mean-2.365*sd/Math.sqrt(8);return {control,gain:mean,lower95,familyGains,pass:mean>=.005&&lower95>0&&Object.values(familyGains).every(x=>x>=0)};}
const comparisons=['random','anchor'].map(comparison);const report={planHash:digest(plan),rows,comparisons,decision:comparisons.every(x=>x.pass)?'BENCHMARK_SEARCH_ADVANTAGE':'HOLD_NO_CONFIRMED_SEARCH_ADVANTAGE',rsi:'NOT_ESTABLISHED',externalCalls:0,providerCostUsd:0,executedEvaluations:executed,seconds:(Date.now()-start)/1000,signed:false,promote:false,limits:plan.limits};
try{await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;await writeFile(join(dir,`replay-${digest(report)}.json`),JSON.stringify(report,null,2));}
console.log(JSON.stringify({decision:report.decision,comparisons,executed,seconds:report.seconds}));
}finally{clearTimeout(timer);worker.stdin.end();lines.close();}
