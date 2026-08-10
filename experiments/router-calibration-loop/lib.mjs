// router-calibration-loop — shared library (deterministic, $0, no network).
//
// QUESTION UNDER TEST: do turn-credit-derived quality labels (toQualityLabels
// from @metaharness/turn-credit) produce a BETTER-CALIBRATED router than naive
// terminal-outcome 0/1 labels on IDENTICAL episodes — and does better
// calibration buy cheaper routing at the same quality bar?
//
// The design is fixed once, neutrally (distractor turns, noisy evidence,
// common random numbers across arms), and the result is reported whatever it
// is. A refutation is a valid outcome: the calibration gate correctly
// rejecting a label source is a positive result for the machinery.
//
// HONEST BOUND: synthetic mechanism testbed. Embeddings are simulated feature
// vectors; the latent cheap/frontier success surface is constructed; evidence
// is 'verifier-delta-proxy' style scalars, not AgentOPSD log-prob gaps. A
// result here is evidence about the LABEL-QUALITY mechanism feeding the
// router's k-NN predictor — NOT a benchmark claim about production routing,
// and NOT the ADR-248 §6 LIVE acceptance gate. All randomness is
// mulberry32-seeded; all reported numbers are round6'd; no
// Date.now()/Math.random() anywhere.

import {
  processTrajectory,
  toQualityLabels,
  PAPER_DEFAULTS,
  round6,
} from '../../packages/turn-credit/dist/index.js';
import { Router, calibrationReport } from '../../packages/router/dist/index.js';

/** mulberry32 — the repo's standard tiny deterministic PRNG. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uniform = (rng, lo, hi) => lo + (hi - lo) * rng();

/** Box–Muller standard normal from the supplied rng (deterministic). */
function gaussian(rng) {
  const u1 = 1 - rng(); // (0,1] — avoids log(0)
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Frozen experiment parameters — fixed BEFORE looking at any results. */
export const CONFIG = Object.freeze({
  seeds: [11, 23, 47],
  dim: 8, // synthetic embedding dimension
  trainTasks: 200, // training tasks per seed (each run by BOTH models)
  evalTasks: 200, // held-out tasks per seed
  turns: 6, // turns per trajectory → 6 RouterExamples per (task, model)
  k: 5, // router k-NN (the package default, kept explicit)
  qualityBar: 0.7, // shared routing bar for both arms
  prior: 0.5, // group-success prior handed to processTrajectory
  evidenceScale: 0.8, // work-turn evidence magnitude scale (log-odds-ish units)
  evidenceNoise: 0.3, // gaussian noise sd added to EVERY turn's evidence
  workTurnProb: 0.5, // each turn is 'work' (informative) vs 'distractor' (noise)
  turnJitter: 0.05, // per-turn embedding jitter sd around the task embedding
  tokensRange: [600, 1800], // per-task usage (tokens), same whichever model runs it
  // Blended prices, $ per 1M tokens.
  models: Object.freeze({
    cheap: Object.freeze({ costPerMTok: 0.8 }),
    frontier: Object.freeze({ costPerMTok: 12 }),
  }),
  // Latent success surfaces: difficulty d = sigmoid(3 · w·x); cheap collapses
  // on hard tasks, frontier degrades only mildly.
  cheapBase: 0.95,
  cheapSlope: 0.85, // p_cheap = clip(0.95 − 0.85·d)
  frontierBase: 0.95,
  frontierSlope: 0.15, // p_frontier = clip(0.95 − 0.15·d)
  pClip: [0.03, 0.97],
});

/** Fixed difficulty direction in embedding space (frozen constant, dim 8). */
const DIFFICULTY_W = Object.freeze([0.35, -0.2, 0.15, 0.3, -0.25, 0.1, 0.2, -0.15]);

/** Draw one task: embedding + latent per-model success probabilities. */
export function drawTask(rng, cfg = CONFIG) {
  const embedding = [];
  for (let i = 0; i < cfg.dim; i++) embedding.push(uniform(rng, -1, 1));
  let z = 0;
  for (let i = 0; i < cfg.dim; i++) z += DIFFICULTY_W[i] * embedding[i];
  const difficulty = sigmoid(3 * z);
  const [lo, hi] = cfg.pClip;
  return {
    embedding,
    difficulty,
    p: {
      cheap: clip(cfg.cheapBase - cfg.cheapSlope * difficulty, lo, hi),
      frontier: clip(cfg.frontierBase - cfg.frontierSlope * difficulty, lo, hi),
    },
  };
}

/**
 * Run one model on one task: realized 0/1 outcome from the latent probability,
 * then a multi-turn trajectory whose 'work' turns carry noisy evidence aligned
 * with the realized outcome and whose 'distractor' turns carry pure noise.
 * Each turn gets its own jittered embedding (shared verbatim by both arms).
 */
export function genEpisode(rng, task, modelId, cfg = CONFIG) {
  const p = task.p[modelId];
  const outcome = rng() < p ? 1 : 0;
  const turns = [];
  for (let t = 0; t < cfg.turns; t++) {
    const isWork = rng() < cfg.workTurnProb;
    const signal = isWork
      ? cfg.evidenceScale * (outcome === 1 ? 1 : -1) * uniform(rng, 0.4, 1.2)
      : 0;
    const evidence = signal + cfg.evidenceNoise * gaussian(rng);
    const embedding = task.embedding.map((x) => x + cfg.turnJitter * gaussian(rng));
    turns.push({ turn: t, label: isWork ? 'work' : 'distractor', evidence, embedding });
  }
  return { outcome, turns };
}

/**
 * Label one episode under BOTH arms. Identical turn embeddings; only the
 * quality label differs:
 *   naive  — every turn example gets the terminal outcome (0/1);
 *   credit — toQualityLabels(processTrajectory(...)) per-turn graded labels.
 */
export function labelEpisode(episode, cfg = CONFIG) {
  const credit = processTrajectory({
    evidence: episode.turns.map((t) => ({ turn: t.turn, evidence: t.evidence, label: t.label })),
    mode: 'verifier-delta-proxy',
    prior: cfg.prior,
    success: episode.outcome === 1,
    config: PAPER_DEFAULTS,
  });
  const qualityByTurn = new Map(toQualityLabels(credit).map((q) => [q.turn, q.quality]));
  const naive = [];
  const credited = [];
  for (const t of episode.turns) {
    naive.push({ embedding: t.embedding, quality: episode.outcome });
    credited.push({ embedding: t.embedding, quality: qualityByTurn.get(t.turn) });
  }
  return { naive, credited, credit };
}

/** Mean helper (0 on empty). */
const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Run the full loop for one seed. Returns round6'd measurements only. */
export function runSeed(seed, cfg = CONFIG) {
  const rng = mulberry32(seed);

  // ---- training episodes: both models run every training task -------------
  const examples = {
    naive: { cheap: [], frontier: [] },
    credit: { cheap: [], frontier: [] },
  };
  const diag = { workQ: [], distractorQ: [], successQ: [], failQ: [], trainSuccess: [] };
  for (let i = 0; i < cfg.trainTasks; i++) {
    const task = drawTask(rng, cfg);
    for (const modelId of ['cheap', 'frontier']) {
      const ep = genEpisode(rng, task, modelId, cfg);
      const { naive, credited } = labelEpisode(ep, cfg);
      examples.naive[modelId].push(...naive);
      examples.credit[modelId].push(...credited);
      diag.trainSuccess.push(ep.outcome);
      for (let t = 0; t < ep.turns.length; t++) {
        const q = credited[t].quality;
        (ep.turns[t].label === 'work' ? diag.workQ : diag.distractorQ).push(q);
        (ep.outcome === 1 ? diag.successQ : diag.failQ).push(q);
      }
    }
  }

  // ---- routers (one per arm; identical k, identical bar) ------------------
  const routers = {};
  const candidateRefs = {};
  for (const arm of ['naive', 'credit']) {
    const candidates = ['cheap', 'frontier'].map((id) => ({
      id,
      costPerMTok: cfg.models[id].costPerMTok,
      examples: examples[arm][id],
    }));
    routers[arm] = new Router({ candidates, k: cfg.k, qualityBar: cfg.qualityBar });
    candidateRefs[arm] = Object.fromEntries(candidates.map((c) => [c.id, c]));
  }

  // ---- held-out eval tasks with common random numbers ---------------------
  // One outcome draw per (task, model) and one token count per task, shared by
  // both arms — routing differences, not luck, drive any measured gap.
  const evalTasks = [];
  for (let i = 0; i < cfg.evalTasks; i++) {
    const task = drawTask(rng, cfg);
    const outcomes = {
      cheap: rng() < task.p.cheap ? 1 : 0,
      frontier: rng() < task.p.frontier ? 1 : 0,
    };
    const tokens = Math.round(uniform(rng, cfg.tokensRange[0], cfg.tokensRange[1]));
    evalTasks.push({ task, outcomes, tokens });
  }

  // ---- (1) calibration: predictedQuality vs realized outcome per arm ------
  const calPairs = { naive: [], credit: [], oracle: [] };
  const predSpread = { naive: [], credit: [] };
  for (const { task, outcomes } of evalTasks) {
    for (const arm of ['naive', 'credit']) {
      for (const modelId of ['cheap', 'frontier']) {
        const predicted = clip(
          routers[arm].predict(candidateRefs[arm][modelId], task.embedding),
          0,
          1
        );
        calPairs[arm].push({ predicted, realized: outcomes[modelId] });
        predSpread[arm].push(predicted);
      }
    }
    // Oracle reference (context only, not an arm): predict the true latent p.
    for (const modelId of ['cheap', 'frontier']) {
      calPairs.oracle.push({ predicted: task.p[modelId], realized: outcomes[modelId] });
    }
  }
  const calibration = {
    naive: calibrationReport(calPairs.naive),
    credit: calibrationReport(calPairs.credit),
    oracle: calibrationReport(calPairs.oracle),
  };

  // ---- (2) economics: route at the shared bar, tally cost + quality -------
  const econ = {};
  for (const arm of ['naive', 'credit']) {
    let cost = 0;
    let quality = [];
    let cheapPicks = 0;
    let metBar = 0;
    for (const { task, outcomes, tokens } of evalTasks) {
      const r = routers[arm].route(task.embedding);
      cost += (r.costPerMTok * tokens) / 1e6;
      quality.push(outcomes[r.id]);
      if (r.id === 'cheap') cheapPicks++;
      if (r.metBar) metBar++;
    }
    econ[arm] = {
      cost: round6(cost),
      realizedQuality: round6(mean(quality)),
      cheapShare: round6(cheapPicks / evalTasks.length),
      metBarShare: round6(metBar / evalTasks.length),
    };
  }
  // Fixed references (context only, not an arm): always-frontier / always-cheap.
  const refs = {};
  for (const id of ['cheap', 'frontier']) {
    let cost = 0;
    const quality = [];
    for (const { outcomes, tokens } of evalTasks) {
      cost += (cfg.models[id].costPerMTok * tokens) / 1e6;
      quality.push(outcomes[id]);
    }
    refs[`always-${id}`] = { cost: round6(cost), realizedQuality: round6(mean(quality)) };
  }

  // ---- claims (per seed) --------------------------------------------------
  const claims = {
    calibration: calibration.credit.ece < calibration.naive.ece,
    economics:
      econ.credit.cost <= econ.naive.cost &&
      econ.credit.realizedQuality >= econ.naive.realizedQuality,
  };

  const sd = (xs) => {
    const m = mean(xs);
    return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))));
  };

  return {
    seed,
    calibration: {
      naive: { ece: calibration.naive.ece, brier: calibration.naive.brier, samples: calibration.naive.samples },
      credit: { ece: calibration.credit.ece, brier: calibration.credit.brier, samples: calibration.credit.samples },
      oracle: { ece: calibration.oracle.ece, brier: calibration.oracle.brier, samples: calibration.oracle.samples },
    },
    econ,
    refs,
    claims,
    diagnostics: {
      trainSuccessRate: round6(mean(diag.trainSuccess)),
      creditLabelMeanWorkTurns: round6(mean(diag.workQ)),
      creditLabelMeanDistractorTurns: round6(mean(diag.distractorQ)),
      creditLabelMeanSuccessTraj: round6(mean(diag.successQ)),
      creditLabelMeanFailTraj: round6(mean(diag.failQ)),
      predictionMean: {
        naive: round6(mean(predSpread.naive)),
        credit: round6(mean(predSpread.credit)),
      },
      predictionSd: {
        naive: round6(sd(predSpread.naive)),
        credit: round6(sd(predSpread.credit)),
      },
    },
  };
}

/** Run all seeds + means + overall claim verdicts. */
export function runExperiment(cfg = CONFIG) {
  const perSeed = cfg.seeds.map((s) => runSeed(s, cfg));
  const m = (pick) => round6(mean(perSeed.map(pick)));
  const meanRow = {
    calibration: {
      naive: { ece: m((r) => r.calibration.naive.ece), brier: m((r) => r.calibration.naive.brier) },
      credit: { ece: m((r) => r.calibration.credit.ece), brier: m((r) => r.calibration.credit.brier) },
      oracle: { ece: m((r) => r.calibration.oracle.ece), brier: m((r) => r.calibration.oracle.brier) },
    },
    econ: {
      naive: {
        cost: m((r) => r.econ.naive.cost),
        realizedQuality: m((r) => r.econ.naive.realizedQuality),
        cheapShare: m((r) => r.econ.naive.cheapShare),
        metBarShare: m((r) => r.econ.naive.metBarShare),
      },
      credit: {
        cost: m((r) => r.econ.credit.cost),
        realizedQuality: m((r) => r.econ.credit.realizedQuality),
        cheapShare: m((r) => r.econ.credit.cheapShare),
        metBarShare: m((r) => r.econ.credit.metBarShare),
      },
    },
    refs: {
      'always-cheap': {
        cost: m((r) => r.refs['always-cheap'].cost),
        realizedQuality: m((r) => r.refs['always-cheap'].realizedQuality),
      },
      'always-frontier': {
        cost: m((r) => r.refs['always-frontier'].cost),
        realizedQuality: m((r) => r.refs['always-frontier'].realizedQuality),
      },
    },
  };
  const verdicts = {
    calibration: {
      perSeed: perSeed.map((r) => r.claims.calibration),
      onMeans: meanRow.calibration.credit.ece < meanRow.calibration.naive.ece,
    },
    economics: {
      perSeed: perSeed.map((r) => r.claims.economics),
      onMeans:
        meanRow.econ.credit.cost <= meanRow.econ.naive.cost &&
        meanRow.econ.credit.realizedQuality >= meanRow.econ.naive.realizedQuality,
    },
  };
  return { data_source: 'SYNTHETIC', perSeed, mean: meanRow, verdicts };
}
