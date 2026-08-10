// turn-credit-acceptance — offline executable form of the ADR-248 §6 gate.
//
// THESIS UNDER TEST: on long-horizon (12–30 turn) tasks, updating a policy's
// tool/route/retry priors between episodes USING ONLY @metaharness/turn-credit
// outputs (processTrajectory → creditByLabel, GRPO-style reshaped advantage)
// improves verified completion by ≥5pp over the identical fixed policy, at
// <20% deterministic processing-cost overhead, with zero increase in
// governance violations — the three frozen clauses of ADR-248 §6.
//
// HONEST BOUND: this is a SYNTHETIC mechanism proof, not the §6 LIVE gate.
// The environment was designed by the same authors as the mechanism, and its
// per-turn teacher signal (verifier score deltas) correlates with latent
// usefulness BY CONSTRUCTION — favorable by design. The §6 gate on real
// RuFlo trajectories remains OPEN. Evidence mode is 'verifier-delta-proxy'
// (ordinal, not AgentOPSD proper). All randomness is mulberry32/fnv1a-seeded;
// reported numbers are round6'd; no Date.now()/Math.random() anywhere.

import {
  processTrajectory,
  evidenceFromScorePairs,
  creditByLabel,
  PAPER_DEFAULTS,
  round6,
} from '../../packages/turn-credit/dist/index.js';

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

/** fnv1a — the repo's standard string hash (packages/projects/src/core.ts). */
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Frozen experiment parameters — fixed BEFORE looking at any results. */
export const CONFIG = Object.freeze({
  seeds: [101, 202, 303], // 3 seeds (ADR-248 §6)
  tasksPerSeed: 300, // 300 long-horizon tasks per seed (ADR-248 §6)
  minTurns: 12,
  maxTurns: 30, // episode length L ~ U{12..30}
  taskTypes: 6, // tasks cycle through 6 latent types (t % 6)
  usefulPerType: 3, // per type, 3 of the 6 legit actions are latently useful
  successTheta: 0.55, // verifier: success iff usefulCount >= ceil(theta * L)
  // Action set: 6 legit tool/route/retry actions + 1 governance-forbidden one.
  actions: Object.freeze([
    'tool:search',
    'tool:parse',
    'tool:exec',
    'route:direct',
    'route:plan',
    'retry',
  ]),
  forbidden: 'forbidden:bypass-guard',
  // Baseline "sensible" policy prior weights (shared starting point of BOTH
  // arms): uniform over legit actions, small residual mass on the forbidden
  // action (a sensible-but-imperfect agent occasionally reaches for it).
  legitWeight: 1,
  forbiddenWeight: 0.08,
  // Teacher signal (verifier score deltas, observable to the credit pass):
  strengthRange: [0.15, 0.4], // per-task useful-action score delta
  forbiddenDelta: -0.15, // forbidden action hurts the verifier score
  deltaNoise: 0.08, // uniform ±noise on EVERY turn's delta
  evidenceScale: 2, // e_k = scale · (scoreWith − scoreWithout)
  prior: 0.5, // group success base rate handed to processTrajectory
  // Credit-arm policy update (exponentiated GRPO-style reshaped advantage):
  eta: 6, // learning rate on advantage·m_k per label
  weightFloor: 0.02,
  weightCeil: 60,
  // Frozen deterministic cost model (invocation counting — see README):
  // base episode ops = 2L+1 (L model calls + L tool executions + 1 verifier
  // pass); credit-pass ops = 4 per episode (2 teacher scoring passes over the
  // recorded trajectory + 1 credit-processing pass + 1 prior-update
  // application). A uniform per-turn arithmetic count is ALSO reported as a
  // diagnostic (arith base = 5L+1 stage-ops, arith credit = 4L+U stage-ops).
  baseOpsPerTurn: 2,
  baseOpsTerminal: 1,
  creditOpsPerEpisode: 4,
  arithBasePerTurn: 5,
  arithCreditPerTurn: 4,
  // Frozen §6 gate thresholds:
  gateLiftPp: 0.05, // lift >= 5 percentage points
  gateOverheadMax: 0.2, // overhead < 20%
  // zero governance-violation increase: creditViolations - baseViolations <= 0
});

const uniform = (rng, lo, hi) => lo + (hi - lo) * rng();

/** Per-seed environment: each task type gets a latent useful subset of the
 *  legit actions. Latents are IDENTICAL for both arms (same seed). */
export function buildEnv(seed, cfg = CONFIG) {
  const rng = mulberry32(fnv1a(`env:${seed}`));
  const usefulByType = [];
  for (let ty = 0; ty < cfg.taskTypes; ty++) {
    const pool = cfg.actions.slice();
    const useful = new Set();
    while (useful.size < cfg.usefulPerType) {
      const i = Math.floor(rng() * pool.length);
      useful.add(pool.splice(i, 1)[0]);
    }
    usefulByType.push(useful);
  }
  return { usefulByType };
}

/** Fresh policy weights (the shared starting point of both arms). */
export function initialWeights(cfg = CONFIG) {
  const w = new Map();
  for (const a of cfg.actions) w.set(a, cfg.legitWeight);
  w.set(cfg.forbidden, cfg.forbiddenWeight);
  return w;
}

/** Sample one action from categorical weights (deterministic in rng). */
export function sampleAction(rng, weights, cfg = CONFIG) {
  const labels = [...cfg.actions, cfg.forbidden];
  let total = 0;
  for (const a of labels) total += weights.get(a);
  let x = rng() * total;
  for (const a of labels) {
    x -= weights.get(a);
    if (x <= 0) return a;
  }
  return labels[labels.length - 1];
}

/** Roll one episode of task t under the given per-type policy weights.
 *  Task latents (type, length, strength) and the rollout rng derive from the
 *  task seed alone, so both arms face IDENTICAL tasks; the two arms diverge
 *  only through their action choices. The governance guard flags every use of
 *  the forbidden action — the SAME guard rule for both arms. Emits the
 *  observable teacher score pairs (verifier instrumentation) per turn. */
export function rollEpisode(seed, t, env, weightsByType, cfg = CONFIG) {
  const taskSeed = fnv1a(`task:${seed}:${t}`);
  const taskRng = mulberry32(taskSeed);
  const type = t % cfg.taskTypes;
  const L = cfg.minTurns + Math.floor(taskRng() * (cfg.maxTurns - cfg.minTurns + 1));
  const strength = uniform(taskRng, ...cfg.strengthRange);
  const rolloutRng = mulberry32(taskSeed ^ 0x9e3779b9);
  const useful = env.usefulByType[type];
  const weights = weightsByType[type];

  const pairs = [];
  let usefulCount = 0;
  let violations = 0;
  for (let k = 1; k <= L; k++) {
    const a = sampleAction(rolloutRng, weights, cfg);
    if (a === cfg.forbidden) violations++; // governance guard flags this turn
    const isUseful = useful.has(a);
    if (isUseful) usefulCount++;
    const base = isUseful ? strength : a === cfg.forbidden ? cfg.forbiddenDelta : 0;
    const delta = base + uniform(rolloutRng, -cfg.deltaNoise, cfg.deltaNoise);
    pairs.push({ turn: k, label: a, scoreWithout: 0.5, scoreWith: 0.5 + delta });
  }
  const success = usefulCount >= Math.ceil(cfg.successTheta * L); // verifier
  return { type, L, pairs, success, violations };
}

/** Credit-arm learning step. Consumes ONLY turn-credit outputs: the processed
 *  trajectory's terminal advantage and creditByLabel's per-label aggregates
 *  (turns, meanMultiplier). Update is the GRPO-style reshaped advantage
 *  Ã = A_seq · m_k, exponentiated per label:
 *    w[label] *= exp(eta · A_seq · turns · meanMultiplier / L)
 *  then renormalized (sum = |action set|) with a floor/ceiling clip. The
 *  latent usefulness sets are NEVER read here — only the observable score
 *  pairs and the verified terminal outcome. Returns the number of label
 *  updates applied (for the arithmetic-op diagnostic). */
export function creditUpdate(weights, episode, cfg = CONFIG) {
  const credit = processTrajectory({
    evidence: evidenceFromScorePairs(episode.pairs, cfg.evidenceScale),
    mode: 'verifier-delta-proxy',
    prior: cfg.prior,
    success: episode.success,
    config: PAPER_DEFAULTS, // ±25% modulation — the paper's full dynamic range
  });
  const labels = creditByLabel(credit);
  for (const lc of labels) {
    const step = (cfg.eta * credit.advantage * lc.turns * lc.meanMultiplier) / episode.L;
    weights.set(lc.label, weights.get(lc.label) * Math.exp(step));
  }
  // Renormalize so total mass stays at |action set|, then clip.
  const all = [...cfg.actions, cfg.forbidden];
  let total = 0;
  for (const a of all) total += weights.get(a);
  for (const a of all) {
    const v = (weights.get(a) * all.length) / total;
    weights.set(a, Math.min(cfg.weightCeil, Math.max(cfg.weightFloor, v)));
  }
  return labels.length;
}

/** Run one arm ('baseline' fixed policy | 'credit' turn-credit-updated) over
 *  the seed's 300 tasks. Pure in (seed, arm). */
export function runArm(seed, arm, cfg = CONFIG) {
  const env = buildEnv(seed, cfg);
  const weightsByType = Array.from({ length: cfg.taskTypes }, () => initialWeights(cfg));
  let successes = 0;
  let violations = 0;
  let baseOps = 0;
  let creditOps = 0;
  let arithBaseOps = 0;
  let arithCreditOps = 0;

  for (let t = 0; t < cfg.tasksPerSeed; t++) {
    const ep = rollEpisode(seed, t, env, weightsByType, cfg);
    if (ep.success) successes++;
    violations += ep.violations;
    baseOps += cfg.baseOpsPerTurn * ep.L + cfg.baseOpsTerminal;
    arithBaseOps += cfg.arithBasePerTurn * ep.L + 1;
    if (arm === 'credit') {
      const updates = creditUpdate(weightsByType[ep.type], ep, cfg);
      creditOps += cfg.creditOpsPerEpisode;
      arithCreditOps += cfg.arithCreditPerTurn * ep.L + updates;
    }
  }

  return {
    completionRate: round6(successes / cfg.tasksPerSeed),
    violations,
    baseOps,
    creditOps,
    overhead: round6(creditOps / baseOps),
    arithOverhead: round6(arithCreditOps / arithBaseOps),
  };
}

/** One seed, both arms over IDENTICAL task seeds, plus the per-seed clauses. */
export function runSeed(seed, cfg = CONFIG) {
  const baseline = runArm(seed, 'baseline', cfg);
  const credit = runArm(seed, 'credit', cfg);
  return {
    seed,
    baseline,
    credit,
    lift: round6(credit.completionRate - baseline.completionRate),
    violationIncrease: credit.violations - baseline.violations,
  };
}

/** Full experiment: per-seed metrics, means, and the FROZEN §6 gate verdict.
 *  Deterministic: same cfg ⇒ byte-identical payload. */
export function runExperiment(cfg = CONFIG) {
  const perSeed = cfg.seeds.map((s) => runSeed(s, cfg));
  const mean = (pick) => round6(perSeed.reduce((a, r) => a + pick(r), 0) / perSeed.length);
  const meanArm = (arm) => ({
    completionRate: mean((r) => r[arm].completionRate),
    violations: mean((r) => r[arm].violations),
    overhead: mean((r) => r[arm].overhead),
    arithOverhead: mean((r) => r[arm].arithOverhead),
  });
  const m = { baseline: meanArm('baseline'), credit: meanArm('credit') };
  const lift = round6(m.credit.completionRate - m.baseline.completionRate);
  const violationIncrease = round6(m.credit.violations - m.baseline.violations);

  const gate = {
    clause_lift: {
      description: 'verified completion lift >= 5 percentage points',
      threshold: cfg.gateLiftPp,
      value: lift,
      pass: lift >= cfg.gateLiftPp,
    },
    clause_overhead: {
      description: 'credit-pass processing overhead < 20% (invocation-count model)',
      threshold: cfg.gateOverheadMax,
      value: m.credit.overhead,
      pass: m.credit.overhead < cfg.gateOverheadMax,
    },
    clause_governance: {
      description: 'zero increase in governance violations (credit − baseline <= 0)',
      threshold: 0,
      value: violationIncrease,
      pass: violationIncrease <= 0,
    },
  };
  const verdict =
    gate.clause_lift.pass && gate.clause_overhead.pass && gate.clause_governance.pass
      ? 'PASS'
      : 'FAIL';

  return {
    schema: 'turn-credit-acceptance/v1',
    adr: 'ADR-248 §6 — OFFLINE SYNTHETIC FORM; the LIVE gate on real RuFlo trajectories remains OPEN',
    data_source: 'SYNTHETIC',
    config: cfg,
    perSeed,
    mean: { ...m, lift, violationIncrease },
    gate,
    verdict,
  };
}
