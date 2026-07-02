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
import { openBase as openBranchMemory } from './branch-memory.mjs';

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
const noBranchMemory = args.includes('--no-branch-memory'); // ADR-230: opt OUT (default: on, degrades)
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
// ADR-230 — per-candidate capture for branch-memory. gepaOptimize (gepa-loop.mjs) strips feedbacks
// and drops fully-discarded candidates from the returned pool and exposes no per-candidate callback,
// so we stash each genome's genome+scores+feedbacks+gold here (where they're still whole) and record
// the lineage as the loop's accept/reject event fires (see onEvent + recordCandidate below).
const evalCapture = new Map(); // genome_id → { genome, scores, feedbacks, gold }
const candParent = new Map();  // genome_id → parent genome_id (from the 'evaluated' event)
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
  evalCapture.set(genome.meta?.id, { genome, scores: r.scores, feedbacks: r.feedbacks, gold: r.goldResolved });
  return { scores: r.scores, feedbacks: r.feedbacks, cost: r.cost, metricCalls: r.metricCalls };
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────
const seed = loadGenome((p) => readFileSync(p, 'utf8'), seedPath);
console.error(`[gepa] seed=${seed.meta?.id} model=${model} reflector=${reflectionModel} train=first-${trainFirst} of ${manifest} | caps: ${maxCandidates} candidates, $${maxCost} hard`);

// ADR-230 — Agenticow branch-memory (the memory-transaction layer, NOT the intelligence). Opens the
// seed genome as the base .rvf; every candidate becomes a 162 B COW branch off its frontier parent;
// only a holdout-winner is promoted into the base (frozen-seed rule). Degrades to a no-op when
// agenticow is absent — GEPA runs unchanged. All calls are guarded (never fatal to the run).
let branchMem = null;
if (!noBranchMemory) {
  try {
    branchMem = await openBranchMemory(join(workDir, 'branch-memory', 'seed.rvf'), { seedGenome: seed, logger: console });
    console.error(`[gepa] branch-memory: ${branchMem.degraded ? 'DEGRADED (agenticow absent — no-op)' : 'active (agenticow COW branches per candidate)'}`);
  } catch (e) { console.error(`[gepa] branch-memory disabled (${e.message})`); branchMem = null; }
}
const bm = (fn) => { if (!branchMem) return; try { return fn(branchMem); } catch (e) { console.error(`[gepa] branch-memory op failed (non-fatal): ${e.message}`); } };

// ADR-230 §2/§3 — record a candidate's lineage in a COW branch off its frontier parent when GEPA's
// metric emits its accept/reject verdict (gepa-loop.mjs's onEvent). GEPA already decided; we only
// RECORD it. Rejected candidates are retained (never promoted, never deleted), staying query-able.
// regressed/improved/lesson are derived from the captured score vectors (main's #64 harness dropped
// the regression-report module, so we compute the minimal report inline — no re-introduced dep).
function recordCandidate(id, event) {
  const cap = evalCapture.get(id);
  if (!cap) return;
  const parentId = candParent.get(id) ?? seed.meta?.id;
  const parentCap = evalCapture.get(parentId);
  const pScores = parentCap?.scores || {};
  const accepted = event === 'accepted';
  bm((m) => {
    m.checkpoint(`pre-${id}`);
    m.branchCandidate(id, { parent: parentId });
    m.recordGenome(id, cap.genome);
    m.recordEvalTrace(id, { scores: cap.scores, feedbacks: cap.feedbacks, evalSet: `train-first-${trainFirst}`, gold: cap.gold });
    m.diffAgainstParent(id);
    const ids = Object.keys(cap.scores || {});
    const regressed = ids.filter((k) => (cap.scores[k] ?? 0) < (pScores[k] ?? 0));
    const improved = ids.filter((k) => (cap.scores[k] ?? 0) > (pScores[k] ?? 0));
    const lesson = `${accepted ? 'KEEP' : 'AVOID'}: ${cap.genome?.meta?.mutated ?? 'component'} — +${improved.length}/-${regressed.length} instances, gold ${cap.gold} vs parent ${parentCap?.gold ?? '?'}`;
    m.setDecision(id, accepted ? 'accept' : 'reject', {
      regressed, improved, lesson,
      parent_score: Object.values(pScores).reduce((s, x) => s + (x || 0), 0),
      parent_gold: parentCap?.gold ?? null,
    });
  });
}

const result = await gepaOptimize({
  seed, evaluate, reflect,
  maxCandidates, maxCost, maxStall: 8,
  onEvent: (ev, d) => {
    console.error(`[gepa] ${ev}: ${JSON.stringify(d)}`);
    if (ev === 'evaluated' && d?.id) candParent.set(d.id, d.parent ?? seed.meta?.id);
    if ((ev === 'accepted' || ev === 'rejected') && d?.id) recordCandidate(d.id, ev);
  },
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

    // ADR-230 §5 — ONLY a holdout-winner (beats the seed on the unseen slice) graduates into the seed
    // base (frozen-seed rule, ADR §7.1). Accept/reject candidates keep their branch but never promote.
    if (holdout.goldDelta > 0 && result.best !== seed.meta?.id) {
      bm((m) => {
        const pr = m.promoteToBase(result.best);
        console.error(`[gepa] branch-memory: PROMOTED holdout-winner ${result.best} → seed-base${pr.degraded ? ' (degraded no-op)' : ` (ingested ${pr.ingested})`}`);
      });
    }
  } else console.error('[gepa] holdout skipped (no instances left or budget exhausted)');
}

// ADR-230 — export the portable lineage/lesson JSON (what would later sync to ADR-227 Firestore) +
// persist the sidecar. Guarded/optional; never fatal to the run.
let branchLineage = null;
bm((m) => {
  branchLineage = { lessons: m.exportPromotedLessons(), storage: m.measureStorageOverhead(), degraded: m.degraded };
  const p = m.save(); if (p) console.error(`[gepa] branch-memory sidecar → ${p}`);
  const lp = join(workDir, 'branch-lineage.json'); writeFileSync(lp, JSON.stringify(branchLineage, null, 2));
  console.error(`[gepa] branch-memory lineage export (${branchLineage.lessons.length} candidates) → ${lp}`);
  m.close();
});

writeFileSync(outPath, JSON.stringify({
  ranAt: new Date().toISOString(), seed: seed.meta?.id, model, reflectionModel, manifest, trainFirst,
  caps: { maxCandidates, maxCost, perEvalCost, maxSteps },
  frontier: result.frontier, winners: result.winners, best: result.best, bestMean: result.bestMean,
  budget: result.budget, history: result.history, holdout,
  branchLineage, // ADR-230 — portable per-candidate lineage/lesson JSON + measured storage overhead
  pool: result.pool, // full genomes included — the frontier IS the deliverable, not one winner (§8)
}, null, 2));
console.error(`[gepa] DONE → ${outPath}`);
