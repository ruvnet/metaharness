// credit-feedback replay — shared library (deterministic, $0, no network).
//
// THESIS: per-turn credit multipliers from @metaharness/turn-credit's
// toMemoryFeedback, used as retrieval-feedback weights, separate genuinely
// helpful skills from equally-often-retrieved distractors, while uniform
// feedback (weight = 1 per turn) cannot — because uniform feedback rewards
// every retrieved skill of a resolved trajectory identically.
//
// HONEST BOUND: this is a MECHANISM TESTBED on synthetic trajectories whose
// construction favors the mechanism by design (helpful skills carry higher
// per-turn verifier-delta evidence *by construction*, and every skill in a
// pool is retrieved exactly equally often, so the uniform arm is rank-inert
// within a pool). A win here shows the plumbing does what it claims on data
// where turn-level evidence is real; it is NOT a benchmark claim about real
// retrieval corpora. Evidence mode is 'verifier-delta-proxy' (ordinal, not
// AgentOPSD proper). All randomness is mulberry32-seeded; all reported
// numbers are round6'd; no Date.now()/Math.random() anywhere.

import {
  processTrajectory,
  evidenceFromScorePairs,
  toMemoryFeedback,
  PAPER_DEFAULTS,
  round6,
} from '../../packages/turn-credit/dist/index.js';

/** mulberry32 — the repo's standard tiny deterministic PRNG (see darwin-mode/clade). */
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

/** Frozen experiment parameters — fixed BEFORE looking at any results. */
export const CONFIG = Object.freeze({
  seeds: [101, 202, 303],
  queries: 10, // distinct task types, each with its own candidate pool
  helpfulPerQuery: 2, // genuinely-helpful skills per pool
  distractorsPerQuery: 6, // distractors per pool (retrieved equally often)
  trajectoriesPerSeed: 120,
  prior: 0.5, // group success base rate handed to processTrajectory
  evidenceScale: 2, // proxy scale: e_k = scale · (scoreWith − scoreWithout)
  successThreshold: 0.35, // trajectory resolves iff Σ raw score-deltas > this
  eta: 0.05, // retrieval score = base + eta · accumulated feedback
  // Base relevance: distractors are drawn slightly HIGHER than helpful skills,
  // so the pre-feedback ranking (= the uniform arm's final ranking) favors
  // distractors. This is the deliberate hard case for feedback to fix.
  helpfulBaseRange: [0.4, 0.55],
  distractorBaseRange: [0.45, 0.6],
  // Per-trajectory helpful strength (verifier-score-delta units) and noise.
  helpfulDeltaRange: [0.1, 0.45],
  deltaNoise: 0.05, // uniform ±noise added to EVERY turn's delta
});

const uniform = (rng, lo, hi) => lo + (hi - lo) * rng();

/** Fisher–Yates with the supplied rng (deterministic). */
function shuffle(rng, xs) {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Build the per-seed skill index: `queries` pools of helpful + distractor
 *  skills, each with a base relevance score drawn from its frozen range. */
export function buildIndex(rng, cfg = CONFIG) {
  const skills = new Map(); // id -> { base, helpful, query }
  const pools = [];
  for (let q = 0; q < cfg.queries; q++) {
    const pool = [];
    for (let h = 0; h < cfg.helpfulPerQuery; h++) {
      const id = `q${q}-h${h}`;
      skills.set(id, { base: uniform(rng, ...cfg.helpfulBaseRange), helpful: true, query: q });
      pool.push(id);
    }
    for (let d = 0; d < cfg.distractorsPerQuery; d++) {
      const id = `q${q}-d${d}`;
      skills.set(id, { base: uniform(rng, ...cfg.distractorBaseRange), helpful: false, query: q });
      pool.push(id);
    }
    pools.push(pool);
  }
  return { skills, pools };
}

/** One synthetic trajectory for a query's pool. Every skill in the pool is
 *  retrieved on exactly one turn (a shuffled permutation), so helpful and
 *  distractor skills have IDENTICAL retrieval frequency — only the per-turn
 *  evidence differs. Helpful turns carry a positive verifier-score delta
 *  (`strength` ± noise); distractor turns carry ~zero (± noise) delta. */
export function genTrajectory(rng, pool, skills, cfg = CONFIG) {
  const strength = uniform(rng, ...cfg.helpfulDeltaRange);
  const order = shuffle(rng, pool);
  const pairs = [];
  const retrievedIdsByTurn = new Map();
  let rawSum = 0;
  for (let i = 0; i < order.length; i++) {
    const turn = i + 1;
    const id = order[i];
    const noise = uniform(rng, -cfg.deltaNoise, cfg.deltaNoise);
    const delta = (skills.get(id).helpful ? strength : 0) + noise;
    rawSum += delta;
    pairs.push({
      turn,
      label: id,
      scoreWithout: 0.5,
      scoreWith: Math.min(1, Math.max(0, 0.5 + delta)),
    });
    retrievedIdsByTurn.set(turn, [id]);
  }
  const success = rawSum > cfg.successThreshold;
  return { pairs, retrievedIdsByTurn, success };
}

/** Apply MemoryLayer-shaped feedback records to an accumulator:
 *  resolved records add +weight to each retrieved id, unresolved subtract it.
 *  The two arms differ ONLY in `weight` (1 vs the turn's credit multiplier). */
export function applyFeedback(accum, records) {
  for (const r of records) {
    const signed = (r.resolved ? 1 : -1) * r.weight;
    for (const id of r.retrievedIds) accum.set(id, (accum.get(id) ?? 0) + signed);
  }
}

/** Held-out retrieval pass: rank each pool by base + eta·accumulated feedback
 *  (ties broken by id, so ranking is total and deterministic), then measure
 *  hit@1 (top-1 is helpful), hit@3 (any helpful in top-3), and recall@3
 *  (fraction of the 2 helpful skills inside the top-3), averaged over pools. */
export function evaluate(index, accum, cfg = CONFIG) {
  let hit1 = 0;
  let hit3 = 0;
  let recall3 = 0;
  for (const pool of index.pools) {
    const ranked = pool
      .map((id) => ({ id, score: index.skills.get(id).base + cfg.eta * (accum.get(id) ?? 0) }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    const top3 = ranked.slice(0, 3).map((r) => index.skills.get(r.id).helpful);
    hit1 += top3[0] ? 1 : 0;
    hit3 += top3.some(Boolean) ? 1 : 0;
    recall3 += top3.filter(Boolean).length / cfg.helpfulPerQuery;
  }
  const n = index.pools.length;
  return { hit1: round6(hit1 / n), hit3: round6(hit3 / n), recall3: round6(recall3 / n) };
}

/** Run the full replay for one seed: generate trajectories, process each with
 *  processTrajectory (verifier-delta proxy), collect feedback under both arms,
 *  and evaluate the held-out retrieval pass. Pure in the seed. */
export function runSeed(seed, cfg = CONFIG) {
  const rng = mulberry32(seed);
  const index = buildIndex(rng, cfg);
  const accumUniform = new Map();
  const accumCredit = new Map();
  let successes = 0;

  for (let t = 0; t < cfg.trajectoriesPerSeed; t++) {
    const q = t % cfg.queries; // every pool sees the same number of trajectories
    const { pairs, retrievedIdsByTurn, success } = genTrajectory(rng, index.pools[q], index.skills, cfg);
    if (success) successes++;

    const credit = processTrajectory({
      evidence: evidenceFromScorePairs(pairs, cfg.evidenceScale),
      mode: 'verifier-delta-proxy',
      prior: cfg.prior,
      success,
      config: PAPER_DEFAULTS, // ±25% modulation — the paper's full dynamic range
    });

    const creditFb = toMemoryFeedback(credit, retrievedIdsByTurn);
    const uniformFb = creditFb.map((r) => ({ ...r, weight: 1 }));
    applyFeedback(accumCredit, creditFb);
    applyFeedback(accumUniform, uniformFb);
  }

  return {
    seed,
    successRate: round6(successes / cfg.trajectoriesPerSeed),
    uniform: evaluate(index, accumUniform, cfg),
    credit: evaluate(index, accumCredit, cfg),
  };
}

/** Run all seeds + means. Deterministic: same cfg ⇒ byte-identical result. */
export function runExperiment(cfg = CONFIG) {
  const perSeed = cfg.seeds.map((s) => runSeed(s, cfg));
  const mean = (pick) =>
    round6(perSeed.reduce((a, r) => a + pick(r), 0) / perSeed.length);
  const meanArm = (arm) => ({
    hit1: mean((r) => r[arm].hit1),
    hit3: mean((r) => r[arm].hit3),
    recall3: mean((r) => r[arm].recall3),
  });
  return {
    schema: 'credit-feedback-replay/v1',
    config: cfg,
    perSeed,
    mean: {
      successRate: mean((r) => r.successRate),
      uniform: meanArm('uniform'),
      credit: meanArm('credit'),
    },
  };
}
