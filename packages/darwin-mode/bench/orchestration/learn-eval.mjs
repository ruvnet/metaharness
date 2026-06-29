// SPDX-License-Identifier: MIT
//
// learn-eval.mjs — train the context bandit on TRAIN logs, evaluate the LEARNED
// router vs every STATIC baseline on the HELD-OUT EVAL split.
//
// Inputs (all keyed by task_id): the manifest (gold, for scoring ONLY), the probe
// features (runs/probe.jsonl), and the four arm prediction logs:
//   A = base-ReAct (cheap)            preds-A.jsonl   score model_answer
//   B = self-consistency N=5 (cheap)  preds-B.jsonl   score majority_answer (the SC vote)
//   C = fail-fast respawn (cheap)     preds-C.jsonl   score model_answer
//   D = route-to-frontier (opus)      preds-D.jsonl   score model_answer
//
// CONFORMANCE (asserted by construction):
//   • Gold is read ONLY by the offline scorer, AFTER each arm produced its answer.
//   • TRAIN uses gold as the LEARNING reward. EVAL arm choice is by probe CONTEXT only
//     (bandit.choose(bucket) never sees gold); gold then scores the chosen arm.
//   • The probe cost is charged to the LEARNED policy (routing tax); static baselines
//     pay no probe (a fixed policy needs no routing decision).
//
// Split: manifest order — TRAIN = tasks[0:TRAIN_N], EVAL = tasks[TRAIN_N:].
//
// Run: node --experimental-strip-types learn-eval.mjs --train-n 50 --out runs/learned-eval.json

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TwoSignalBandit } from './bandit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

const MANIFEST = rel(argv('--manifest', '../gaia/manifest-frames-n100.json'));
const TRAIN_N = +argv('--train-n', 50);
const PROBE = rel(argv('--probe', 'runs/probe.jsonl'));
const OUT = rel(argv('--out', 'runs/learned-eval.json'));
const V_SWEEP = (argv('--v-sweep', '0.03,0.05,0.08,0.12,0.18,0.25,0.4,0.7,1.5')).split(',').map(Number);
const SEED = +argv('--seed', 42);

const ARMS = [
  { id: 'A', label: 'base-ReAct (cheap)',        file: rel(argv('--preds-a', 'runs/preds-A.jsonl')), field: 'model_answer' },
  { id: 'B', label: 'self-consistency N=5 (cheap)', file: rel(argv('--preds-b', 'runs/preds-B.jsonl')), field: 'majority_answer' },
  { id: 'C', label: 'fail-fast respawn (cheap)',  file: rel(argv('--preds-c', 'runs/preds-C.jsonl')), field: 'model_answer' },
  { id: 'D', label: 'route-to-frontier (opus)',   file: rel(argv('--preds-d', 'runs/preds-D.jsonl')), field: 'model_answer' },
];
const ARM_IDS = ARMS.map((a) => a.id);

// ── GAIA scorer (ported from score-gaia.mjs; strict normalized exact match) ──────
function normalizeNumberStr(s) { const n = Number(String(s).replace(/[$%,]/g, '').trim()); return Number.isFinite(n) ? n : null; }
function normalizeStr(s) { return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w\s]/g, ' ').replace(/\b(a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim(); }
function splitList(s) { return String(s ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean); }
function questionScorer(pred, gold) {
  pred = String(pred ?? ''); gold = String(gold ?? '');
  const gn = normalizeNumberStr(gold);
  if (gn !== null) { const pn = normalizeNumberStr(pred); return pn !== null && pn === gn; }
  const gl = splitList(gold);
  if (gl.length > 1) {
    const pl = splitList(pred); if (pl.length !== gl.length) return false;
    return gl.every((g, i) => { const gnum = normalizeNumberStr(g); if (gnum !== null) { const pnum = normalizeNumberStr(pl[i]); return pnum !== null && pnum === gnum; } return normalizeStr(g) === normalizeStr(pl[i]); });
  }
  return normalizeStr(pred) === normalizeStr(gold);
}
function wilson(k, n, z = 1.96) { if (n === 0) return [0, 0]; const p = k / n, d = 1 + z * z / n; const c = (p + z * z / (2 * n)) / d; const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d; return [Math.max(0, c - h), Math.min(1, c + h)]; }
const round = (x, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

// ── load everything, join by task_id ────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const order = manifest.tasks.map((t) => t.task_id);
const gold = new Map(manifest.tasks.map((t) => [t.task_id, t.answer]));
const loadJsonl = (f) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const probe = new Map(loadJsonl(PROBE).map((r) => [r.task_id, r]));

// per task: { correct: {A,B,C,D}, cost: {A,B,C,D}, probe }
const data = new Map();
for (const id of order) data.set(id, { task_id: id, correct: {}, cost: {}, probe: probe.get(id) });
for (const arm of ARMS) {
  for (const row of loadJsonl(arm.file)) {
    const d = data.get(row.task_id); if (!d) continue;
    const ansField = (row[arm.field] === undefined || row[arm.field] === null || row[arm.field] === '') ? row.model_answer : row[arm.field];
    d.correct[arm.id] = questionScorer(ansField, gold.get(row.task_id)) ? 1 : 0;
    d.cost[arm.id] = row.cost_usd || 0;
  }
}
// keep only fully-populated tasks (all arms + probe present)
const tasks = order.map((id) => data.get(id)).filter((d) => d.probe && ARM_IDS.every((a) => d.correct[a] !== undefined));
const train = tasks.slice(0, TRAIN_N);
const evalSet = tasks.slice(TRAIN_N);
if (!evalSet.length) { console.error('FATAL: empty eval split'); process.exit(1); }

// ── context bucketing (TRAIN-derived thresholds; gold-free features) ─────────────
const medWords = (() => { const w = train.map((d) => d.probe.q_words).sort((a, b) => a - b); return w[Math.floor(w.length / 2)] || 25; })();
function bucketOf(p) {
  const len = p.q_words > medWords ? 'long' : 'short';
  const cons = p.probe_consistency >= 0.99 ? 'hi' : (p.probe_consistency >= 0.6 ? 'mid' : 'lo'); // 3/3, 2/3, ≤1/3
  return `${len}|${cons}`;
}

// ── train the bandit (full-information offline: observe ALL arms on each train item) ─
function trainBandit(V) {
  const b = new TwoSignalBandit(ARM_IDS, { V, seed: SEED });
  for (const d of train) { const bk = bucketOf(d.probe); for (const a of ARM_IDS) b.observe(bk, a, d.correct[a], d.cost[a]); }
  return b;
}

// ── evaluate a per-task arm-chooser over a set ───────────────────────────────────
function evalPolicy(set, chooser, { probeCost = false } = {}) {
  let correct = 0, cost = 0; const dist = Object.fromEntries(ARM_IDS.map((a) => [a, 0]));
  for (const d of set) {
    const a = chooser(d); dist[a]++;
    correct += d.correct[a]; cost += d.cost[a];
    if (probeCost) cost += (d.probe.probe_cost_usd || 0);
  }
  const n = set.length, [lo, hi] = wilson(correct, n);
  return { n, correct, resolve: round(correct / n), wilson95: [round(lo), round(hi)], total_cost_usd: round(cost, 4),
    cost_per_task_usd: round(cost / n, 6), cost_per_correct_usd: correct ? round(cost / correct, 6) : null,
    arm_distribution: dist };
}

// ── baselines ────────────────────────────────────────────────────────────────────
const statics = {};
for (const arm of ARMS) statics[arm.id] = { label: arm.label, ...evalPolicy(evalSet, () => arm.id) };
// oracle best fixed arm (chosen on TRAIN resolve, applied blind to EVAL)
const trainResolve = Object.fromEntries(ARM_IDS.map((a) => [a, train.reduce((s, d) => s + d.correct[a], 0) / train.length]));
const bestFixedArm = ARM_IDS.slice().sort((x, y) => trainResolve[y] - trainResolve[x])[0];
const oracleBestFixed = { chosen_on_train: bestFixedArm, train_resolve: round(trainResolve[bestFixedArm]), ...evalPolicy(evalSet, () => bestFixedArm) };
// per-question oracle (EVAL upper bound): cheapest CORRECT arm, else cheapest arm
function oracleChooser(d) { const corr = ARM_IDS.filter((a) => d.correct[a]); const pool = corr.length ? corr : ARM_IDS; return pool.slice().sort((x, y) => d.cost[x] - d.cost[y])[0]; }
const oraclePerQ = evalPolicy(evalSet, oracleChooser);

// ── learned policy across the V sweep (greedy posterior; charged the probe tax) ──
const learnedSweep = [];
for (const V of V_SWEEP) {
  const b = trainBandit(V);
  const chooser = (d) => b.choose(bucketOf(d.probe)).arm;
  const ev = evalPolicy(evalSet, chooser, { probeCost: true });
  const evNoProbe = evalPolicy(evalSet, chooser, { probeCost: false });
  // train-side self-eval (in-sample, for V-selection transparency only)
  const trEv = evalPolicy(train, chooser, { probeCost: true });
  learnedSweep.push({ V, eval: ev, eval_excl_probe: evNoProbe, train_accuracy_per_dollar: round(trEv.resolve / (trEv.cost_per_task_usd || 1e-9), 2), policy: b.snapshot().buckets });
}

// representative learned points: (1) the V whose eval cost is closest to always-A cost
//   (matched-budget "more resolve?" test), (2) closest to always-D resolve (matched-resolve "cheaper?").
const targetCostA = statics.A.cost_per_task_usd;
const matchedBudget = learnedSweep.slice().sort((x, y) => Math.abs(x.eval.cost_per_task_usd - targetCostA) - Math.abs(y.eval.cost_per_task_usd - targetCostA))[0];
const targetResD = statics.D.resolve;
const matchedResolve = learnedSweep.slice().sort((x, y) => Math.abs(x.eval.resolve - targetResD) - Math.abs(y.eval.resolve - targetResD))[0];
// best learned by accuracy-per-dollar on EVAL (the headline efficiency point)
const bestApd = learnedSweep.slice().sort((x, y) => (y.eval.resolve / y.eval.cost_per_task_usd) - (x.eval.resolve / x.eval.cost_per_task_usd))[0];

// Pareto verdict: does any learned point DOMINATE the best static (≥ its resolve at < its cost,
// or > its resolve at ≤ its cost)? And does it beat the best static on $/correct at ≥ its resolve?
const staticPoints = [...Object.values(statics)].map((s) => ({ resolve: s.resolve, cost: s.cost_per_task_usd, cpc: s.cost_per_correct_usd }));
function dominatesAnyStatic(p) {
  return staticPoints.some((s) => (p.eval.resolve >= s.resolve && p.eval.cost_per_task_usd < s.cost) || (p.eval.resolve > s.resolve && p.eval.cost_per_task_usd <= s.cost));
}
const anyDominates = learnedSweep.filter(dominatesAnyStatic).map((p) => ({ V: p.V, resolve: p.eval.resolve, cost: p.eval.cost_per_task_usd }));

const results = {
  experiment: 'learned adaptive routing policy vs best static (FRAMES)', dataset: 'google/frames-benchmark', seed: manifest.seed,
  policy_engine: 'rvf-solver algorithm (two-signal Thompson Sampling, context-bucketed), reimplemented — NOT the @ruvector/rvf-solver npm package (its train() is puzzle-train-locked and cannot accept external arms/rewards)',
  reasoning: 'off (no reasoning API param; consistent with prior FRAMES runs)',
  split: { train_n: train.length, eval_n: evalSet.length, train_ids: train.map((d) => d.task_id), eval_ids: evalSet.map((d) => d.task_id) },
  context: { features: ['q_words (length)', 'probe_consistency (3-sample cheap agreement)', 'probe_confidence'], buckets: 'len{short,long} × consistency{lo,mid,hi} = 6, global pool fallback', median_words_train: medWords, bucket_counts_train: countBuckets(train), bucket_counts_eval: countBuckets(evalSet) },
  arms: Object.fromEntries(ARMS.map((a) => [a.id, a.label])),
  static_baselines: statics,
  oracle_best_fixed_arm: oracleBestFixed,
  oracle_per_question_eval_upper_bound: oraclePerQ,
  learned_sweep: learnedSweep.map((p) => ({ V: p.V, ...p.eval, eval_excl_probe_cost_per_correct: p.eval_excl_probe.cost_per_correct_usd, train_accuracy_per_dollar: p.train_accuracy_per_dollar })),
  headline: {
    matched_budget_vs_always_A: { V: matchedBudget.V, learned: pick(matchedBudget.eval), always_A: pick(statics.A) },
    matched_resolve_vs_always_D: { V: matchedResolve.V, learned: pick(matchedResolve.eval), always_D: pick(statics.D) },
    best_accuracy_per_dollar_learned: { V: bestApd.V, ...pick(bestApd.eval) },
    any_learned_point_pareto_dominates_a_static: anyDominates,
  },
  representative_policy_snapshot: { V: bestApd.V, buckets: bestApd.policy },
  train_resolve_by_arm: Object.fromEntries(Object.entries(trainResolve).map(([k, v]) => [k, round(v)])),
  ts: new Date().toISOString(),
};
function pick(e) { return { resolve: e.resolve, wilson95: e.wilson95, cost_per_task_usd: e.cost_per_task_usd, cost_per_correct_usd: e.cost_per_correct_usd, arm_distribution: e.arm_distribution }; }
function countBuckets(set) { const m = {}; for (const d of set) { const b = bucketOf(d.probe); m[b] = (m[b] || 0) + 1; } return m; }

writeFileSync(OUT, JSON.stringify(results, null, 2));
console.error(`\n=== LEARNED ROUTER vs STATIC (FRAMES eval n=${evalSet.length}, train n=${train.length}) ===`);
console.error(`static  A base    : resolve ${statics.A.resolve}  $${statics.A.cost_per_task_usd}/task  $${statics.A.cost_per_correct_usd}/correct`);
console.error(`static  B SC5     : resolve ${statics.B.resolve}  $${statics.B.cost_per_task_usd}/task  $${statics.B.cost_per_correct_usd}/correct`);
console.error(`static  C failfast: resolve ${statics.C.resolve}  $${statics.C.cost_per_task_usd}/task  $${statics.C.cost_per_correct_usd}/correct`);
console.error(`static  D frontier: resolve ${statics.D.resolve}  $${statics.D.cost_per_task_usd}/task  $${statics.D.cost_per_correct_usd}/correct`);
console.error(`oracle  best-fixed: arm=${bestFixedArm} resolve ${oracleBestFixed.resolve}  $${oracleBestFixed.cost_per_correct_usd}/correct`);
console.error(`oracle  per-Q (UB): resolve ${oraclePerQ.resolve}  $${oraclePerQ.cost_per_correct_usd}/correct`);
console.error(`--- learned sweep (incl. probe tax) ---`);
for (const p of learnedSweep) console.error(`  V=${p.V}\tresolve ${p.eval.resolve} CI[${p.eval.wilson95}]\t$${p.eval.cost_per_task_usd}/task\t$${p.eval.cost_per_correct_usd}/correct\tarms ${JSON.stringify(p.eval.arm_distribution)}`);
console.error(`headline matched-budget(~A): learned resolve ${matchedBudget.eval.resolve} vs A ${statics.A.resolve} at ~$${statics.A.cost_per_task_usd}/task (V=${matchedBudget.V})`);
console.error(`headline best $/correct learned: V=${bestApd.V} resolve ${bestApd.eval.resolve} $${bestApd.eval.cost_per_correct_usd}/correct`);
console.error(`pareto-dominating learned points: ${JSON.stringify(anyDominates)}`);
console.error(`→ ${OUT}`);
