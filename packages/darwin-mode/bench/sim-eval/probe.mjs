// SPDX-License-Identifier: MIT
//
// Study v2 proposer probe (#523). NO SIM context anywhere. Measures, per
// (model, system line, surface), the share of single proposals on the BASELINE
// surface file that raise the TRAIN solve rate. It also records validator
// rejections and held-out, to spot a ceiling. Every call goes through the
// shared spend guard and ledger.
//
// Pre-declared selection rule (written before running):
//   For each model family, take the cheapest (input+output $/M) configuration whose train-raise
//   rate is >= 25% on BOTH surfaces (contextBuilder on `loc`, retryPolicy on
//   `per`). Prefer 'stock' over 'behaviour' when both qualify at the same model.
//   Study v2 needs two qualifying families; otherwise it is not run.
//
//   OPENROUTER_API_KEY=... node packages/darwin-mode/bench/sim-eval/probe.mjs [--calls 10]

import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';
import { validateGeneratedCode, FILE_BY_SURFACE } from '../../dist/safety.js';
import { summarizeFailedTraces } from '../../dist/mutator.js';
import { runVariantTasksAgent } from '../../dist/tier2-sandbox.js';
import { GuardedOpenRouterProposer } from './proposer.mjs';
import { SpendGuard } from './spend-guard.mjs';

export const PROBE_MODELS = Object.freeze([
  { id: 'google/gemini-2.5-flash-lite', family: 'google', inPerM: 0.10, outPerM: 0.40 },
  { id: 'google/gemini-3.1-flash-lite', family: 'google', inPerM: 0.25, outPerM: 1.50 },
  { id: 'openai/gpt-4.1-nano', family: 'openai', inPerM: 0.10, outPerM: 0.40 },
  { id: 'openai/gpt-4.1-mini', family: 'openai', inPerM: 0.40, outPerM: 1.60 },
  { id: 'deepseek/deepseek-chat-v3.1', family: 'deepseek', inPerM: 0.25, outPerM: 0.95 },
  { id: 'qwen/qwen3-coder', family: 'qwen', inPerM: 0.30, outPerM: 1.00 },
]);
const CASES = [{ bench: 'loc', surface: 'contextBuilder' }, { bench: 'per', surface: 'retryPolicy' }];

const here = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const calls = Number(args[args.indexOf('--calls') + 1] || 10);
const apiKey = (process.env.OPENROUTER_API_KEY ?? '').trim();
if (!apiKey) throw new Error('OPENROUTER_API_KEY must be set');
const parts = JSON.parse(await readFile(join(here, 'tasks.json'), 'utf8')).partitions;
const resultsDir = join(here, 'results');
const guard = new SpendGuard({ capUsd: 40, ledgerPath: join(resultsDir, 'spend-ledger.jsonl') });

const root = await mkdtemp(join(tmpdir(), 'sim-probe-'));
await mkdir(join(root, 'repo', 'src'), { recursive: true });
await writeFile(join(root, 'repo', 'package.json'), '{"name":"probe","version":"1.0.0","scripts":{"test":"node --test"}}');
const base = await generateBaselineHarness(await profileRepo(join(root, 'repo')), join(root, 'work'));
const solved = (ts) => ts.filter((t) => t.exitCode === 0).length / ts.length;
const baseline = {};
for (const c of CASES) {
  const tr = await runVariantTasksAgent(base, parts[c.bench].train);
  baseline[c.bench] = { train: solved(tr), failed: summarizeFailedTraces(tr) };
}

let n = 0;
async function probeOne(model, system, c) {
  const p = new GuardedOpenRouterProposer({
    model: model.id, pricing: model, guard, apiKey, system, trainTasks: parts[c.bench].train,
    meta: { run: `probe:${model.id}:${system}:${c.surface}` },
  });
  const file = FILE_BY_SURFACE[c.surface];
  const parentCode = await readFile(join(base.dir, file), 'utf8');
  const out = await p.generateMutation({
    parentCode, surface: c.surface, repoSummary: '', parentScore: 0, failedTraces: baseline[c.bench].failed, nonce: 0,
  });
  const violations = validateGeneratedCode(out.code);
  let train = baseline[c.bench].train;
  let held = null;
  if (violations.length === 0 && out.code !== parentCode) {
    const dir = join(root, `v${n++}`);
    await cp(base.dir, dir, { recursive: true });
    await writeFile(join(dir, file), out.code);
    const v = { ...base, id: `probe${n}`, dir };
    train = solved(await runVariantTasksAgent(v, parts[c.bench].train));
    held = solved(await runVariantTasksAgent(v, parts[c.bench].heldout));
  }
  return {
    model: model.id, family: model.family, system, bench: c.bench, surface: c.surface,
    rejected: violations.length > 0, unchanged: out.code === parentCode, failed: p.telemetry.failures > 0,
    raisedTrain: train > baseline[c.bench].train, train, held, costUsd: p.telemetry.costUsd, summary: out.summary.slice(0, 200),
  };
}

const jobs = [];
for (const model of PROBE_MODELS) for (const system of ['stock', 'behaviour']) for (const c of CASES) {
  for (let i = 0; i < calls; i++) jobs.push([model, system, c]);
}
const rows = [];
const queue = jobs.slice();
await Promise.all(Array.from({ length: 12 }, async () => {
  while (queue.length) {
    const row = await probeOne(...queue.shift());
    rows.push(row);
    appendFileSync(join(resultsDir, 'raw-probe.jsonl'), JSON.stringify(row) + '\n');
  }
}));

const table = [];
for (const model of PROBE_MODELS) for (const system of ['stock', 'behaviour']) {
  const cell = (surface) => rows.filter((r) => r.model === model.id && r.system === system && r.surface === surface);
  const rate = (rs, f) => rs.filter(f).length / Math.max(1, rs.length);
  const cb = cell('contextBuilder');
  const rp = cell('retryPolicy');
  table.push({
    model: model.id, family: model.family, system, pricePerM: model.inPerM + model.outPerM,
    locRaise: rate(cb, (r) => r.raisedTrain), perRaise: rate(rp, (r) => r.raisedTrain),
    rejected: rate(cb.concat(rp), (r) => r.rejected), failed: rate(cb.concat(rp), (r) => r.failed),
    locHeldMax: Math.max(0, ...cb.map((r) => r.held ?? 0)), perHeldMax: Math.max(0, ...rp.map((r) => r.held ?? 0)),
    costUsd: cb.concat(rp).reduce((s, r) => s + r.costUsd, 0),
  });
}
console.log(JSON.stringify({ baseline: { loc: baseline.loc.train, per: baseline.per.train }, spend: guard.snapshot(), table }, null, 1));
