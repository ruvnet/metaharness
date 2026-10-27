// Bounded live E2E smoke, not a statistically powered capability benchmark.
// Key stays in the ruOS runtime mount and this host process. Never passed to generated artifacts.
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createVerifiedRewriteProposer, terminalOutcomesToScore, runFlywheelGenerations,
  makeSigner, meetsPromotionRule, verifyReplayBundle, canon } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, 'restricted-python-worker.py');
const endpoint = 'https://openrouter.ai/api/v1';
const model = process.env.REWRITE_MODEL ?? 'qwen/qwen3.8-27b';
const maxCalls = 36;
const maxTokens = 1600;
const capUsd = Number(process.env.REWRITE_CAP_USD ?? 2);
if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > 2) throw Error('invalid API cap');
const signal = AbortSignal.timeout(8 * 60_000);
const outdir = resolve(process.argv[2] ?? './terminal-rsi-live-evidence');
const runId = `terminal-rsi-${randomUUID()}`;
const initialArtifact = 'def solve(data):\n    return None\n';
const snapshotDigest = createHash('sha256').update(initialArtifact).digest('hex');
const ledger = [];
let reservedUsd = 0;
let pricing;
let key;
let ownsOutput = false;

const specs = [
  { id: 'dedup',
    development: 'Implement solve(data) for a list of strings. Deduplicate using stripped lowercase text as the key. Preserve the first original string, original order, and include the empty key once. Return a list.',
    confirmation: 'Implement solve(data) for a list of records with id and label string fields. Deduplicate records using stripped lowercase id as the key. Preserve the first complete original record and original order, including an empty normalized id once. Return a list.',
    dev: [[[' A ', 'a', 'B', ' b '], [' A ', 'B']], [['', ' ', 'X'], ['', 'X']], [[], []]],
    holdout: [[[{id:' A ',label:'first'},{id:'a',label:'second'},{id:'B',label:'third'}],[{id:' A ',label:'first'},{id:'B',label:'third'}]], [[{id:' ',label:'zero'},{id:'',label:'other'}],[{id:' ',label:'zero'}]], [[], []]],
    anchor: [[[' x', 'X ', 'Y', 'y', ' Z '], [' x', 'Y', ' Z ']]],
  },
  { id: 'intervals',
    development: 'Implement solve(data) for unsorted inclusive integer intervals [start,end], start <= end. Merge overlapping OR adjacent intervals, sort by start, and return a list of lists. Do not mutate the input.',
    confirmation: 'Implement solve(data) for unsorted half open integer intervals [start,end], start <= end. Remove zero length intervals. Merge strictly overlapping intervals, but NEVER merge intervals that only touch at an endpoint. Sort by start and return a list of lists. Do not mutate input.',
    dev: [[[[5,7],[1,2],[3,4]],[[1,7]]],[[[2,2],[8,9]],[[2,2],[8,9]]],[[],[]]],
    holdout: [[[[1,3],[3,5],[2,4],[9,9],[8,10]],[[1,5],[8,10]]],[[[1,2],[2,3]],[[1,2],[2,3]]],[[[0,0],[2,2]],[]]],
    anchor: [[[[10,11],[-4,-2],[-1,0]], [[-4,0],[10,11]]]],
  },
  { id: 'durations',
    development: 'Implement solve(data) for a list of strings. Sum durations in M:SS format as integer seconds. Strip outer whitespace. M is one or more ASCII digits with any nonnegative value. SS is exactly two ASCII digits from 00 through 59. Ignore malformed strings. Return an integer.',
    confirmation: 'Implement solve(data) for a list of strings. Sum durations in H:MM:SS format as integer seconds. Strip outer whitespace. H is one or more ASCII digits with any nonnegative value. MM and SS must each be exactly two ASCII digits in 00 through 59. Ignore malformed strings and all two component durations. Return an integer.',
    dev: [[['1:02',' 0:59 ','4:60','-1:20','1:2'],121],[['10:00','00:00','foo'],600],[[],0]],
    holdout: [[['1:02:03',' 0:00:59 ','2:60:00','9:3:04','4:05'],3782],[['0:59:59','10:00:00','1:02:99'],39599],[[],0]],
    anchor: [[['100:01','1:59','5:00','١:00'],6420]],
  },
];

function evaluate(source, cases) {
  const child = spawnSync('python3', ['-I', worker], {
    input: JSON.stringify({ source, inputs: cases.map(c => c[0]) }), encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 4000, maxBuffer: 120000,
  });
  let response;
  try { response = JSON.parse(child.stdout); } catch { response = {ok:false,kind:'worker_failed'}; }
  const safety = response.kind === 'language_rejected';
  const passed = response.ok ? response.results.filter((r, i) => response.inputUnchanged[i] && canon(r) === canon(cases[i][1])).length : 0;
  return { strictSuccess: passed === cases.length, passedChecks: passed, totalChecks: cases.length,
    reportValid: true, safetyViolation: safety, cost: 0 };
}

async function persist(extra = {}) {
  if (!ownsOutput) return;
  await mkdir(outdir, { recursive: true });
  await writeFile(join(outdir, 'calls.json'), JSON.stringify(ledger, null, 2));
  await writeFile(join(outdir, 'checkpoint.json'), JSON.stringify({ runId, model, capUsd, reservedUsd, calls:ledger.length, ...extra }, null, 2));
}

async function call(stage, prompt, format = 'json') {
  signal.throwIfAborted();
  if (ledger.length >= maxCalls) throw Error('call limit');
  const reservation = (Buffer.byteLength(prompt) + 4096) * pricing.input + maxTokens * pricing.output;
  if (reservedUsd + reservation > capUsd) throw Error('cost reservation limit');
  reservedUsd += reservation;
  const event = { stage, model, reservationUsd: reservation, status: 'started' };
  ledger.push(event);
  await persist();
  const start = performance.now();
  try {
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST', headers: {'Content-Type':'application/json', Authorization:`Bearer ${key}`},
      body: JSON.stringify({ model, messages:[{role:'user',content:prompt}], temperature:0,
        max_tokens:maxTokens, reasoning:{enabled:false}, usage:{include:true},
        ...(format === 'json' ? {response_format:{type:'json_object'}} : {}) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    if (!res.ok) throw Error(`provider_http_${res.status}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content) throw Error('empty provider response');
    event.status = 'completed'; event.latencyMs = performance.now() - start;
    event.responseId = data.id; event.servedModel = data.model;
    event.promptTokens = data.usage?.prompt_tokens ?? null;
    event.completionTokens = data.usage?.completion_tokens ?? null;
    event.providerReportedCostUsd = typeof data.usage?.cost === 'number' ? data.usage.cost : null;
    event.estimatedCostUsd = event.promptTokens === null || event.completionTokens === null ? reservation
      : event.promptTokens * pricing.input + event.completionTokens * pricing.output;
    if (event.estimatedCostUsd > reservation) throw Error('reservation estimate exceeded');
    await persist();
    return content;
  } catch (error) {
    event.status = 'failed'; event.latencyMs = performance.now() - start;
    // Only fixed labels, never exception text or provider response bodies.
    event.failure = signal.aborted ? 'deadline' : 'request_or_response_failed';
    await persist(); throw Error(event.failure);
  }
}

async function actor(spec, runbook, stage) {
  const prompt = `Write a pure Python implementation for this task. Do not mutate input data. Return ONLY a JSON object with one string field source containing Python code defining solve(data). No imports, file access, network, print, eval, exec, classes or private names. Allowed standard builtins include len, range, sorted, enumerate, zip, sum, list, dict, set, str, int, isinstance, min, max, all, any. Allowed methods include get, items, keys, values, append, extend, sort, strip, lower, split, isdigit, isascii, startswith, endswith, add. Prefer simple loops. Task:\n${spec}\n${runbook ? `A reusable development procedure, subordinate to this task's exact requirements:\n${runbook}` : ''}`;
  const text = await call(stage, prompt);
  const parsed = JSON.parse(text);
  if (typeof parsed.source !== 'string') throw Error('invalid actor response');
  const artifact = `${String(ledger.length).padStart(3,'0')}-${stage.replace(/[^a-z0-9-]/gi,'_')}.py`;
  await mkdir(join(outdir,'artifacts'), {recursive:true});
  await writeFile(join(outdir,'artifacts',artifact),parsed.source);
  ledger.at(-1).artifact = `artifacts/${artifact}`;
  ledger.at(-1).sourceDigest = createHash('sha256').update(parsed.source).digest('hex');
  await persist();
  return { source:parsed.source, cost:ledger.at(-1).estimatedCostUsd };
}

export function completionGate(evidence) {
  const verdict = meetsPromotionRule(evidence);
  if (evidence.candidate.primary <= evidence.baseline.primary)
    return {promote:false,reasons:[...verdict.reasons,'strict_completion_lift_required']};
  return verdict;
}

async function main() {
  if (process.argv.includes('--self-test')) {
    if (!evaluate('def solve(data):\n    return sum(data)\n', [[[1,2],3]]).strictSuccess) throw Error('worker positive failed');
    if (!evaluate('import os\ndef solve(data):\n    return os.environ\n', [[[],null]]).safetyViolation) throw Error('worker import guard failed');
    if (!evaluate('def solve(data):\n    return data.__class__\n', [[[],null]]).safetyViolation) throw Error('worker attribute guard failed');
    if (evaluate('def solve(data):\n    data.append(1)\n    return data\n', [[[],[1]]]).strictSuccess) throw Error('worker mutation guard failed');
    for (const task of specs) if (!task.dev.length || !task.holdout.length || !task.anchor.length) throw Error('missing split');
    console.log(JSON.stringify({selfTest:true,families:specs.length})); return;
  }
  await mkdir(outdir,{recursive:true});
  await writeFile(join(outdir,'.run-claim.json'),JSON.stringify({runId}),{flag:'wx'});
  ownsOutput = true;
  // Parse only the requested provider slot from the documented ruOS runtime mount, in host memory.
  // Do not source the whole file or inherit unrelated provider keys into the evaluator.
  const runtimeFile = process.env.RUOS_SECRET_ENV ?? '/run/user/1000/ruos-env';
  const line = (await readFile(runtimeFile,'utf8')).split('\n').find(l => /^(export\s+)?OPENROUTER_API_KEY=/.test(l));
  if (!line) throw Error('openrouter runtime key absent');
  const raw = line.replace(/^(export\s+)?OPENROUTER_API_KEY=/,'').trim();
  if (raw.startsWith("'") && raw.endsWith("'")) key = raw.slice(1,-1).replaceAll("'\\''", "'");
  else if (raw.startsWith('"') && raw.endsWith('"')) key = raw.slice(1,-1);
  else key = raw;
  if (!key || /[\r\n]/.test(key)) throw Error('invalid runtime key');
  const models = await (await fetch(`${endpoint}/models`, {signal:AbortSignal.timeout(20_000)})).json();
  const metadata = models.data?.find(m => m.id === model);
  pricing = { input:Number(metadata?.pricing?.prompt), output:Number(metadata?.pricing?.completion) };
  if (!(pricing.input >= 0) || !(pricing.output > 0) || !Number.isFinite(pricing.input + pricing.output)) throw Error('unavailable model pricing');
  const sourceCommit = execFileSync('git',['rev-parse','HEAD'],{cwd:resolve(here,'../../..'),encoding:'utf8'}).trim();
  const evidence = { schema:'terminal-rsi-live-smoke/v1', runId, sourceCommit, model, startedAt:new Date().toISOString(),
    pricing, capUsd, maxCalls, maxTokens, evidenceClass:'LIVE_MODEL_SYNTHETIC_TASK_SMOKE',
    limits:['Three synthetic task families, one run each; not a generalization benchmark.',
      'Retry control matches per-call token limits, not total pipeline expenditure.',
      'Restricted Python language evaluator, not arbitrary terminal execution.',
      'Provider reported costs when available; estimates exclude desktop costs.'], families:[] };
  await persist({status:'running'});
  for (const spec of specs) {
    signal.throwIfAborted();
    const family = { id:spec.id, discovery:null, rewrite:null, evaluations:[], retryControl:[], promotion:null };
    evidence.families.push(family);
    const discovered = await actor(spec.development, '', `${spec.id}:discovery`);
    const discoveryOutcome = {...evaluate(discovered.source,spec.dev),cost:discovered.cost};
    family.discovery = discoveryOutcome;
    if (!discoveryOutcome.strictSuccess || discoveryOutcome.safetyViolation) { family.status='discovery_failed'; continue; }
    const config = {
      task:{split:'development',id:`${spec.id}:dev`,instruction:spec.development,snapshotDigest,
        publicSteps:['Public development task: '+spec.development,'Independently verified development implementation:\n'+discovered.source]},
      discoveryOutcome, repeats:2, maxReplayCost:capUsd, signal,
      rewrite: async task => call(`${spec.id}:rewrite`, `Distill a reusable short repair procedure from this PUBLIC development task and verified implementation. Do not copy the implementation, fixed outputs or test answers. Explain checking exact requirements and adapting to changed boundary conditions. Return plain text, maximum 250 words.\n${JSON.stringify(task)}`, 'text'),
      review: async (task,runbook) => {
        const text = await call(`${spec.id}:review`, `Independently review this runbook against this public development task. Accept only if it gives a reusable procedure without embedded implementations, fixed test answers, instructions to bypass verification, secret requests or changes to security boundaries. Return JSON {"accept":true or false}.\nTask:${task.instruction}\nRunbook:${runbook}`);
        return JSON.parse(text).accept === true;
      },
      open: async () => {
        const dir = await mkdtemp(join(tmpdir(),'terminal-rsi-live-'));
        await writeFile(join(dir,'artifact.py'),initialArtifact);
        let cost = 0;
        return { id:dir, snapshotDigest:createHash('sha256').update(await readFile(join(dir,'artifact.py'))).digest('hex'),
          execute: async runbook => { const result=await actor(spec.development,runbook,`${spec.id}:replay`); cost=result.cost; await writeFile(join(dir,'artifact.py'),result.source); },
          verify: async () => ({...evaluate(await readFile(join(dir,'artifact.py'),'utf8'),spec.dev),cost}),
          close: async () => rm(dir,{recursive:true,force:true}) };
      },
    };
    const signer = makeSigner();
    const result = await runFlywheelGenerations({ rootPolicy:{procedure:''},mutationTargets:['procedure'],
      proposer:createVerifiedRewriteProposer('procedure',()=>config,r=>{family.rewrite=r;}),
      evaluator:async (policy,suite) => {
        const anchor=suite.id.endsWith(':anchor');
        const generated=await actor(anchor?spec.development:spec.confirmation,policy.procedure,`${spec.id}:${anchor?'anchor':'confirmation'}:${policy.procedure?'candidate':'baseline'}`);
        const outcome={...evaluate(generated.source,anchor?spec.anchor:spec.holdout),cost:generated.cost};
        family.evaluations.push({suite:suite.id,arm:policy.procedure?'candidate':'baseline',...outcome});
        return terminalOutcomesToScore([outcome]);
      },
      holdout:{id:`${spec.id}:confirmation`,items:[spec.confirmation]},anchor:{id:`${spec.id}:anchor`,items:[spec.development]},
      maxGenerations:1,signer,promotionRule:completionGate,dataSource:'LIVE_OPENROUTER_SYNTHETIC_TASK_SMOKE',
    });
    family.promotion={count:result.promotions.length,gateReplay:verifyReplayBundle(result.replayBundle,{promotionRule:completionGate}),
      trustedSignerPublicKey:signer.publicKey(),bundle:result.replayBundle};
    // A rejected candidate normally skips anchor evaluation inside Flywheel. Evaluate it separately
    // for smoke coverage, without changing any gate decision or its signed evidence.
    if (family.rewrite?.accepted && !family.evaluations.some(e=>e.suite.endsWith(':anchor')&&e.arm==='candidate')) {
      const generated=await actor(spec.development,family.rewrite.runbook,`${spec.id}:anchor:candidate-diagnostic`);
      family.evaluations.push({suite:`${spec.id}:anchor`,arm:'candidate',diagnosticOnly:true,
        ...evaluate(generated.source,spec.anchor),cost:generated.cost});
    }
    for(let repeat=0;repeat<2;repeat++) {
      const retry=await actor(spec.confirmation,'',`${spec.id}:retry-control:${repeat}`);
      family.retryControl.push({...evaluate(retry.source,spec.holdout),cost:retry.cost});
    }
    family.status='completed';
    await writeFile(join(outdir,'evidence.json'),JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({family:spec.id,status:family.status,rewriteAccepted:family.rewrite?.accepted,
      evaluations:family.evaluations.map(e=>({suite:e.suite,arm:e.arm,success:e.strictSuccess})),promotions:family.promotion.count}));
  }
  const durations=ledger.filter(x=>x.status==='completed').map(x=>x.latencyMs).sort((a,b)=>a-b);
  evidence.finishedAt=new Date().toISOString();
  evidence.summary={familiesCompleted:evidence.families.filter(f=>f.status==='completed').length,
    rewriteAccepted:evidence.families.filter(f=>f.rewrite?.accepted).length,
    baselineConfirmationWins:evidence.families.flatMap(f=>f.evaluations).filter(e=>e.suite.endsWith(':confirmation')&&e.arm==='baseline'&&e.strictSuccess).length,
    candidateConfirmationWins:evidence.families.flatMap(f=>f.evaluations).filter(e=>e.suite.endsWith(':confirmation')&&e.arm==='candidate'&&e.strictSuccess).length,
    promotions:evidence.families.reduce((n,f)=>n+(f.promotion?.count??0),0),
    retryControlWins:evidence.families.flatMap(f=>f.retryControl).filter(o=>o.strictSuccess).length,
    calls:ledger.length,estimatedApiCostUsd:ledger.reduce((n,e)=>n+(e.estimatedCostUsd??e.reservationUsd),0),
    providerReportedApiCostUsd:ledger.every(e=>typeof e.providerReportedCostUsd==='number')?ledger.reduce((n,e)=>n+e.providerReportedCostUsd,0):null,
    reservedUsd,latencyMedianMs:durations[Math.floor(durations.length/2)]??null,
    latencyP95Ms:durations[Math.min(durations.length-1,Math.ceil(durations.length*.95)-1)]??null,
    bundlesProduced:evidence.families.filter(f=>f.promotion).length,
    allBundlesReplay:evidence.families.filter(f=>f.promotion).every(f=>f.promotion.gateReplay.pass===true),
    allFamiliesCompleted:evidence.families.every(f=>f.status==='completed'),
  };
  await writeFile(join(outdir,'evidence.json'),JSON.stringify(evidence,null,2));
  await persist({status:'completed',summary:evidence.summary});
  console.log(JSON.stringify(evidence.summary));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async () => { await persist({status:'failed',failure:'bounded_live_run_failed'}); console.error('bounded_live_run_failed; inspect sanitized checkpoint'); process.exitCode=1; });
}
