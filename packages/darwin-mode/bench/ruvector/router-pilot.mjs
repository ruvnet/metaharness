// SPDX-License-Identifier: MIT
//
// router-pilot.mjs — ruvector SemanticRouter cost-Pareto pilot ($0 routing-accuracy arm).
//
// QUESTION: can `@ruvector/router` SemanticRouter (HNSW intent-matching over
// all-MiniLM-L6-v2 query embeddings) route FRAMES questions cheap↔frontier well
// enough to capture frontier-class quality at near-cheap cost?
//
// HONESTY FRAME (read first): SemanticRouter is HNSW kNN over query embeddings —
// NOT a difficulty oracle. WE supply the labels (from completed-run outcomes).
// The router can only work if "difficulty" (cheap-fails / frontier-succeeds) is
// encoded in the QUERY embedding. The all-MiniLM embedding captures TOPIC, not
// solver-difficulty, so the prior is weak. We report the REAL separation power
// (ROC-AUC / hard-recall / balanced-accuracy with Wilson CIs), not raw accuracy
// (which is inflated by the 10% hard base-rate: a "never-route-up" stub already
// scores 90%). Labels come from solve OUTCOMES, never gold-in-loop (conformant).
//
// METHOD:
//   1. Embed 150 FRAMES questions with ruvector OnnxEmbedder (all-MiniLM-L6-v2,
//      384-d, local, $0). Cached to data/router-embeddings.json.
//   2. SemanticRouter difficulty classifier, two variants:
//        (a) kNN-over-exemplars (primary): each train task is an intent;
//            soft score = fraction of k nearest train exemplars that are 'hard'.
//        (b) centroid-intent (canonical SemanticRouter): two intents
//            (easy-centroid, hard-centroid); score = sim(hard) − sim(easy).
//   3. Repeated stratified k-fold CV (only 15 hard cases exist → 20/20 split is
//      impossible; CV uses every hard case as a held-out point, repeated for a
//      stable estimate). Out-of-fold (OOF) soft scores → ROC-AUC, confusion
//      matrix at operating points, Wilson CIs.
//   4. Cost-Pareto: project resolve% and $/task for router-cascade vs always-
//      cheap vs always-frontier vs oracle, using REAL per-task costs/outcomes.
//      Cost saving at matched quality (FrugalGPT/RouteLLM framing).
//
// Run: node router-pilot.mjs [--k 15] [--repeats 20] [--folds 5]
//      [--ruvector /home/ruvultra/projects/ruvector/node_modules/ruvector]
//      [--router  /home/ruvultra/projects/ruvector/npm/packages/router]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const K = +argv('--k', 15);
const REPEATS = +argv('--repeats', 20);
const FOLDS = +argv('--folds', 5);
const RUVECTOR_PATH = argv('--ruvector', '/home/ruvultra/projects/ruvector/node_modules/ruvector');
const ROUTER_PATH = argv('--router', '/home/ruvultra/projects/ruvector/node_modules/@ruvector/router');
const LABELS = join(DATA, 'router-labels.json');
const EMB_CACHE = join(DATA, 'router-embeddings.json');
const OUT = join(DATA, 'router-pilot-results.json');

// ── deterministic PRNG (mulberry32) ──
function rng(seed) { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffle(arr, r) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// Wilson 95% interval
function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const pct = (x) => (100 * x).toFixed(1);

// ── load labels ──
const labels = JSON.parse(readFileSync(LABELS, 'utf8'));
const recs = labels.records;
const N = recs.length;
const CHEAP = labels.cheap_model, FRONTIER = labels.frontier_model;
console.error(`[pilot] n=${N}  cheap=${CHEAP} frontier=${FRONTIER}`);
console.error(`[pilot] labels: easy=${labels.label_distribution.easy} hard=${labels.label_distribution.hard} neither=${labels.label_distribution.neither}`);

// ── embeddings (ONNX all-MiniLM-L6-v2, cached) ──
async function getEmbeddings() {
  if (existsSync(EMB_CACHE)) {
    const c = JSON.parse(readFileSync(EMB_CACHE, 'utf8'));
    if (c.n === N && c.dim) { console.error(`[pilot] using cached embeddings (${c.dim}-d, model=${c.model})`); return c; }
  }
  const rv = require(RUVECTOR_PATH);
  if (!(rv.OnnxEmbedder && (!rv.isOnnxAvailable || rv.isOnnxAvailable()))) throw new Error('ruvector OnnxEmbedder not available');
  const e = new rv.OnnxEmbedder();
  const toArr = (v) => (Array.isArray(v) ? v : Array.from(v.data ?? v.vector ?? v));
  let gate = Promise.resolve();
  const embed = (text) => { const p = gate.then(() => e.embed(String(text)).then(toArr)); gate = p.catch(() => {}); return p; };
  const probe = await embed('dimension probe');
  const dim = probe.length;
  console.error(`[pilot] onnx all-MiniLM-L6-v2 ready: ${dim}-d; embedding ${N} questions...`);
  const vecs = [];
  for (let i = 0; i < N; i++) { vecs.push(await embed(recs[i].question)); if ((i + 1) % 25 === 0) console.error(`  embedded ${i + 1}/${N}`); }
  const out = { n: N, dim, model: 'all-MiniLM-L6-v2 (ruvector OnnxEmbedder)', task_ids: recs.map((r) => r.task_id), vectors: vecs };
  writeFileSync(EMB_CACHE, JSON.stringify(out));
  console.error(`[pilot] cached embeddings → ${EMB_CACHE}`);
  return out;
}

// ── ROC-AUC (Mann–Whitney) from soft scores ──
function rocAuc(scores, labelsBin) {
  const pos = [], neg = [];
  for (let i = 0; i < scores.length; i++) (labelsBin[i] ? pos : neg).push(scores[i]);
  if (!pos.length || !neg.length) return null;
  // rank-sum
  const all = scores.map((s, i) => ({ s, y: labelsBin[i] })).sort((a, b) => a.s - b.s);
  let rank = 0, i = 0, rankSumPos = 0;
  while (i < all.length) {
    let j = i; while (j < all.length && all[j].s === all[i].s) j++;
    const avgRank = (i + 1 + j) / 2; // average rank for ties (1-based)
    for (let t = i; t < j; t++) if (all[t].y) rankSumPos += avgRank;
    i = j;
  }
  const nP = pos.length, nN = neg.length;
  return (rankSumPos - nP * (nP + 1) / 2) / (nP * nN);
}

const main = async () => {
  const emb = await getEmbeddings();
  const Float = (i) => new Float32Array(emb.vectors[i]);
  const y = recs.map((r) => (r.route_up ? 1 : 0)); // 1 = hard = should route up
  const nHard = y.reduce((a, b) => a + b, 0);

  const router = require(ROUTER_PATH);
  const { SemanticRouter } = router;

  // ── CV: out-of-fold soft scores for both variants ──
  // accumulate sum of soft scores + counts across repeats → mean OOF score per task
  const knnScoreSum = new Array(N).fill(0), knnScoreCnt = new Array(N).fill(0);
  const cenScoreSum = new Array(N).fill(0), cenScoreCnt = new Array(N).fill(0);

  for (let rep = 0; rep < REPEATS; rep++) {
    const r = rng(1234 + rep * 7919);
    // stratified fold assignment: shuffle within class, round-robin folds
    const idxPos = shuffle(recs.map((_, i) => i).filter((i) => y[i] === 1), r);
    const idxNeg = shuffle(recs.map((_, i) => i).filter((i) => y[i] === 0), r);
    const fold = new Array(N);
    idxPos.forEach((i, t) => { fold[i] = t % FOLDS; });
    idxNeg.forEach((i, t) => { fold[i] = t % FOLDS; });

    for (let f = 0; f < FOLDS; f++) {
      const train = []; const test = [];
      for (let i = 0; i < N; i++) (fold[i] === f ? test : train).push(i);
      if (!train.some((i) => y[i] === 1) || !train.some((i) => y[i] === 0)) continue;

      // (a) kNN-over-exemplars SemanticRouter
      const sr = new SemanticRouter({ dimension: emb.dim, metric: 'cosine', threshold: -2 });
      for (const i of train) sr.addIntent({ name: `t${i}`, utterances: [recs[i].task_id], embedding: Float(i), metadata: { y: y[i] } });
      const kEff = Math.min(K, train.length);
      for (const i of test) {
        const hits = sr.routeWithEmbedding(Float(i), kEff);
        // soft score = fraction of returned neighbours that are 'hard'
        let s = 0;
        if (hits.length) { s = hits.reduce((a, h) => a + (h.metadata?.y === 1 ? 1 : 0), 0) / hits.length; }
        knnScoreSum[i] += s; knnScoreCnt[i] += 1;
      }

      // (b) centroid-intent canonical SemanticRouter (2 intents)
      const dim = emb.dim;
      const cen = (cls) => { const v = new Float32Array(dim); let c = 0; for (const i of train) if (y[i] === cls) { const vi = emb.vectors[i]; for (let d = 0; d < dim; d++) v[d] += vi[d]; c++; } if (c) for (let d = 0; d < dim; d++) v[d] /= c; return v; };
      const sr2 = new SemanticRouter({ dimension: dim, metric: 'cosine', threshold: -2 });
      sr2.addIntent({ name: 'easy', utterances: ['easy'], embedding: cen(0), metadata: { y: 0 } });
      sr2.addIntent({ name: 'hard', utterances: ['hard'], embedding: cen(1), metadata: { y: 1 } });
      for (const i of test) {
        const hits = sr2.routeWithEmbedding(Float(i), 2);
        const sh = hits.find((h) => h.intent === 'hard')?.score ?? 0;
        const se = hits.find((h) => h.intent === 'easy')?.score ?? 0;
        cenScoreSum[i] += (sh - se + 1) / 2; // map [-1,1]→[0,1]
        cenScoreCnt[i] += 1;
      }
    }
  }

  const knnScore = knnScoreSum.map((s, i) => (knnScoreCnt[i] ? s / knnScoreCnt[i] : 0));
  const cenScore = cenScoreSum.map((s, i) => (cenScoreCnt[i] ? s / cenScoreCnt[i] : 0));

  const aucKnn = rocAuc(knnScore, y);
  const aucCen = rocAuc(cenScore, y);

  // bootstrap 95% CI for AUC (resample tasks w/ replacement) — n=15 hard is small
  function bootAucCI(score, iters = 3000) {
    const r = rng(20260628);
    const vals = [];
    for (let b = 0; b < iters; b++) {
      const s = [], yy = [];
      for (let i = 0; i < N; i++) { const j = Math.floor(r() * N); s.push(score[j]); yy.push(y[j]); }
      const a = rocAuc(s, yy); if (a !== null) vals.push(a);
    }
    vals.sort((a, b) => a - b);
    return [vals[Math.floor(0.025 * vals.length)], vals[Math.floor(0.975 * vals.length)]];
  }
  const ciKnn = bootAucCI(knnScore), ciCen = bootAucCI(cenScore);

  // reasoning-type heuristic baseline (non-embedding): is 'hard' predictable from
  // reasoning_type alone? leave-one-out hard-rate per type as the soft score.
  const reasoningOf = (i) => (recs[i].reasoning_types || 'unknown').split('|')[0].trim();
  const typeHard = {}, typeN = {};
  for (let i = 0; i < N; i++) { const t = reasoningOf(i); typeN[t] = (typeN[t] || 0) + 1; typeHard[t] = (typeHard[t] || 0) + y[i]; }
  const typeRate = Object.fromEntries(Object.keys(typeN).map((t) => [t, typeHard[t] / typeN[t]]));
  const typeScore = recs.map((_, i) => { const t = reasoningOf(i); const n = typeN[t], h = typeHard[t]; return n > 1 ? (h - y[i]) / (n - 1) : 0; });
  const aucType = rocAuc(typeScore, y);

  console.error(`\n[pilot] ROC-AUC (hard detection, OOF, ${REPEATS}×${FOLDS}-fold CV):`);
  console.error(`  kNN-exemplar router : AUC=${aucKnn?.toFixed(3)}  95%CI[${ciKnn[0].toFixed(3)}, ${ciKnn[1].toFixed(3)}]`);
  console.error(`  centroid-intent     : AUC=${aucCen?.toFixed(3)}  95%CI[${ciCen[0].toFixed(3)}, ${ciCen[1].toFixed(3)}]`);
  console.error(`  reasoning-type base : AUC=${aucType?.toFixed(3)}  (non-embedding heuristic)`);
  console.error(`  (AUC 0.5 = no separation = difficulty NOT in query embedding)`);

  // ── confusion matrix + cost-Pareto at operating points (primary = kNN) ──
  // operating point: threshold on soft score. We trace several and also pick the
  // point that maximizes captured-hard while keeping precision sane.
  function evalThreshold(score, thr) {
    // predicted route_up if score > thr
    let TP = 0, FP = 0, TN = 0, FN = 0;
    const pred = new Array(N);
    for (let i = 0; i < N; i++) {
      const up = score[i] > thr; pred[i] = up;
      if (up && y[i]) TP++; else if (up && !y[i]) FP++; else if (!up && !y[i]) TN++; else FN++;
    }
    return { thr, TP, FP, TN, FN, pred };
  }

  // cost-Pareto for a given routing decision vector `pred` (true=route to frontier)
  function pareto(pred, mode = 'router') {
    // mode 'router' (pure): pay only the chosen model; resolve = chosen model EM.
    // mode 'cascade' (FrugalGPT): always pay cheap; if route_up also pay frontier
    //   and take frontier's answer. resolve = front_em if escalated else cheap_em.
    let resolve = 0, cost = 0, nUp = 0;
    for (let i = 0; i < N; i++) {
      const up = pred[i]; if (up) nUp++;
      if (mode === 'router') {
        resolve += up ? recs[i].front_em : recs[i].cheap_em;
        cost += up ? recs[i].front_cost : recs[i].cheap_cost;
      } else { // cascade
        if (up) { resolve += recs[i].front_em ? 1 : 0; cost += recs[i].cheap_cost + recs[i].front_cost; }
        else { resolve += recs[i].cheap_em ? 1 : 0; cost += recs[i].cheap_cost; }
      }
    }
    return { resolve, n: N, acc: resolve / N, ci: wilson(resolve, N), cost_total: cost, cost_per_task: cost / N, route_up_rate: nUp / N };
  }

  // baselines
  const allCheap = pareto(new Array(N).fill(false), 'router');
  const allFront = pareto(new Array(N).fill(true), 'router');
  const oraclePred = recs.map((r) => r.route_up); // perfect: route up iff truly hard
  const oracleRouter = pareto(oraclePred, 'router');
  const oracleCascade = pareto(oraclePred, 'cascade');

  // sweep thresholds for kNN router, record Pareto points
  const thrs = Array.from(new Set([...knnScore].sort((a, b) => a - b))).filter((t) => t < Math.max(...knnScore));
  const sweep = [];
  for (const thr of [-0.0001, ...thrs]) {
    const cm = evalThreshold(knnScore, thr);
    const pr = pareto(cm.pred, 'router');
    const prc = pareto(cm.pred, 'cascade');
    const recall = cm.TP + cm.FN ? cm.TP / (cm.TP + cm.FN) : 0;
    const precision = cm.TP + cm.FP ? cm.TP / (cm.TP + cm.FP) : 0;
    const balAcc = 0.5 * ((cm.TN / (cm.TN + cm.FP || 1)) + (cm.TP / (cm.TP + cm.FN || 1)));
    sweep.push({ thr, ...cm, recall, precision, balAcc, router: pr, cascade: prc });
  }

  // pick a representative operating point: max F1 on hard
  let best = sweep[0], bestF1 = -1;
  for (const s of sweep) { const f1 = (s.precision + s.recall) ? 2 * s.precision * s.recall / (s.precision + s.recall) : 0; if (f1 > bestF1) { bestF1 = f1; best = s; } }

  const results = {
    generated: new Date().toISOString(),
    config: { n: N, cheap: CHEAP, frontier: FRONTIER, k: K, repeats: REPEATS, folds: FOLDS, embedder: emb.model, dim: emb.dim },
    label_distribution: labels.label_distribution,
    base_rate_hard: nHard / N,
    routing_separation: {
      knn_exemplar_auc: aucKnn,
      knn_exemplar_auc_ci95: ciKnn,
      centroid_intent_auc: aucCen,
      centroid_intent_auc_ci95: ciCen,
      reasoning_type_auc: aucType,
      note: 'AUC≈0.5 ⇒ difficulty not separable from the query embedding. Raw accuracy is uninformative at 10% base rate (never-route-up = 90%).',
    },
    oof_scores: { task_ids: recs.map((r) => r.task_id), y, knn: knnScore, centroid: cenScore, reasoning_type: typeScore },
    operating_point_maxF1: {
      thr: best.thr, TP: best.TP, FP: best.FP, TN: best.TN, FN: best.FN,
      hard_recall: best.recall, hard_precision: best.precision, balanced_accuracy: best.balAcc,
      raw_accuracy: (best.TP + best.TN) / N,
    },
    cost_pareto: {
      always_cheap: allCheap,
      always_frontier: allFront,
      oracle_router: oracleRouter,
      oracle_cascade: oracleCascade,
      router_maxF1_pure: best.router,
      router_maxF1_cascade: best.cascade,
    },
    pareto_sweep: sweep.map((s) => ({ thr: s.thr, route_up_rate: s.router.route_up_rate, hard_recall: s.recall, hard_precision: s.precision, resolve_pure: s.router.acc, cost_per_task_pure: s.router.cost_per_task, resolve_cascade: s.cascade.acc, cost_per_task_cascade: s.cascade.cost_per_task })),
    reasoning_type_hard_rate: typeRate,
  };
  writeFileSync(OUT, JSON.stringify(results, null, 2));

  // ── console summary ──
  console.error(`\n========== COST-PARETO (real per-task outcomes & costs, n=${N}) ==========`);
  const row = (name, p) => console.error(`  ${name.padEnd(26)} resolve ${pct(p.acc)}% [${pct(p.ci[0])}-${pct(p.ci[1])}]  $${p.cost_per_task.toFixed(4)}/task  up=${pct(p.route_up_rate)}%`);
  row('always-cheap', allCheap);
  row('always-frontier', allFront);
  row('ORACLE router (pure)', oracleRouter);
  row('ORACLE cascade', oracleCascade);
  row('ruvector router maxF1', best.router);
  row('ruvector cascade maxF1', best.cascade);
  console.error(`\n[pilot] hard-detection @maxF1: recall=${pct(best.recall)}% precision=${pct(best.precision)}% balAcc=${pct(best.balAcc)}%  (TP=${best.TP} FP=${best.FP} FN=${best.FN} TN=${best.TN})`);
  // cost saving at matched quality vs frontier
  const save = (1 - allCheap.cost_per_task / allFront.cost_per_task) * 100;
  console.error(`[pilot] always-cheap already matches frontier EM (${pct(allCheap.acc)} vs ${pct(allFront.acc)}) at ${save.toFixed(1)}% lower $/task.`);
  console.error(`[pilot] oracle complementarity ceiling: ${pct(oracleRouter.acc)}% (union of cheap∪frontier correct) vs ${pct(allFront.acc)}% frontier-only.`);
  console.error(`\n[pilot] wrote ${OUT}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
