// SPDX-License-Identifier: MIT
//
// #523 sealed three-arm SIM evaluation — orchestrator.
//
//   $0 dry run (mock proposer, tiny design, no network):
//     node packages/darwin-mode/bench/sim-eval/run.mjs --dry
//   Live (real OpenRouter spend, hard-capped; key from env only):
//     OPENROUTER_API_KEY=... node packages/darwin-mode/bench/sim-eval/run.mjs --live --phase smoke|source|target
//
// Results append to <out>/raw-<phase>.jsonl (resumable: finished run ids are
// skipped). Every live call is reserved against, then settled into, the shared
// append-only spend ledger <out>/spend-ledger.jsonl before the next one starts.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeRun, storePath } from './execute.mjs';
import {
  DRY_DESIGN, EXPECTED_TASKS_SHA256, LIVE_DESIGN, MODELS, PREREG_ID, calibSpecs, smokeSpecs, sourceSpecs, targetSpecs,
} from './plan.mjs';
import { EVAL_BRIEF, GuardedOpenRouterProposer, MockProposer, summarizeTelemetry } from './proposer.mjs';
import { SpendCapError, SpendGuard, parseCap } from './spend-guard.mjs';
import { partitionHash } from './tasks.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgDir = resolve(here, '../..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const live = flag('--live');
const dry = flag('--dry') || !live;
if (live && flag('--dry')) throw new Error('choose one of --live / --dry');
const design = dry ? DRY_DESIGN : LIVE_DESIGN;
const phase = opt('--phase', dry ? 'all' : undefined);
if (!['smoke', 'calib', 'source', 'target', 'all'].includes(phase)) throw new Error('--phase smoke|calib|source|target|all is required');
if (live && phase === 'all') throw new Error('--live runs one phase at a time');
const outDir = resolve(opt('--out', dry ? join(tmpdir(), `sim-eval-dry-${process.pid}`) : join(here, 'results')));
const capUsd = parseCap(opt('--cap', String(design.capUsd)));
if (capUsd > LIVE_DESIGN.capUsd) throw new Error(`--cap may not exceed the pre-registered $${LIVE_DESIGN.capUsd}`);
const runConcurrency = Number(opt('--concurrency', String(design.runConcurrency)));

// ── Frozen inputs: refuse a live run on a drifted partition. ──
const tasksDoc = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'));
const tasksSha = partitionHash(tasksDoc.partitions);
if (tasksSha !== tasksDoc.sha256 || (live && tasksSha !== EXPECTED_TASKS_SHA256)) {
  throw new Error(`task partition hash mismatch: ${tasksSha} (expected ${EXPECTED_TASKS_SHA256})`);
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
// The tracked dist can lag src (it did at 7b3b91d9: no SIM wiring in dist/evolve.js).
// SIM arms on a stale dist would silently equal `off`, so refuse to run.
if (!readFileSync(join(pkgDir, 'dist/evolve.js'), 'utf8').includes('sim.store.context')) {
  throw new Error('dist/evolve.js has no SIM wiring — rebuild with `npx tsc` in packages/darwin-mode first');
}
const git = (...a) => { try { return execFileSync('git', a, { cwd: pkgDir, encoding: 'utf8' }).trim(); } catch { return null; } };
let rvfVersion = null;
try {
  const entry = fileURLToPath(import.meta.resolve('@ruvector/rvf'));
  const pj = join(entry.slice(0, entry.lastIndexOf('@ruvector/rvf') + '@ruvector/rvf'.length), 'package.json');
  rvfVersion = JSON.parse(readFileSync(pj, 'utf8')).version;
} catch { /* optional dependency absent ⇒ lexical retrieval */ }
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const provenance = {
  prereg: PREREG_ID, mode: dry ? 'dry' : 'live', phase, startedAt: new Date().toISOString(),
  gitSha: git('rev-parse', 'HEAD'), gitDirty: (git('status', '--porcelain', '--', 'src', 'bench/sim-eval') ?? '') !== '',
  node: process.version, darwinVersion: pkg.version, rvfVersion,
  tasks: { version: tasksDoc.version, sha256: tasksSha },
  grader: {
    driverSrcSha256: sha(join(pkgDir, 'src/tier2-driver.ts')),
    driverDistSha256: sha(join(pkgDir, 'dist/tier2-driver.js')),
    sandboxSrcSha256: sha(join(pkgDir, 'src/tier2-sandbox.ts')),
  },
  optimizer: {
    evolveSrcSha256: sha(join(pkgDir, 'src/evolve.ts')),
    evolveDistSha256: sha(join(pkgDir, 'dist/evolve.js')),
    simMemorySrcSha256: sha(join(pkgDir, 'src/sim-memory.ts')),
  },
  evalBriefSha256: createHash('sha256').update(EVAL_BRIEF).digest('hex'),
  models: MODELS, design, capUsd,
};

mkdirSync(outDir, { recursive: true });
const storesDir = join(outDir, 'stores');
mkdirSync(storesDir, { recursive: true });
const scratchRoot = join(opt('--scratch', tmpdir()), `sim-eval-523-${process.pid}`);
mkdirSync(scratchRoot, { recursive: true });
appendFileSync(join(outDir, 'provenance.jsonl'), JSON.stringify(provenance) + '\n');

const guard = new SpendGuard({ capUsd, ledgerPath: dry ? null : join(outDir, 'spend-ledger.jsonl') });
const apiKey = live ? (process.env.OPENROUTER_API_KEY ?? '').trim() : '';
if (live && !apiKey) throw new Error('OPENROUTER_API_KEY must be set in the environment for --live');
const pricing = new Map(MODELS.map((m) => [m.id, m]));
const makeProposer = (spec) => (dry
  ? new MockProposer()
  : new GuardedOpenRouterProposer({
    model: spec.model, pricing: pricing.get(spec.model), guard, apiKey,
    maxTokens: design.proposerMaxTokens, temperature: design.temperature, meta: { run: spec.id },
  }));

const ctx = {
  partitions: tasksDoc.partitions, design, scratchRoot, storesDir, preregId: PREREG_ID,
  harnessVersion: pkg.version, makeProposer, summarize: summarizeTelemetry,
};

function done(file) {
  if (!existsSync(file)) return new Set();
  const ok = new Set();
  for (const r of readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) {
    if (r.supersededLane) for (const id of r.supersededLane) ok.delete(id);
    else if (!r.aborted) ok.add(r.id);
  }
  return ok;
}

let stopped = null;
async function runPhase(name, specs) {
  const file = join(outDir, `raw-${name}.jsonl`);
  const finished = done(file);
  let todo = specs.filter((s) => !finished.has(s.id));
  if (name === 'source') {
    // A source store is built by its lane's seeds in order. A partially built lane
    // is rebuilt from empty (store deleted, earlier rows superseded), never resumed.
    const partial = new Set(todo.map((s) => `${s.model}|${s.bench}`));
    for (const lane of partial) {
      const laneSpecs = specs.filter((s) => `${s.model}|${s.bench}` === lane);
      const [model, bench] = lane.split('|');
      const store = storePath(storesDir, model, bench);
      if (existsSync(store)) rmSync(store);
      appendFileSync(file, JSON.stringify({ supersededLane: laneSpecs.map((s) => s.id), at: new Date().toISOString() }) + '\n');
    }
    todo = specs.filter((s) => partial.has(`${s.model}|${s.bench}`));
  }
  console.error(`[${name}] ${todo.length}/${specs.length} runs to do; spend ${JSON.stringify(guard.snapshot())}`);
  // Source runs share one store per (model, bench): run those serially per store.
  const lanes = new Map();
  for (const s of todo) {
    const lane = name === 'source' ? `${s.model}|${s.bench}` : s.id;
    if (!lanes.has(lane)) lanes.set(lane, []);
    lanes.get(lane).push(s);
  }
  const queue = [...lanes.values()];
  let finishedCount = 0;
  async function worker() {
    while (queue.length && !stopped) {
      const lane = queue.shift();
      for (const spec of lane) {
        if (stopped) break;
        try {
          const row = await executeRun(spec, ctx);
          row.spendAfterUsd = guard.snapshot().spentUsd;
          appendFileSync(file, JSON.stringify(row) + '\n');
          finishedCount++;
          console.error(`[${name}] ${finishedCount}/${todo.length} ${spec.id} heldout=${row.value.toFixed(3)} ` +
            `cost=$${row.proposer.costUsd.toFixed(4)} total=$${guard.snapshot().spentUsd.toFixed(4)}`);
        } catch (e) {
          const capped = e instanceof SpendCapError || e?.code === 'SIM_EVAL_SPEND_CAP';
          if (capped) stopped = e.message;
          appendFileSync(file, JSON.stringify({ id: spec.id, phase: name, aborted: true, reason: String(e?.message ?? e).slice(0, 400) }) + '\n');
          console.error(`[${name}] ABORTED ${spec.id}: ${String(e?.message ?? e).slice(0, 200)}`);
          if (!capped && !dry) continue;
          if (dry) throw e;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, runConcurrency) }, worker));
}

const phases = phase === 'all' ? ['smoke', 'calib', 'source', 'target'] : [phase];
for (const p of phases) {
  if (stopped) break;
  const specs = p === 'smoke' ? smokeSpecs(design) : p === 'calib' ? calibSpecs(design) : p === 'source' ? sourceSpecs(design) : targetSpecs(design);
  await runPhase(p, specs);
}
const final = { ...guard.snapshot(), stoppedBySpendCap: stopped, outDir };
appendFileSync(join(outDir, 'provenance.jsonl'), JSON.stringify({ prereg: PREREG_ID, finishedAt: new Date().toISOString(), phase, spend: final }) + '\n');
console.log(JSON.stringify(final));
