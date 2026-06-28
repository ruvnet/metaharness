// SPDX-License-Identifier: MIT
//
// run-cognition.mjs — the A/B/C experiment driver for the "memory-as-cognition" test.
//
//   Condition A  baseline      single cold agentic solve (the ~0.42–0.50 reference)
//   Condition B  parallel-selves   K agenticow memory/context branches per question, a
//                              verifier-judge selects (verifier-gated BoN over branches)
//   Condition C  memory-evolution  Darwin-evolve a population of memory/context-shaping
//                              GENOMES (P gen0 → G generations); fitness = FRAMES resolve
//                              (gold used ONLY for fitness, NEVER fed into the solve loop)
//
// MEASURE: resolve + Wilson 95% CI per condition, $/task, total cost, lift (B−A, C_g3−C_g0).
// HONESTY: null/backfire is a valid result. Conformance firewall: solve sees only the
// question; gold touches only score()/fitness. Empty-response rate is audited per cell.
// Budget: --abort-usage is the ABSOLUTE OpenRouter USD ceiling (meter-gated); --max-cost
// is this run's incremental cap. If either trips, partial results are reported honestly.
//
// Run (real):
//   OPENROUTER_API_KEY=$K node packages/darwin-mode/bench/cognition/run-cognition.mjs \
//     --phase all --model deepseek/deepseek-v4-pro --n 40 --seed 42 --K 4 \
//     --pop 6 --gens 3 --meter --abort-usage 2738 --max-cost 60 \
//     --manifest ../ruvector/data/manifest-frames-n40.json --out runs
// Wiring test ($0): add --mock.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAction, stateHash } from '../swebench/agentic-loop.mjs';
import { searchWiki, openWiki } from '../gaia/wiki-tools.mjs';
import { mockDeps } from '../gaia/scaffolds.mjs';
import {
  embedText, wilson, questionScorer, EpisodeCache, buildEpisodicStore,
  solveSelf, solveParallel, genomeBranches, KINDS,
} from './cognition-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has = (f) => args.includes(f);
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

const PHASE = argv('--phase', 'all');                  // A | B | C | all
const MODEL = argv('--model', 'deepseek/deepseek-v4-pro');
const N = +argv('--n', 40);
const SEED = +argv('--seed', 42);
const K = +argv('--K', 4);                              // Condition B branch count
const POP = +argv('--pop', 6);
const GENS = +argv('--gens', 3);
const CONCURRENCY = Math.max(1, +argv('--concurrency', 6));
const MAX_STEPS = +argv('--max-steps', 12);
const MAX_OUT = +argv('--max-out', 6000);
const MOCK = has('--mock');
const METER = has('--meter');
const ABORT_USAGE = +argv('--abort-usage', Infinity);
const MAX_COST = +argv('--max-cost', Infinity);
const MANIFEST = rel(argv('--manifest', '../ruvector/data/manifest-frames-n40.json'));
const OUTDIR = rel(argv('--out', 'runs'));
const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const KEY_ENV = argv('--api-key-env', 'OPENROUTER_API_KEY');
const key = (process.env[KEY_ENV] || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
if (!key && !MOCK) { console.error('FATAL: no API key (OPENROUTER_API_KEY or /tmp/.orkey), or pass --mock'); process.exit(1); }
mkdirSync(OUTDIR, { recursive: true });

// ── manifest (gold kept ONLY for scoring; never passed into solve) ──────────────────
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const allTasks = manifest.tasks.slice(0, N);
const gold = new Map(allTasks.map((t) => [t.task_id, t.answer]));
// Firewall: the object handed to every solve path carries ONLY question + task_id + idx.
const solveTasks = allTasks.map((t, i) => ({ task_id: t.task_id, question: t.question, reasoning_types: t.reasoning_types, _idx: i }));

// ── OpenRouter client (mirrors solve-gaia mkLlm: retry, usage.cost capture) ─────────
function mkLlm(model) {
  return async function (messages, temp) {
    let lastErr;
    for (let a = 0; a < 5; a++) {
      if (a) await new Promise((r) => setTimeout(r, 2000 * 2 ** (a - 1)));
      try {
        const res = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/ruvnet/agent-harness-generator', 'X-Title': 'cognition-evolve-bench' },
          body: JSON.stringify({ model, messages, max_tokens: 1500, temperature: temp ?? 0, usage: { include: true } }),
        });
        if (!res.ok && (res.status === 429 || res.status >= 500)) { lastErr = new Error(`http ${res.status}`); continue; }
        const j = await res.json();
        return { raw: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0 };
      } catch (e) { lastErr = e; }
    }
    throw lastErr ?? new Error('llm failed');
  };
}
const deps = MOCK ? { ...mockDeps(), parseAction, stateHash } : { llm: mkLlm(MODEL), searchWiki, openWiki, parseAction, stateHash };
const opts = { model: MODEL, maxSteps: MAX_STEPS, maxOut: MAX_OUT };

// Bounded worker pool over a task list. SAFE for the episode cache: within any one
// condition/genome every item is a DISTINCT question → a distinct cache key, so no two
// in-flight workers ever compute the same episode (no duplicate spend). Genomes are
// evaluated serially, so cross-genome cache reuse is preserved. Results keep input order.
async function mapPool(items, conc, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      if (halted) return;
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
  return out.filter((x) => x !== undefined);
}

// ── budget meter (authoritative absolute-usage gate) ────────────────────────────────
let runCost = 0, halted = false, haltReason = '';
async function accountUsage() {
  try { const r = await fetch(`${BASE_URL}/key`, { headers: { Authorization: `Bearer ${key}` } }); const j = await r.json(); return Number(j?.data?.usage); }
  catch { return NaN; }
}
async function meterLoop() {
  if (!METER || !Number.isFinite(ABORT_USAGE) || MOCK) return;
  while (!halted) {
    const u = await accountUsage();
    if (Number.isFinite(u)) { console.error(`[meter] account usage $${u.toFixed(2)} / abort $${ABORT_USAGE} | run $${runCost.toFixed(2)}`); if (u >= ABORT_USAGE) { halted = true; haltReason = `account usage $${u.toFixed(2)} ≥ abort $${ABORT_USAGE}`; break; } }
    await new Promise((r) => setTimeout(r, 20000));
  }
}
function checkBudget() {
  if (halted) return false;
  if (runCost >= MAX_COST) { halted = true; haltReason = `run cost $${runCost.toFixed(2)} ≥ max-cost $${MAX_COST}`; return false; }
  return true;
}

const cache = new EpisodeCache(join(OUTDIR, 'episode-cache.json'));
let store = null; // episodic memory (agenticow), built after Condition A

// ── scoring helper ───────────────────────────────────────────────────────────────────
function scoreCell({ name, scaffold, rows, view = 'primary', extra = {} }) {
  let correct = 0, empty = 0, cost = 0;
  const ansField = view === 'majority' ? 'majority_answer' : 'answer';
  for (const r of rows) {
    const a = (r[ansField] ?? r.answer) || '';
    if (!String(a).trim()) empty++;
    if (questionScorer(a, gold.get(r.task_id))) correct++;
    cost += r.cost || 0;
  }
  const n = rows.length, acc = n ? correct / n : 0, [lo, hi] = wilson(correct, n);
  return { name, scaffold, view, n, correct, acc: round(acc, 4), ci: [round(lo, 4), round(hi, 4)],
    empty_rate: round(empty / (n || 1), 3), total_cost: round(cost, 4), cost_per_task: round(cost / (n || 1), 6),
    cost_per_correct: correct ? round(cost / correct, 6) : null, ...extra };
}
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
function saveJSON(name, obj) { writeFileSync(join(OUTDIR, name), JSON.stringify(obj, null, 2)); }
function appendPreds(name, rows) { writeFileSync(join(OUTDIR, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); }

// ════════════════════════════════════════════════════════════════════════════════════
// Condition A — single cold agentic solve (the reference). Also builds the episodic store.
// ════════════════════════════════════════════════════════════════════════════════════
async function runConditionA() {
  console.error(`\n=== Condition A (baseline, cold single solve) — n=${solveTasks.length} ===`);
  let done = 0;
  const rows = await mapPool(solveTasks, CONCURRENCY, async (task) => {
    if (!checkBudget()) return undefined;
    const r = await solveSelf(task, deps, { kind: 'cold', episodicK: 0, temp: 0, seed: 0 }, null, opts, cache);
    runCost += r.cost;
    console.error(`[A ${++done}/${solveTasks.length}] ${task.task_id} steps=${r.steps} $${r.cost.toFixed(4)}${r.cached ? ' (cache)' : ''} ans="${String(r.answer).slice(0, 40)}"`);
    return { task_id: task.task_id, answer: r.answer, notes: r.notes, steps: r.steps, submitted: r.submitted, cost: r.cost, reasoning_types: task.reasoning_types };
  });
  cache.flush();
  appendPreds('preds-A-baseline.jsonl', rows);
  const cell = scoreCell({ name: 'A-baseline', scaffold: 'cold-single', rows });
  saveJSON('results-A.json', cell);
  console.error(`[A] resolve ${cell.correct}/${cell.n}=${(cell.acc * 100).toFixed(1)}% CI[${(cell.ci[0] * 100).toFixed(1)},${(cell.ci[1] * 100).toFixed(1)}] $${cell.total_cost} ($${cell.cost_per_task}/task)`);
  return { cell, rows };
}

// Build the episodic store (agenticow) from Condition A episodes — the model's OWN prior
// attempts, recalled leave-one-out. GOLD-FREE: payload holds the model's answer + approach,
// never the manifest gold. Persists the .rvf so B/C reuse it.
function buildStoreFromA(aRows) {
  const byId = new Map(aRows.map((r) => [r.task_id, r]));
  const entries = solveTasks.map((t) => {
    const r = byId.get(t.task_id) || {};
    const payload = `Q: "${t.question.slice(0, 200)}" → my prior short answer was "${(r.answer || '(none)').slice(0, 80)}". Approach: ${String(r.notes || '').replace(/\s+/g, ' ').slice(0, 200)}`;
    return { question: t.question, payload };
  });
  store = buildEpisodicStore(join(OUTDIR, 'episodic.rvf'), entries);
  console.error(`[store] episodic memory built: ${entries.length} prior-attempt vectors (agenticow, leave-one-out recall)`);
}

// ════════════════════════════════════════════════════════════════════════════════════
// Condition B — parallel-selves (verifier-gated BoN over K agenticow memory branches).
// ════════════════════════════════════════════════════════════════════════════════════
async function runConditionB() {
  console.error(`\n=== Condition B (parallel-selves, K=${K} memory branches, verifier-judge) ===`);
  // The B genome: K diverse branches over the full KIND palette, seed-spread, verifier-gated.
  const genome = { selves: K, episodicK: 2, palette: KINDS.slice(0, Math.max(1, K)), temp: 0.7, selector: 'verifier', seedSpread: true };
  let done = 0;
  const rows = await mapPool(solveTasks, CONCURRENCY, async (task) => {
    if (!checkBudget()) return undefined;
    const r = await solveParallel(task, deps, genome, store, opts, cache);
    runCost += r.cost;
    console.error(`[B ${++done}/${solveTasks.length}] ${task.task_id} selves=${r.selves} $${r.cost.toFixed(4)} pick#${r.pick} ans="${String(r.answer).slice(0, 40)}"`);
    return { task_id: task.task_id, answer: r.answer, majority_answer: r.majority_answer, candidate_answers: r.candidate_answers, selves: r.selves, cost: r.cost, reasoning_types: task.reasoning_types };
  });
  cache.flush();
  appendPreds('preds-B-selves.jsonl', rows);
  const cellV = scoreCell({ name: 'B-selves(verifier)', scaffold: `parallel-selves-K${K}`, rows, view: 'primary', extra: { selector: 'verifier', K } });
  const cellM = scoreCell({ name: 'B-selves(majority)', scaffold: `parallel-selves-K${K}`, rows, view: 'majority', extra: { selector: 'majority', K } });
  saveJSON('results-B.json', { verifier: cellV, majority: cellM, genome });
  console.error(`[B/verifier] resolve ${cellV.correct}/${cellV.n}=${(cellV.acc * 100).toFixed(1)}% CI[${(cellV.ci[0] * 100).toFixed(1)},${(cellV.ci[1] * 100).toFixed(1)}] $${cellV.cost_per_task}/task`);
  console.error(`[B/majority] resolve ${cellM.correct}/${cellM.n}=${(cellM.acc * 100).toFixed(1)}%`);
  return { verifier: cellV, majority: cellM, genome, rows };
}

// ════════════════════════════════════════════════════════════════════════════════════
// Condition C — Darwin evolution of memory/context-shaping genomes.
// ════════════════════════════════════════════════════════════════════════════════════
const TEMPS = [0.4, 0.7, 1.0], SELVES = [1, 2, 3, 4], EPIK = [0, 1, 2, 3], SELECTORS = ['verifier', 'majority'];
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R = rng(SEED);
const pick = (arr) => arr[Math.floor(R() * arr.length)];
function genomeKey(g) { return `sv${g.selves}|ek${g.episodicK}|t${g.temp}|sel${g.selector}|ss${g.seedSpread ? 1 : 0}|p${g.palette.join(',')}`; }

function seedPopulation() {
  // Diverse gen-0 incl. a near-baseline anchor (single cold self) and a pure-BoN control
  // (no memory) so evolution can DISTINGUISH "memory helps" from "more samples help".
  return [
    { selves: 1, episodicK: 0, palette: ['cold'], temp: 0, selector: 'majority', seedSpread: false },            // baseline anchor
    { selves: 3, episodicK: 0, palette: ['cold', 'cold', 'cold'], temp: 1.0, selector: 'verifier', seedSpread: true }, // pure-BoN control (no memory)
    { selves: 4, episodicK: 2, palette: KINDS, temp: 0.7, selector: 'verifier', seedSpread: true },               // rich (memory + decomp)
    { selves: 3, episodicK: 3, palette: ['mem', 'mem', 'mem'], temp: 0.7, selector: 'majority', seedSpread: true }, // memory-heavy
    { selves: 2, episodicK: 1, palette: ['cold', 'memdecomp'], temp: 0.7, selector: 'verifier', seedSpread: true },
    { selves: 4, episodicK: 2, palette: ['decomp', 'mem', 'cold', 'memdecomp'], temp: 0.4, selector: 'majority', seedSpread: true },
  ].slice(0, POP);
}
function mutate(g) {
  const m = { ...g, palette: g.palette.slice() };
  switch (Math.floor(R() * 6)) {
    case 0: m.selves = pick(SELVES); break;
    case 1: m.episodicK = pick(EPIK); break;
    case 2: m.temp = pick(TEMPS); break;
    case 3: m.selector = pick(SELECTORS); break;
    case 4: m.seedSpread = !m.seedSpread; break;
    default: m.palette = Array.from({ length: Math.max(1, m.selves) }, () => pick(KINDS));
  }
  // keep palette length sane vs selves
  if (m.palette.length < 1) m.palette = ['cold'];
  return m;
}
function crossover(a, b) {
  return { selves: R() < 0.5 ? a.selves : b.selves, episodicK: R() < 0.5 ? a.episodicK : b.episodicK,
    temp: R() < 0.5 ? a.temp : b.temp, selector: R() < 0.5 ? a.selector : b.selector,
    seedSpread: R() < 0.5 ? a.seedSpread : b.seedSpread, palette: (R() < 0.5 ? a : b).palette.slice() };
}

const fitnessCache = new Map(); // genomeKey -> {acc, correct, n, cost, cell}
async function evalGenome(g) {
  const gk = genomeKey(g);
  if (fitnessCache.has(gk)) return fitnessCache.get(gk);
  const rows = await mapPool(solveTasks, CONCURRENCY, async (task) => {
    if (!checkBudget()) return undefined;
    const r = await solveParallel(task, deps, g, store, opts, cache);
    runCost += r.cost;
    return { task_id: task.task_id, answer: r.answer, majority_answer: r.majority_answer, cost: r.cost };
  });
  cache.flush();
  const view = g.selector === 'majority' ? 'majority' : 'primary';
  const cell = scoreCell({ name: gk, scaffold: 'evolved', rows, view });
  const res = { genomeKey: gk, genome: g, acc: cell.acc, correct: cell.correct, n: cell.n, ci: cell.ci, cost: cell.total_cost, cost_per_task: cell.cost_per_task, empty_rate: cell.empty_rate };
  fitnessCache.set(gk, res);
  return res;
}

async function runConditionC() {
  console.error(`\n=== Condition C (memory-evolution: P=${POP}, G=${GENS}) — fitness = FRAMES resolve (gold-free solve) ===`);
  const curve = [];
  let pop = seedPopulation();
  let best = null;
  for (let gen = 0; gen <= GENS; gen++) {
    if (!checkBudget()) { console.error(`[C] HALT before gen ${gen}: ${haltReason}`); break; }
    const evals = [];
    for (const g of pop) {
      if (!checkBudget()) { console.error(`[C] HALT mid-gen ${gen}: ${haltReason}`); break; }
      const e = await evalGenome(g);
      evals.push(e);
      console.error(`[C gen${gen}] ${e.genomeKey} → ${e.correct}/${e.n}=${(e.acc * 100).toFixed(1)}% $${e.cost_per_task}/task`);
    }
    if (!evals.length) break;
    evals.sort((a, b) => b.acc - a.acc || a.cost - b.cost);
    const genBest = evals[0];
    const meanAcc = evals.reduce((s, e) => s + e.acc, 0) / evals.length;
    curve.push({ gen, evaluated: evals.length, best_acc: genBest.acc, best_ci: genBest.ci, best_genome: genBest.genome, best_key: genBest.genomeKey, mean_acc: round(meanAcc, 4), best_cost_per_task: genBest.cost_per_task });
    if (!best || genBest.acc > best.acc) best = genBest;
    saveJSON('results-C.json', { model: MODEL, n: N, pop: POP, gens: GENS, curve, best, halted, haltReason, all_evals: [...fitnessCache.values()] });
    console.error(`[C gen${gen}] BEST ${genBest.genomeKey} ${(genBest.acc * 100).toFixed(1)}% | gen-mean ${(meanAcc * 100).toFixed(1)}%`);
    if (gen === GENS || halted) break;
    // Next generation: elitism (top-2) + mutated/crossover children of the top half.
    const elite = evals.slice(0, 2).map((e) => e.genome);
    const parents = evals.slice(0, Math.max(2, Math.ceil(evals.length / 2))).map((e) => e.genome);
    const next = [...elite];
    while (next.length < POP) { const a = pick(parents), b = pick(parents); next.push(mutate(crossover(a, b))); }
    pop = next;
  }
  const result = { model: MODEL, n: N, pop: POP, gens: GENS, curve, best, halted, haltReason, all_evals: [...fitnessCache.values()] };
  saveJSON('results-C.json', result);
  if (curve.length) {
    const g0 = curve[0], gL = curve[curve.length - 1];
    console.error(`[C] gen0 best ${(g0.best_acc * 100).toFixed(1)}% → gen${gL.gen} best ${(gL.best_acc * 100).toFixed(1)}% (Δ ${((gL.best_acc - g0.best_acc) * 100).toFixed(1)}pp)`);
  }
  return result;
}

// ════════════════════════════════════════════════════════════════════════════════════
async function main() {
  const t0 = Date.now();
  const meter = meterLoop();
  const out = { model: MODEL, dataset: manifest.dataset || 'frames', seed: SEED, n: N, mock: MOCK,
    reasoning: 'off (no reasoning API param; all shaping is prompt/orchestration-level — consistent with prior FRAMES runs)',
    started: new Date().toISOString() };

  let A = null;
  // A is needed to build the episodic store that B and C depend on.
  if (PHASE === 'A' || PHASE === 'all' || PHASE === 'B' || PHASE === 'C') {
    // Try to reuse a prior A run if present (resumable), else run it.
    A = await runConditionA();
    out.A = A.cell;
    buildStoreFromA(A.rows);
  }
  if ((PHASE === 'B' || PHASE === 'all') && !halted) { const B = await runConditionB(); out.B = { verifier: B.verifier, majority: B.majority, genome: B.genome }; }
  if ((PHASE === 'C' || PHASE === 'all') && !halted) { const C = await runConditionC(); out.C = { curve: C.curve, best: C.best }; }

  out.run_cost_usd = round(runCost, 4);
  out.cache_stats = { hits: cache.hits, misses: cache.misses };
  out.halted = halted; out.haltReason = haltReason;
  out.elapsed_sec = Math.round((Date.now() - t0) / 1000);
  out.finished = new Date().toISOString();
  saveJSON('results-ABC.json', out);
  halted = true; await meter;
  // Headline lifts
  if (out.A && out.B) console.error(`\nLIFT B−A (verifier): ${((out.B.verifier.acc - out.A.acc) * 100).toFixed(1)}pp`);
  if (out.C && out.C.curve.length) { const c = out.C.curve; console.error(`LIFT C gen0→genLast: ${((c[c.length - 1].best_acc - c[0].best_acc) * 100).toFixed(1)}pp`); }
  console.error(`\nDONE | run $${out.run_cost_usd} | cache ${cache.hits}h/${cache.misses}m | ${out.elapsed_sec}s | results → ${OUTDIR}/results-ABC.json`);
}
main().catch((e) => { console.error('FATAL', e); halted = true; process.exit(1); });
