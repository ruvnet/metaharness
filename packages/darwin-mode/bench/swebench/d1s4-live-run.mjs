#!/usr/bin/env node
// D1-S4 — the BUDGETED LIVE SWE-bench flywheel run. Real cheap solver (solve.mjs, --base-url) + the
// OFFICIAL swebench Docker harness (gold-scoring) + a frontier proposer, compounding operating-policy
// over generations on the FROZEN holdout. HARD $-cap (default $10) via a shared spend counter that
// throttles the flywheel's budget guard. Emits the lift curve + a signed, replayable ReplayBundle.
// Scope-honest: this is the ONLY place a REAL SWE-bench gold score is produced (the official harness).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runFlywheelGenerations, makeSigner, verifyReplayBundle, gateFingerprint, meetsPromotionRule, analyzeBundle, formatAnalysis } from '@metaharness/flywheel';
import { makeSwebenchEvaluator, makeSwebenchProposer } from './flywheel-swebench-evaluator.mjs';
import { makeCliSolver } from './swebench-solver-cli.mjs';
import { makeSwebenchGrader } from './swebench-grade.mjs';
import { resolveEndpointAuth } from './swebench-endpoint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };

const HOLDOUT_N = +arg('--holdout', 12);
const ANCHOR_N = +arg('--anchor', 5);
const GENERATIONS = +arg('--generations', 5);
const BUDGET_USD = +arg('--budget', 10);
const MODEL = arg('--model', 'z-ai/glm-5.2');
const PROPOSER = arg('--proposer', 'anthropic/claude-sonnet-5');
const BASE_URL = arg('--base-url', 'https://openrouter.ai/api/v1');
const K = +arg('--k', 1); // samples per instance — 1 keeps a single generation from overshooting the cap
// which policy levers to mutate per generation (fewer = fewer candidates/gen = tighter cost bound)
const TARGETS = arg('--targets', 'editPolicy').split(',').map((s) => s.trim()).filter(Boolean);
// Endpoint auth: hosted (OpenRouter default) needs a key; a LOCAL no-auth endpoint (`--api-key-env NONE`
// or a localhost --base-url, e.g. `ruvllm serve` / ollama at http://localhost:11434/v1) needs none and
// costs $0. This removes the budget gate from the D1 positive-compounding run — same real solver + REAL
// official-harness gold-scoring, $0 inference. Tolerant read: `--plan` reports a missing hosted key as a
// pre-flight gap instead of crashing. (Only the official swebench harness gold-scores — a local model
// changes the $, never the honesty.)
const API_KEY_ENV = arg('--api-key-env', 'OPENROUTER_API_KEY');
const { noAuth: NO_AUTH, key: KEY } = resolveEndpointAuth({
  apiKeyEnv: API_KEY_ENV, baseUrl: BASE_URL, env: process.env,
  orkey: existsSync('/tmp/.orkey') ? readFileSync('/tmp/.orkey', 'utf-8') : '',
});

const holdout = JSON.parse(readFileSync(join(HERE, 'swebench-holdout-frozen.json'), 'utf-8')).instances.slice(0, HOLDOUT_N);
const anchor = JSON.parse(readFileSync(join(HERE, 'swebench-anchor-frozen.json'), 'utf-8')).instances.slice(0, ANCHOR_N);

let spend = 0;
const priceOf = (u, model) => { const inn = model.includes('sonnet') ? 3e-6 : 0.93e-6, out = model.includes('sonnet') ? 15e-6 : 3e-6; return (u?.prompt_tokens ?? 0) * inn + (u?.completion_tokens ?? 0) * out; };
// Resilient POST: retry transient network errors (EPIPE/ECONNRESET/"fetch failed") + 5xx/429 with
// exponential backoff. A single transient blip must NEVER crash a multi-hour run (the 2026-07-06 EPIPE crash).
async function fetchJSON(url, init, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, init);
      if (r.status >= 500 || r.status === 429) { lastErr = new Error(`http_${r.status}`); }
      else return await r.json();
    } catch (e) { lastErr = e; }
    await new Promise((s) => setTimeout(s, Math.min(30000, 1000 * 2 ** i)));
  }
  throw lastErr;
}
async function complete(model, prompt) {
  try {
    const headers = { 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) };
    const j = await fetchJSON(`${BASE_URL}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 400, temperature: 0.4 }) });
    spend += NO_AUTH ? 0 : (j.usage?.cost ?? priceOf(j.usage, model)); // local inference is $0
    return j.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    // Degrade: an unrecoverable proposer error yields NO mutation (safe) rather than killing the run.
    console.error(`[complete] gave up after retries: ${String(e).slice(0, 120)}`);
    return '';
  }
}

// --solver selects the code-repair solver the flywheel evolves. 'single' = solve.mjs (open-loop
// single-shot; D1-S4 honest-null baseline). 'agentic' = solve-agentic.mjs (multi-shot explore→edit→
// run_tests→iterate; the D1 POSITIVE-path candidate — it has real headroom for a policy to compound).
// Both honor the SWE_POLICY_SYSTEM seam (agentic-loop.mjs applyPolicySystem) so the flywheel evolves
// HOW the solver operates in either mode. Agentic passes --max-steps/--concurrency via extraArgs.
const SOLVER = arg('--solver', 'single');
const SOLVER_SCRIPT = { single: 'solve.mjs', agentic: 'solve-agentic.mjs' }[SOLVER];
if (!SOLVER_SCRIPT) { console.error(`--solver must be 'single' or 'agentic' (got '${SOLVER}')`); process.exit(2); }
const solverExtraArgs = SOLVER === 'agentic'
  ? ['--max-steps', arg('--max-steps', '20'), '--concurrency', arg('--concurrency', '2')]
  : [];
// real solver cost feeds the shared spend via its returned costUsd (summed inside the evaluator wrapper).
const cliSolver = makeCliSolver({
  solveScript: new URL(SOLVER_SCRIPT, import.meta.url).pathname,
  baseUrl: BASE_URL, model: MODEL, apiKeyEnv: API_KEY_ENV, k: K, extraArgs: solverExtraArgs,
});
const runSolver = async (policy, instances) => { const preds = await cliSolver(policy, instances); spend += NO_AUTH ? 0 : preds.reduce((s, p) => s + (p.costUsd || 0), 0); return preds; };
const grader = makeSwebenchGrader({ dataset: arg('--dataset', 'princeton-nlp/SWE-bench_Lite'), maxWorkers: 4 });

const evaluator = makeSwebenchEvaluator({ runSolver, gradePredictions: grader });
const proposer = makeSwebenchProposer({ complete, proposerModel: PROPOSER });

const out = join(HERE, 'proof-bundle-swebench.json');
const ckpt = join(HERE, 'proof-bundle-swebench.partial.json');

// --resume: continue a crashed run from the last checkpoint instead of re-spending from gen 1. Reads
// the persisted { resumeState, spent } from the partial file and seeds the spend counter.
let resumeFrom;
if (process.argv.includes('--resume') && existsSync(ckpt)) {
  const saved = JSON.parse(readFileSync(ckpt, 'utf-8'));
  if (saved.resumeState) {
    resumeFrom = saved.resumeState;
    spend = saved.spent || 0;
    console.log(`[resume] continuing from gen ${resumeFrom.fromGeneration} (prior spend=$${spend.toFixed(4)}) — gens ${resumeFrom.fromGeneration + 1}→${GENERATIONS}`);
  } else {
    console.log('[resume] partial file has no resumeState (pre-0.1.5 checkpoint) — starting fresh');
  }
}

// --plan / --dry-run: print the run plan + a $0 pre-flight (Docker, gold-scorer venv, frozen suites,
// key) and EXIT — no LLM call, no Docker run, no spend. Makes launching the (budget-gated) flagship a
// confident one-command action. Exit 0 iff every pre-flight check is GREEN.
if (process.argv.includes('--plan') || process.argv.includes('--dry-run')) {
  const venvPython = process.env.SWEBENCH_VENV_PYTHON || join(homedir(), '.cache', 'swebench-venv', 'bin', 'python');
  const dockerOk = spawnSync('docker', ['ps'], { stdio: 'ignore' }).status === 0;
  const harnessOk = existsSync(venvPython);
  const suitesOk = holdout.length >= HOLDOUT_N && anchor.length >= ANCHOR_N;
  const keyOk = NO_AUTH || KEY.length > 0;
  const candPerGen = TARGETS.length;
  const holdoutEvals = 1 + GENERATIONS * candPerGen;              // root + one per candidate
  const solverInstanceRuns = holdoutEvals * holdout.length + GENERATIONS * anchor.length; // holdout + winner-anchor evals
  const ck = (ok) => (ok ? 'GREEN' : 'BLOCKED');
  // Local-endpoint model check: the runner shares ONE endpoint for solve + propose, so a hosted-style
  // --proposer (e.g. the default anthropic/claude-sonnet-5) against a local server would silently yield
  // NO mutations — a wasted null run. For a $0 local run, verify BOTH models are actually served ($0 GET).
  let localModelsOk = true, localModelsLine = null;
  if (NO_AUTH) {
    let served = null;
    try {
      const r = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(5000) });
      served = new Set(((await r.json())?.data ?? []).map((m) => m.id));
    } catch { served = null; }
    if (!served) {
      localModelsOk = false;
      localModelsLine = `  local models served:      BLOCKED  — ${BASE_URL}/models unreachable (is the local server up?)`;
    } else {
      const hasSolver = served.has(MODEL), hasProposer = served.has(PROPOSER);
      localModelsOk = hasSolver && hasProposer;
      localModelsLine = `  local models served:      ${ck(localModelsOk)}  (solver ${MODEL} ${hasSolver ? '✓' : '✗ NOT SERVED'}, proposer ${PROPOSER} ${hasProposer ? '✓' : '✗ NOT SERVED → pick a local --proposer or the run gets 0 mutations'})`;
    }
  }
  const ready = dockerOk && harnessOk && suitesOk && keyOk && localModelsOk;
  const lines = [
    '── D1-S4 RUN PLAN (dry-run — no spend) ──',
    `  solver=${SOLVER}${SOLVER === 'agentic' ? ` (max-steps=${arg('--max-steps', '20')}, concurrency=${arg('--concurrency', '2')})` : ''}  model=${MODEL}  proposer=${PROPOSER}`,
    `  holdout=${holdout.length}  anchor=${anchor.length}  generations=${GENERATIONS}  targets=[${TARGETS.join(',')}]  k=${K}`,
    `  candidates/gen=${candPerGen}  →  ${GENERATIONS * candPerGen} candidate policy-evaluations over the run`,
    `  solver instance-runs (upper bound): ~${solverInstanceRuns}  (agentic ⇒ each ≤ max-steps LLM calls + Docker gold-test)`,
    `  HARD budget cap: $${BUDGET_USD}  — the loop STOPS at the generation boundary once spend ≥ cap (never a soft target)`,
    `  resilience: per-generation checkpoint → proof-bundle-swebench.partial.json ; --resume continues from the last gen`,
    '',
    '── PRE-FLIGHT ──',
    `  Docker daemon:            ${ck(dockerOk)}`,
    `  swebench gold-scorer venv: ${ck(harnessOk)}  (${venvPython})`,
    `  frozen holdout+anchor:    ${ck(suitesOk)}`,
    `  endpoint:                 ${MODEL} @ ${BASE_URL}`,
    `  auth:                     ${ck(keyOk)}${NO_AUTH ? '  — LOCAL no-auth endpoint ($0 inference)' : (keyOk ? ` (key ${API_KEY_ENV} prefix ${KEY.slice(0, 12)})` : ` — set ${API_KEY_ENV} or /tmp/.orkey`)}`,
    ...(localModelsLine ? [localModelsLine] : []),
    '',
    `  READY TO LAUNCH: ${ready ? 'YES — drop --plan to run for real' : 'NO — resolve the BLOCKED item(s) above'}`,
    '  SCOPE: only the official swebench harness gold-scores; nothing here is a real result (dry-run).',
  ];
  console.log(lines.join('\n'));
  process.exit(ready ? 0 : 1);
}

console.log(`D1-S4 LIVE SWE-bench flywheel: solver=${SOLVER} holdout=${holdout.length} anchor=${anchor.length} gens=${GENERATIONS} cap=$${BUDGET_USD} model=${MODEL}${resumeFrom ? ' [RESUME]' : ''}`);
const result = await runFlywheelGenerations({
  rootPolicy: { editPolicy: '', escalationPolicy: '', verifierPolicy: '' },
  proposer, evaluator, promotionRule: meetsPromotionRule,
  holdout: { id: 'swebench-holdout', items: holdout },
  anchor: { id: 'swebench-anchor', items: anchor },
  maxGenerations: GENERATIONS, signer: makeSigner(), dataSource: 'LIVE',
  mutationTargets: TARGETS,
  budget: { total: BUDGET_USD, spent: () => spend },
  resumeFrom,
  // Incremental checkpoint: a LIVE agentic run spans HOURS; persist a complete, replay-verifiable
  // bundle + the resume state after each generation so a crash/OOM/rate-limit keeps the generations
  // already completed AND can CONTINUE (--resume) instead of re-spending from generation 1.
  onGeneration: (info) => {
    writeFileSync(ckpt, JSON.stringify({ partialBundle: info.partialBundle, resumeState: info.resumeState, spent: info.spent }, null, 2));
    console.log(`[checkpoint] gen ${info.generation}/${GENERATIONS} persisted (spend=$${info.spent.toFixed(4)}) → ${ckpt}`);
  },
});

writeFileSync(out, JSON.stringify(result.replayBundle, null, 2));
// ADR-235 — also RE-EXECUTE the gate: every promoted commit must re-pass meetsPromotionRule on its sealed
// scores (catches a forged promotion the frozen gate wouldn't grant — not just a changed fingerprint).
const v = verifyReplayBundle(result.replayBundle, { pinnedGateFingerprint: gateFingerprint(meetsPromotionRule), promotionRule: meetsPromotionRule });
console.log('\n── LIFT CURVE (resolved, root→current) ──');
for (const p of result.liftCurve) console.log(`  gen${p.generation}: resolved=${p.primary}/${holdout.length} ${p.delta > 0 ? `(+${p.delta})` : ''} anchor=${p.anchor}/${anchor.length}`);
console.log(`\nspend=$${spend.toFixed(4)} | verified=${result.replayBundle.verified_improvements} anchor-surviving=${result.replayBundle.anchor_surviving_improvements} milestone=${result.milestoneReached}`);
console.log(`replay: ${v.pass ? 'PASS' : 'FAIL'} | bundle: ${out}`);

// F-P2 mutation-effectiveness + cost economics — auto-emitted so the D1-S5 evidence package includes
// WHICH policy levers earned promotions and at what cost (not just the lift curve). Also written as a
// durable, machine-readable artifact next to the proof bundle.
const analysis = analyzeBundle(result.replayBundle);
const analysisOut = join(HERE, 'analyze-swebench.json');
writeFileSync(analysisOut, JSON.stringify(analysis, null, 2));
console.log('\n' + formatAnalysis(analysis, `${SOLVER} run`).join('\n'));
console.log(`analysis artifact: ${analysisOut}`);
console.log('SCOPE: REAL SWE-bench (official harness gold-scored). This is domain evidence, not the reasoning proxy.');
