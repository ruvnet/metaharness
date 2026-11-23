// Uses the actual repository evolveNumeric engine, not a recreated search loop.
// Node 24 --experimental-transform-types is required for repository TS sources.
import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {canonical,digest,once} from '../src/index.mjs';

registerHooks({resolve(s,c,n){
  if(s.startsWith('.')&&s.endsWith('.js')&&c.parentURL){
    const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);
    if(existsSync(fileURLToPath(u)))return n(u.href,c);
  }
  return n(s,c);
}});
const {evolveNumeric}=await import('../../darwin-mode/src/numeric-evolve.ts');
const base=fileURLToPath(new URL('.',import.meta.url));
const python=process.env.CURRICULUM_PYTHON||'python3';
const env={PATH:process.env.PATH,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'};
const driver=join(base,'tabular_learning.py');
const manifest=JSON.parse(execFileSync(python,[driver,'manifest'],{env}).toString());
const directory=resolve(process.argv[2]);
const axis=process.argv[3]||'curriculum';
if(!['curriculum','learning_rate'].includes(axis))throw Error('unsupported_axis');
await mkdir(directory,{recursive:true,mode:0o700});
const hashfile=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
const plan={schema:1,engine:'@metaharness/darwin@0.10.3/evolveNumeric',
  sources:{driver:await hashfile(driver),runner:await hashfile(fileURLToPath(import.meta.url)),
    engine:await hashfile(fileURLToPath(new URL('../../darwin-mode/src/numeric-evolve.ts',import.meta.url))),
    mutator:await hashfile(fileURLToPath(new URL('../../darwin-mode/src/numeric-mutator.ts',import.meta.url)))},
  manifest,axis,genomeSpec:axis==='curriculum'?{hard_fraction:{min:0,max:1,type:'float',scale:'linear',default:0}}:{learning_rate:{min:.05,max:.4,type:'float',scale:'log',default:.1}},
  generations:3,childrenPerGeneration:2,seed:17011,mutationSigma:.35,
  baselines:[0,.5],discoverySeeds:[11,23,37],confirmationSeeds:[101,113,127,139,151,163,179,191,211,223],
  gradientUpdates:64,batchSize:64,learningRate:.1,l2:.001,
  acceptance:'greater than both static controls by >=0.005 macro balanced accuracy; no family regression; positive paired seed 95% interval',
  maxExperiments:16,maxSeconds:300,externalCalls:0,promote:false,
  limits:'Small public datasets. Fixed gradient budget, wall cost measured. Single split; seed interval is conditional on this split. No claim of general RSI.'};
try{await writeFile(join(directory,'frozen.json'),canonical(plan)+'\n',{flag:'wx'});}
catch(e){if(e.code!=='EEXIST'||await readFile(join(directory,'frozen.json'),'utf8')!==canonical(plan)+'\n')throw Error('plan_changed');}
const started=Date.now();let fits=0;
const memo=new Map();
async function score(genome,phase){
  const key=digest({genome,phase});
  if(memo.has(key))return memo.get(key);
  const pending=once(join(directory,'evaluations'),{planHash:digest(plan),genome,phase},async()=>{
    if(++fits>plan.maxExperiments||Date.now()-started>plan.maxSeconds*1000)throw Error('experiment_budget');
    return JSON.parse(execFileSync(python,[driver],{env,timeout:30000,maxBuffer:8*1024*1024,
      input:JSON.stringify({genome,phase,directory})}).toString());
  });
  memo.set(key,pending);
  return pending;
}
const controls=[];
for(const fraction of plan.baselines) controls.push(await score({hard_fraction:fraction},'discovery'));
if(controls.some(r=>!Number.isFinite(r.primary)))throw Error('baseline_failed');
const result=await once(join(directory,'search'),{planHash:digest(plan)},async()=>{try{return await evolveNumeric({
  genomeSpec:plan.genomeSpec,generations:3,childrenPerGeneration:2,seed:17011,mutationSigma:.35,
  concurrency:1,crossover:false,workRoot:join(directory,'darwin'),
  evaluator:{async evaluate(genome,variantId){const r=await score(genome,'discovery');
    if(!Number.isFinite(r.primary))throw Error('evaluation_failed');
    return {variantId,primary:r.primary,regressed:Object.keys(r.familyMeans).some(f=>r.familyMeans[f]<controls[0].familyMeans[f]),
      noopRate:0,costPerWin:r.seconds,raw:r};}}
});}catch(e){await writeFile(join(directory,'local-search-error.txt'),String(e.stack));throw e;}});
const winner=result.winner;
if(!winner)throw Error('no_search_receipt');
const chosen=winner.variant.genome;
const bestControl=Math.max(...controls.map(r=>r.primary));
const discoveryPass=winner.score.primary-bestControl>=.005 && controls.every(c=>Object.keys(c.familyMeans).every(f=>winner.score.raw.familyMeans[f]>=c.familyMeans[f]));
let confirmation=null;
if(discoveryPass){
  const a=await score({hard_fraction:0},'confirmation'),b=await score({hard_fraction:.5},'confirmation'),c=await score(chosen,'confirmation');
  if([a,b,c].some(r=>!Number.isFinite(r.primary)))throw Error('confirmation_failed');
  const comparisons=[a,b].map(control=>{
    const differences=plan.confirmationSeeds.map(seed=>{
      const avg=r=>r.rows.filter(x=>x.seed===seed).reduce((s,x)=>s+x.balancedAccuracy,0)/2;
      return avg(c)-avg(control);
    });
    const mean=differences.reduce((a,b)=>a+b,0)/differences.length;
    const sd=Math.sqrt(differences.reduce((s,x)=>s+(x-mean)**2,0)/(differences.length-1));
    return {control:control.genome,gain:mean,lower95:mean-2.262*sd/Math.sqrt(differences.length),
      noFamilyRegression:Object.keys(c.familyMeans).every(f=>c.familyMeans[f]>=control.familyMeans[f])};
  });
  confirmation={controls:[a,b],candidate:c,comparisons,pass:comparisons.every(x=>x.gain>=.005&&x.lower95>0&&x.noFamilyRegression)};
}
const report={planHash:digest(plan),selectedGenome:chosen,discoveryControls:controls.map(c=>({genome:c.genome,primary:c.primary,familyMeans:c.familyMeans})),
  discoveryWinner:{primary:winner.score.primary,familyMeans:winner.score.raw.familyMeans},discoveryPass,
  generations:3,lineage:result.winnerLineage,variants:result.records.length,confirmation,
  decision:confirmation?.pass?'MEASURED_LEARNING_GAIN':'HOLD_NO_CONFIRMED_GAIN',
  experimentSeconds:(Date.now()-started)/1000,executedEvaluations:fits,externalCalls:0,providerCostUsd:0,
  rsi:'NOT_ESTABLISHED',promote:false,signed:false,limits:plan.limits};
// Do not replace the first timing/result receipt with a fast cache replay.
try{await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});}
catch(e){if(e.code!=='EEXIST')throw e;
  await writeFile(join(directory,`replay-${digest(report)}.json`),JSON.stringify(report,null,2));}
console.log(JSON.stringify({...report,confirmation:confirmation?{comparisons:confirmation.comparisons,pass:confirmation.pass,candidate:confirmation.candidate.familyMeans,controls:confirmation.controls.map(c=>c.familyMeans)}:null}));
