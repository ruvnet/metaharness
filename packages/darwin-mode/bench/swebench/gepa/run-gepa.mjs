// SPDX-License-Identifier: MIT
//
// ADR-228 §9.4/§9.5 — the REAL GEPA run: wires gepaOptimize (gepa-loop.mjs) to
//   evaluate = a subprocess call to evaluate-genome.mjs (rollouts + gold scoring + ASI), and
//   reflect  = an OpenRouter completion on the reflection model (Sonnet-5 for the pilot — the
//              reflection LM is separate from and stronger than the task LM, per GEPA's design).
//
// PAID + GATED (ADR-228 §9.5): run ONLY if OpenRouter headroom ≥ $50 AND the 4 fadv arms have
// finished. Budget is a HARD dollar cap across evaluator rollouts + reflection calls; the loop
// also stops at --max-candidates evaluations. Holdout: after optimization, the seed and the best
// candidate are evaluated on the holdout slice (--skip trainN) and reported honestly — the
// promotion decision reads the HOLDOUT delta, never the training-slice score (§8 mitigations).
//
// Pilot command (GLM genome, medium-12 train / other-12 holdout, ≤$25 hard):
//   OPENROUTER_API_KEY=$(cat /tmp/.orkey) node gepa/run-gepa.mjs \
//     --seed gepa/seed-genome.json --model z-ai/glm-5.2 \
//     --manifest advisor-medium-25.json --train-first 12 \
//     --reflection-model anthropic/claude-sonnet-5 \
//     --max-candidates 15 --max-cost 25 --out gepa/pilot-result.json

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gepaOptimize } from './gepa-loop.mjs';
import { loadGenome } from './genome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, '..');
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(BENCH, p));

const seedPath = rel(argv('--seed', 'gepa/seed-genome.json'));
const model = argv('--model', 'z-ai/glm-5.2');
const manifest = argv('--manifest', 'advisor-medium-25.json');
const trainFirst = +argv('--train-first', 12);
const reflectionModel = argv('--reflection-model', 'anthropic/claude-sonnet-5');
const maxCandidates = +argv('--max-candidates', 15);
const maxCost = +argv('--max-cost', 25);           // HARD $ cap: evaluator + reflection combined
const maxSteps = +argv('--max-steps', 12);
const concurrency = +argv('--concurrency', 2);
const perEvalCost = +argv('--per-eval-max-cost', 3); // solve-advisor --max-cost per rollout batch
const outPath = rel(argv('--out', 'gepa/pilot-result.json'));
const reflective = argv('--reflective', 'gepa/reflective-dataset.json');
const noHoldout = args.includes('--no-holdout');
const workDir = rel(argv('--work-dir', 'gepa/runs'));
mkdirSync(workDir, { recursive: true });

const KEY = (process.env.OPENROUTER_API_KEY || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
if (!KEY) { console.error('FATAL: no OPENROUTER_API_KEY'); process.exit(1); }

// ── reflect: one stateless completion on the reflection model (temp 0) ────────────────────────────
async function reflect(prompt) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: reflectionModel, messages: [{ role: 'user', content: prompt }], max_tokens: 2048, temperature: 0 }),
      });
      if (!res.ok && (res.status === 429 || res.status >= 500)) { lastErr = new Error(`http ${res.status}`); continue; }
      const j = await res.json();
      return { raw: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0 };
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('reflection llm failed');
}

// ── evaluate: subprocess to evaluate-genome.mjs on a slice ────────────────────────────────────────
let evalN = 0;
function runEvaluator(genomeFile, { skip, first, tag }) {
  const out = join(workDir, `eval-${tag}.json`);
  execFileSync('node', ['--no-warnings', join(HERE, 'evaluate-genome.mjs'),
    '--genome', genomeFile, '--manifest', manifest, '--skip', String(skip), '--first', String(first),
    '--model', model, '--max-steps', String(maxSteps), '--concurrency', String(concurrency),
    '--max-cost', String(perEvalCost), '--reflective', reflective,
    '--run-id', `gepa_${tag}`.replace(/[^a-zA-Z0-9_]/g, '_'), '--out', out,
  ], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 4 * 3600 * 1000, env: { ...process.env, OPENROUTER_API_KEY: KEY } });
  return JSON.parse(readFileSync(out, 'utf8'));
}
async function evaluate(genome) {
  evalN++;
  const tag = `${String(evalN).padStart(2, '0')}-${(genome.meta?.id || 'genome').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const gfile = join(workDir, `genome-${tag}.json`);
  writeFileSync(gfile, JSON.stringify(genome, null, 2));
  const r = runEvaluator(gfile, { skip: 0, first: trainFirst, tag });
  console.error(`[gepa] eval #${evalN} ${genome.meta?.id}: gold ${r.goldResolved}/${r.n} sum=${r.sumScore} $${r.cost}`);
  return { scores: r.scores, feedbacks: r.feedbacks, cost: r.cost, metricCalls: r.metricCalls };
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────
const seed = loadGenome((p) => readFileSync(p, 'utf8'), seedPath);
console.error(`[gepa] seed=${seed.meta?.id} model=${model} reflector=${reflectionModel} train=first-${trainFirst} of ${manifest} | caps: ${maxCandidates} candidates, $${maxCost} hard`);

const result = await gepaOptimize({
  seed, evaluate, reflect,
  maxCandidates, maxCost, maxStall: 8,
  onEvent: (ev, d) => console.error(`[gepa] ${ev}: ${JSON.stringify(d)}`),
});

console.error(`[gepa] optimization done: pool=${result.pool.length} frontier=${JSON.stringify(result.frontier)} best=${result.best} budget=$${result.budget.totalCost.toFixed(2)} (${result.budget.metricCalls} metric calls)`);

// ── holdout: seed + best candidate on the UNSEEN slice (the honest number) ────────────────────────
let holdout = null;
if (!noHoldout && result.best) {
  const total = JSON.parse(readFileSync(rel(manifest), 'utf8')).instances.length;
  const holdN = total - trainFirst;
  if (holdN > 0 && result.budget.totalCost < maxCost) {
    const bestEntry = result.pool.find((c) => c.id === result.best);
    const seedFile = join(workDir, 'genome-holdout-seed.json'); writeFileSync(seedFile, JSON.stringify(seed, null, 2));
    const bestFile = join(workDir, 'genome-holdout-best.json'); writeFileSync(bestFile, JSON.stringify(bestEntry.genome, null, 2));
    const hs = runEvaluator(seedFile, { skip: trainFirst, first: holdN, tag: 'holdout-seed' });
    const hb = result.best === seed.meta?.id ? hs : runEvaluator(bestFile, { skip: trainFirst, first: holdN, tag: 'holdout-best' });
    holdout = {
      n: holdN,
      seed: { gold: hs.goldResolved, sum: hs.sumScore, mean: hs.meanScore, cost: hs.cost },
      best: { id: result.best, gold: hb.goldResolved, sum: hb.sumScore, mean: hb.meanScore, cost: hb.cost },
      goldDelta: hb.goldResolved - hs.goldResolved,
    };
    console.error(`[gepa] HOLDOUT (n=${holdN}): seed gold ${hs.goldResolved} vs best gold ${hb.goldResolved} (Δ${holdout.goldDelta >= 0 ? '+' : ''}${holdout.goldDelta})`);
  } else console.error('[gepa] holdout skipped (no instances left or budget exhausted)');
}

writeFileSync(outPath, JSON.stringify({
  ranAt: new Date().toISOString(), seed: seed.meta?.id, model, reflectionModel, manifest, trainFirst,
  caps: { maxCandidates, maxCost, perEvalCost, maxSteps },
  frontier: result.frontier, winners: result.winners, best: result.best, bestMean: result.bestMean,
  budget: result.budget, history: result.history, holdout,
  pool: result.pool, // full genomes included — the frontier IS the deliverable, not one winner (§8)
}, null, 2));
console.error(`[gepa] DONE → ${outPath}`);
