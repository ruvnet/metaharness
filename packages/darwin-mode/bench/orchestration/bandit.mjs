// SPDX-License-Identifier: MIT
//
// bandit.mjs — a context-bucketed, two-signal Thompson-Sampling bandit.
//
// This is a faithful REIMPLEMENTATION of the @ruvector/rvf-solver PolicyKernel
// algorithm (NOT the npm package). The package (@ruvector/rvf-solver@0.1.8) exposes
// only a puzzle-train-locked surface — `train({count,minDifficulty,maxDifficulty})`
// generates and solves its OWN internal puzzles; the arms are hard-wired skip-modes
// ('none'|'weekday'|'hybrid') and there is NO public method to register external
// context/arms or feed external rewards. So we cannot route FRAMES arms through it.
// Instead we reimplement its documented model exactly:
//
//   • Per context bucket, per arm: a "safety" Beta(α,β) over success  +  a cost EMA.
//     (rvf-solver SkipModeStats: { alphaSafety, betaSafety, costEma, attempts, successes })
//   • Selection = TWO-SIGNAL: sample θ ~ Beta(α,β) (Thompson), score the arm by a
//     scalarized utility  U = θ·V − costEma  (V = $-value of a correct answer), pick argmax.
//   • Context buckets: rvf uses 18 (range×distractor×noise). We bucket FRAMES queries
//     by PRE-SOLVE features only (length × probe self-consistency × probe confidence) —
//     never gold.
//
// Update rule (observe(bucket, arm, success∈{0,1}, cost)):
//   attempts++, successes += success
//   success ? α += 1 : β += 1                    (Beta posterior on P(correct))
//   costEma = first ? cost : (1−ρ)·costEma + ρ·cost   (ρ = COST_EMA_RHO)
//
// Eval policy = greedy on the learned POSTERIOR (exploit): per bucket choose the arm
// maximizing  (α/(α+β))·V − costEma , with a fallback to the GLOBAL (pooled) posterior
// when a bucket is under-observed (< MIN_BUCKET_OBS for that arm).
//
// PURE + dependency-free. Self-test: `node bandit.mjs --selftest` ($0, deterministic).

export const COST_EMA_RHO = 0.34;     // cost-EMA smoothing (rvf default-ish, fast adapt)
export const MIN_BUCKET_OBS = 3;      // below this many per-arm obs in a bucket → use global pool

// ── seedable RNG + Gamma/Beta samplers (for Thompson sampling) ──────────────────
export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Marsaglia–Tsang Gamma(k≥1, θ=1); for k<1 use the boosting trick.
function gamma(rng, k) {
  if (k < 1) { const u = rng() || 1e-12; return gamma(rng, k + 1) * Math.pow(u, 1 / k); }
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { // standard normal via Box–Muller
      const u1 = rng() || 1e-12, u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng() || 1e-12;
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export function betaSample(rng, a, b) { const x = gamma(rng, a), y = gamma(rng, b); return x / (x + y || 1e-12); }

// ── the bandit ──────────────────────────────────────────────────────────────────
export class TwoSignalBandit {
  /** @param {string[]} arms  @param {number} V  $-value of a correct answer (accuracy↔cost knob) */
  constructor(arms, { V = 0.2, rho = COST_EMA_RHO, seed = 42 } = {}) {
    this.arms = arms.slice();
    this.V = V; this.rho = rho;
    this.rng = mulberry32(seed);
    this.buckets = new Map();                 // bucket → { arm → stats }
    this.global = this._freshArmTable();      // pooled across all buckets
  }
  _freshStat() { return { attempts: 0, successes: 0, alpha: 1, beta: 1, costEma: 0, costN: 0 }; }
  _freshArmTable() { const t = {}; for (const a of this.arms) t[a] = this._freshStat(); return t; }
  _bucket(b) { if (!this.buckets.has(b)) this.buckets.set(b, this._freshArmTable()); return this.buckets.get(b); }

  _upd(stat, success, cost) {
    stat.attempts++; stat.successes += success ? 1 : 0;
    if (success) stat.alpha += 1; else stat.beta += 1;
    stat.costEma = stat.costN === 0 ? cost : (1 - this.rho) * stat.costEma + this.rho * cost;
    stat.costN++;
  }
  /** Record one (bucket, arm) outcome into both the bucket table and the global pool. */
  observe(bucket, arm, success, cost) {
    this._upd(this._bucket(bucket)[arm], success, cost);
    this._upd(this.global[arm], success, cost);
  }

  /** Posterior-mean utility for an arm in a bucket, with global fallback when sparse. */
  _utility(bucket, arm) {
    const bt = this.buckets.get(bucket);
    const local = bt?.[arm];
    const use = (local && local.attempts >= MIN_BUCKET_OBS) ? local : this.global[arm];
    const pMean = use.alpha / (use.alpha + use.beta);
    const cost = use.costN ? use.costEma : 0;
    return { U: pMean * this.V - cost, pMean, cost, from: (use === local ? 'bucket' : 'global'), obs: use.attempts };
  }
  /** GREEDY posterior policy used at EVAL (exploit): argmax utility. Deterministic. */
  choose(bucket) {
    let best = null;
    for (const arm of this.arms) { const u = this._utility(bucket, arm); if (!best || u.U > best.U) best = { arm, ...u }; }
    return best;
  }
  /** Thompson selection (explore): sample θ~Beta per arm, score θ·V − costEma. Used in the online sim. */
  sample(bucket) {
    let best = null;
    for (const arm of this.arms) {
      const bt = this.buckets.get(bucket); const local = bt?.[arm];
      const use = (local && local.attempts >= MIN_BUCKET_OBS) ? local : this.global[arm];
      const theta = betaSample(this.rng, use.alpha, use.beta);
      const cost = use.costN ? use.costEma : 0;
      const U = theta * this.V - cost;
      if (!best || U > best.U) best = { arm, U, theta, cost };
    }
    return best;
  }
  /** Compact JSON of the learned policy (per bucket: chosen arm + per-arm posteriors). */
  snapshot() {
    const out = { V: this.V, rho: this.rho, arms: this.arms, global: {}, buckets: {} };
    for (const a of this.arms) { const s = this.global[a]; out.global[a] = { n: s.attempts, pMean: round(s.alpha / (s.alpha + s.beta)), costEma: round(s.costEma, 6) }; }
    for (const [b, t] of this.buckets) {
      const choice = this.choose(b);
      out.buckets[b] = { choose: choice.arm, U: round(choice.U, 5), arms: {} };
      for (const a of this.arms) { const s = t[a]; out.buckets[b].arms[a] = { n: s.attempts, pMean: round(s.alpha / (s.alpha + s.beta)), costEma: round(s.costEma, 6) }; }
    }
    return out;
  }
}
const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

// ── $0 deterministic self-test ───────────────────────────────────────────────────
// Synthetic world: 2 buckets. In "easy" bucket the cheap arm is correct ~90% at $0.01;
// frontier is correct ~92% at $0.20 → cheap dominates on utility. In "hard" bucket the
// cheap arm is ~25%, frontier ~85% at $0.20 → frontier should win. A correct learner
// routes easy→cheap, hard→frontier and beats any single fixed arm on utility.
if (process.argv.includes('--selftest')) {
  const rng = mulberry32(7);
  const arms = ['cheap', 'frontier'];
  const world = {
    easy:  { cheap: { p: 0.90, c: 0.01 }, frontier: { p: 0.92, c: 0.20 } },
    hard:  { cheap: { p: 0.25, c: 0.01 }, frontier: { p: 0.85, c: 0.20 } },
  };
  const draw = (b, a) => ({ success: rng() < world[b][a].p ? 1 : 0, cost: world[b][a].c });
  const bandit = new TwoSignalBandit(arms, { V: 0.5, seed: 1 });
  // TRAIN: full-information — observe BOTH arms on 60 train items per bucket.
  for (const b of ['easy', 'hard']) for (let i = 0; i < 60; i++) for (const a of arms) { const o = draw(b, a); bandit.observe(b, a, o.success, o.cost); }
  const snap = bandit.snapshot();
  console.log('learned policy:', JSON.stringify(snap.buckets, null, 2));
  const okEasy = snap.buckets.easy.choose === 'cheap';
  const okHard = snap.buckets.hard.choose === 'frontier';
  // EVAL: 200 fresh per bucket; compare learned routing vs always-cheap vs always-frontier on utility U=p·V−c.
  const V = 0.5; let learnedU = 0, cheapU = 0, frontU = 0, n = 0;
  for (const b of ['easy', 'hard']) for (let i = 0; i < 200; i++) {
    n++;
    const pick = bandit.choose(b).arm; const lo = draw(b, pick); learnedU += lo.success * V - lo.cost;
    const co = draw(b, 'cheap'); cheapU += co.success * V - co.cost;
    const fo = draw(b, 'frontier'); frontU += fo.success * V - fo.cost;
  }
  console.log(`eval mean utility — learned ${round(learnedU / n)} | always-cheap ${round(cheapU / n)} | always-frontier ${round(frontU / n)}`);
  const beatsStatic = learnedU > cheapU && learnedU > frontU;
  console.log(`routing correct: easy→cheap ${okEasy}, hard→frontier ${okHard} | learned beats best static: ${beatsStatic}`);
  process.exit(okEasy && okHard && beatsStatic ? 0 : 1);
}
