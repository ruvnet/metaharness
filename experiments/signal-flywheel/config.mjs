// signal-flywheel — frozen configuration + deterministic synthetic harness-policy
// domain (ADR-249 scorer signal seams under the ADR-234/235 flywheel).
//
// THESIS UNDER TEST: the flywheel's compounding, replay-verified promotion loop
// can run its Evaluator ENTIRELY through the new ADR-249 seams of darwin-mode's
// frozen scorer — trace quality injected from ADR-248 turn-credit
// (processTrajectory → creditByLabel/multipliers → a [0,1] figure) and
// deterministic abstract cost-units {units, budgetUnits} — with the DEFAULT
// frozen `meetsPromotionRule` gate and a never-optimized-against anchor suite.
//
// HONEST BOUND: this is a SYNTHETIC mechanism testbed. The "harness policy"
// landscape below is constructed so that better levers genuinely produce better
// turn-level evidence and cheaper runs — a win here proves the SIGNAL PLUMBING
// (turn-credit → scoreVariant seams → flywheel Score axes → frozen gate) and the
// gate's discipline, NOT model capability and NOT any benchmark number. All
// randomness is fnv1a/mulberry32-seeded; no Date.now()/Math.random() anywhere in
// this file or in any measured path.

import {
  processTrajectory,
  evidenceFromScorePairs,
  creditByLabel,
  round6,
} from '../../packages/turn-credit/dist/index.js';
import { scoreVariant } from '../../packages/darwin-mode/dist/scorer.js';

// ---------------------------------------------------------------------------
// Seeded RNG — the repo's standard pattern (see experiments/credit-feedback/lib.mjs).

/** mulberry32 — tiny deterministic PRNG. */
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

/** fnv1a — deterministic 32-bit string hash for seeding. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const uniform = (rng, lo, hi) => lo + (hi - lo) * rng();
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Key-sorted canonical string of a Policy — so rng seeding never depends on key order. */
export function canonPolicy(policy) {
  return Object.keys(policy)
    .sort()
    .map((k) => `${k}=${policy[k]}`)
    .join('|');
}

// ---------------------------------------------------------------------------
// Frozen experiment parameters — fixed BEFORE looking at any results.

/** Lever domains of the synthetic harness policy (flywheel Policy = Record<string,string>). */
export const DOMAINS = Object.freeze({
  retryLimit: ['0', '1', '2'],
  toolOrder: ['scatter', 'grounded'],
  contextDepth: ['shallow', 'medium', 'deep'],
  batchMode: ['off', 'on'],
});

/** The deliberately WEAK gen-0 root: no retries, diffuse tool use, thin context. */
export const ROOT_POLICY = Object.freeze({
  retryLimit: '0',
  toolOrder: 'scatter',
  contextDepth: 'shallow',
  batchMode: 'off',
});

/** Holdout suite — the tasks the wheel optimizes against. */
export const HOLDOUT = Object.freeze({
  id: 'holdout-tasks-1-12',
  items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((seed) => ({ seed, profile: 'standard' })),
});

/** Anchor suite — DIFFERENT task seeds + a harder difficulty profile; NEVER
 *  optimized against (the anti-Goodhart survival check of the default gate). */
export const ANCHOR = Object.freeze({
  id: 'anchor-tasks-501-510-hard',
  items: [501, 502, 503, 504, 505, 506, 507, 508, 509, 510].map((seed) => ({ seed, profile: 'anchor' })),
});

export const SIM = Object.freeze({
  // Turn budget by context depth (one evidence turn per tool visited).
  depthTurns: { shallow: 3, medium: 5, deep: 7 },
  // Fixed tool visitation order; the label on each turn's evidence.
  toolCycle: ['plan', 'search', 'read', 'edit', 'test', 'lint', 'review'],
  // Per-tool helpfulness weight (how much a well-grounded visit advances the task).
  toolWeight: { plan: 1.0, search: 0.7, read: 0.8, edit: 1.2, test: 1.1, lint: 0.4, review: 0.6 },
  // Per-turn evidence gain: delta_t = coef * (base + span * weight[tool]) * dilution_t.
  grounded: { base: 0.05, span: 0.06, dilutionChance: 0.0 },
  scatter: { base: 0.02, span: 0.03, dilutionChance: 0.45 }, // scatter wastes ~45% of turns
  dilutionFactor: 0.2, // a wasted turn keeps only 20% of its delta
  turnNoise: 0.015, // uniform ±noise on every turn's verifier delta
  runNoise: 0.03, // uniform ±noise on the run's terminal signal
  retryGain: 0.16, // signal added per retry attempt actually used
  batchSignalPenalty: 0.015, // batching loses a little interactive signal...
  batchCostFactor: 0.72, // ...but cuts cost-units by 28%
  noopFraction: 0.55, // failed run is a NO-OP iff signal < this fraction of difficulty
  difficulty: { standard: [0.3, 0.72], anchor: [0.34, 0.8] },
  // Turn-credit processing (ADR-248, verifier-delta proxy mode).
  evidenceScale: 2,
  prior: 0.5,
  // ADR-249 cost seam: abstract units (1 unit = one tool-turn executed). The
  // per-task budget prices depth/retries: a policy that buys wins with many
  // turns pays for it through costEfficiency.
  perTaskBudgetUnits: 5.5,
  costPerWinNoWins: 999999, // sentinel when a suite yields zero wins
});

// ---------------------------------------------------------------------------
// The deterministic simulator: Policy × task → one darwin-mode RunTrace-shaped
// run + its per-turn verifier-delta evidence pairs (turn-credit ScorePair[]).

/** Simulate one harness run of `policy` on a task. Pure in (policy, task). */
export function simulateRun(policy, task) {
  const rngTask = mulberry32(fnv1a(`task:${task.seed}:${task.profile}`));
  const [dLo, dHi] = SIM.difficulty[task.profile];
  const difficulty = uniform(rngTask, dLo, dHi);

  const rngRun = mulberry32(fnv1a(`run:${task.seed}:${task.profile}:${canonPolicy(policy)}`));
  const turns = SIM.depthTurns[policy.contextDepth];
  const order = SIM.toolCycle.slice(0, turns);
  const mode = policy.toolOrder === 'grounded' ? SIM.grounded : SIM.scatter;

  // Per-turn verifier deltas (the ScorePair evidence a teacher pass would emit).
  const pairs = [];
  let baseSignal = 0;
  for (let i = 0; i < order.length; i++) {
    const tool = order[i];
    const diluted = rngRun() < mode.dilutionChance;
    const raw = (mode.base + mode.span * SIM.toolWeight[tool]) * (diluted ? SIM.dilutionFactor : 1);
    const delta = raw + uniform(rngRun, -SIM.turnNoise, SIM.turnNoise);
    baseSignal += delta;
    pairs.push({
      turn: i + 1,
      label: tool,
      scoreWithout: 0.5,
      scoreWith: clamp01(0.5 + delta),
    });
  }

  const batchPenalty = policy.batchMode === 'on' ? SIM.batchSignalPenalty : 0;
  const noise = uniform(rngRun, -SIM.runNoise, SIM.runNoise);
  const retryLimit = Number(policy.retryLimit);

  // Retries: each extra attempt adds retryGain until success or exhaustion.
  let attemptsUsed = 1;
  let signal = baseSignal - batchPenalty + noise;
  while (signal < difficulty && attemptsUsed <= retryLimit) {
    attemptsUsed += 1;
    signal += SIM.retryGain;
  }
  const success = signal >= difficulty;
  const noop = !success && signal < SIM.noopFraction * difficulty;

  // Deterministic abstract cost-units: tool-turns executed across attempts,
  // discounted by batching. NOT wall-clock (ADR-249 seam contract).
  const units = round6(attemptsUsed * turns * (policy.batchMode === 'on' ? SIM.batchCostFactor : 1));

  const taskId = `t${task.seed}`;
  /** darwin-mode RunTrace shape (see packages/darwin-mode/dist/types.d.ts). */
  const trace = {
    variantId: canonPolicy(policy),
    taskId,
    startedAt: 'SYNTHETIC',
    finishedAt: 'SYNTHETIC',
    exitCode: success ? 0 : 1,
    stdout: success ? `resolved ${taskId} in ${attemptsUsed} attempt(s)` : noop ? '' : `attempted ${taskId}`,
    stderr: '',
    durationMs: Math.round(units * 1000), // derived from units, not a clock
    timedOut: false,
    blockedActions: [],
  };

  return { trace, pairs, success, noop, units };
}

// ---------------------------------------------------------------------------
// ADR-248 → ADR-249 signal derivation: turn-credit trace quality in [0,1].

/** Process one run's evidence with turn-credit and derive a [0,1] quality:
 *  0.6 × outcome-aligned credit concentration (share of positive label credit,
 *  from creditByLabel) + 0.4 × mean multiplier position in [1−λb, 1+λb]. */
export function traceQualityFromCredit(pairs, success) {
  const credit = processTrajectory({
    evidence: evidenceFromScorePairs(pairs, SIM.evidenceScale),
    mode: 'verifier-delta-proxy',
    prior: SIM.prior,
    success,
  });
  const labels = creditByLabel(credit);
  let pos = 0;
  let neg = 0;
  let multSum = 0;
  let turnSum = 0;
  for (const l of labels) {
    if (l.totalCredit >= 0) pos += l.totalCredit;
    else neg += -l.totalCredit;
    multSum += l.meanMultiplier * l.turns;
    turnSum += l.turns;
  }
  const concentration = pos + neg === 0 ? 0.5 : pos / (pos + neg);
  const lo = 1 - credit.boundPct;
  const span = 2 * credit.boundPct;
  const meanMult = turnSum === 0 ? 1 : multSum / turnSum;
  const multNorm = span === 0 ? 0.5 : clamp01((meanMult - lo) / span);
  return round6(clamp01(0.6 * concentration + 0.4 * multNorm));
}

// ---------------------------------------------------------------------------
// The Evaluator — the ONLY place domain meaning lives. Routes EVERY score
// through darwin-mode's frozen scoreVariant WITH the ADR-249 signals, then
// projects the ScoreCard onto the flywheel's four Score axes.

export function evaluatePolicyOnSuite(policy, suite) {
  const traces = [];
  let qualitySum = 0;
  let totalUnits = 0;
  let wins = 0;
  let noops = 0;
  for (const item of suite.items) {
    const r = simulateRun(policy, item);
    traces.push(r.trace);
    qualitySum += traceQualityFromCredit(r.pairs, r.success);
    totalUnits = round6(totalUnits + r.units);
    if (r.success) wins += 1;
    if (r.noop) noops += 1;
  }
  const n = suite.items.length;
  const budgetUnits = round6(SIM.perTaskBudgetUnits * n);

  // ADR-249: the frozen darwin scorer, fed through BOTH signal seams.
  const card = scoreVariant(
    canonPolicy(policy),
    traces,
    null, // baseline grading — the flywheel's frozen gate does promotion, not the card
    0,
    undefined,
    {
      traceQuality: round6(qualitySum / n),
      cost: { units: totalUnits, budgetUnits },
    },
  );

  // Projection onto the flywheel Score axes.
  const score = {
    primary: card.finalScore, // already round6'd by the scorer
    noopRate: round6(noops / n),
    costPerWin: wins === 0 ? SIM.costPerWinNoWins : round6(totalUnits / wins),
    regressed: card.safetyScore < 1, // any blocked action / safety zeroing is a hard stop
  };
  return { score, card, wins, noops, totalUnits, budgetUnits };
}
