// SPDX-License-Identifier: MIT
//
// telemetry.mjs — pure ADR-201 telemetry math. No I/O, no deps → trivially unit-testable.
//
// Implements every metric named in ADR-201 §"Telemetry / metrics":
//   - Retrieval Lift Δ          = resolve(with-RAG) − resolve(base, no-RAG)
//   - Context Payload Compression Cr = 1 − tokens_test / tokens_control
//   - Context Degradation Rate  = resolve bucketed by retrieved-token-length (find the knee)
//   - Turn-Budget Survival S_T  = % resolved by cheap model WITHOUT the Opus fallback
//   - Cost-Adjusted Lift L_C    = Δresolve / Δcost
//   - Cost-per-correct-hop      = (embed + context cost) / correct semantic hops
// Plus Wilson 95% CI (the repo's standard for honest resolve reporting).

/** Resolve rate over a list of per-task records that have a boolean `resolved`. */
export function resolveRate(records) {
  if (!records.length) return 0;
  return records.filter((r) => r.resolved).length / records.length;
}

/** H1/H3 — Retrieval Lift Δ. Positive means RAG helped; negative = backfire (report it straight). */
export function retrievalLift(resolveWithRag, resolveBaseNoRag) {
  return +(resolveWithRag - resolveBaseNoRag);
}

/**
 * H3 — Context Payload Compression Cr = 1 − tokens_test / tokens_control.
 * Cr > 0 ⇒ the test arm sent FEWER context tokens than control (GraphRAG/curation win).
 * Cr ≤ 0 ⇒ no compression (falsifies the "fewer, higher-quality tokens" claim).
 */
export function compression(tokensTest, tokensControl) {
  if (!tokensControl) return 0;
  return +(1 - tokensTest / tokensControl);
}

/**
 * H3/C — Turn-Budget Survival S_T = fraction of tasks resolved by the cheap base model
 * WITHOUT escalating to the Opus fallback. Each record: { resolved, escalated }.
 */
export function turnBudgetSurvival(records) {
  if (!records.length) return 0;
  const survived = records.filter((r) => r.resolved && !r.escalated).length;
  return survived / records.length;
}

/**
 * Cost-Adjusted Lift L_C = Δresolve / Δcost. Guards the cost floor isn't cannibalized.
 * dCost in USD. If Δcost ≈ 0 we return Infinity-as-null (lift at no extra cost) — caller decides.
 */
export function costAdjustedLift(dResolve, dCost) {
  if (Math.abs(dCost) < 1e-9) return dResolve === 0 ? 0 : null; // null = "lift at ~zero marginal cost"
  return +(dResolve / dCost);
}

/** Cost-per-correct-hop = (embed + context $) / correct semantic hops. */
export function costPerCorrectHop(embedCost, contextCost, correctHops) {
  if (!correctHops) return null;
  return +((embedCost + contextCost) / correctHops);
}

/**
 * H2 — Context Degradation curve. Buckets per-task records by retrieved-token-length, returns
 * resolve rate per bucket and the "knee" (first bucket whose resolve drops below `kneeFrac` of
 * the best bucket). Records: { resolved, contextTokens }.
 */
export function contextDegradation(records, { bucketSize = 5000, kneeFrac = 0.7 } = {}) {
  const buckets = new Map();
  for (const r of records) {
    const b = Math.floor((r.contextTokens || 0) / bucketSize);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(r);
  }
  const curve = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([b, rs]) => ({ tokenLo: b * bucketSize, tokenHi: (b + 1) * bucketSize, n: rs.length, resolve: resolveRate(rs) }));
  const best = curve.reduce((m, p) => Math.max(m, p.resolve), 0);
  const knee = curve.find((p) => best > 0 && p.resolve < kneeFrac * best) || null;
  return { curve, best, kneeTokenLo: knee ? knee.tokenLo : null };
}

/** Wilson score interval (95% default, z=1.96). Returns {lo, hi} as rates in [0,1]. */
export function wilson(successes, n, z = 1.96) {
  if (n === 0) return { lo: 0, hi: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return { lo: Math.max(0, (centre - margin) / denom), hi: Math.min(1, (centre + margin) / denom) };
}

/** Mean of a numeric array (0 for empty). */
export function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

/** Sum of a numeric array. */
export function sum(xs) { return xs.reduce((a, b) => a + b, 0); }

/**
 * Aggregate one arm's per-task records into a summary block.
 * record shape: { id, resolved, escalated, contextTokens, cost, correctHops? }
 */
export function summarizeArm(records) {
  const n = records.length;
  const resolved = records.filter((r) => r.resolved).length;
  const ci = wilson(resolved, n);
  return {
    n,
    resolved,
    resolve: resolveRate(records),
    resolveCI: ci,
    survival_S_T: turnBudgetSurvival(records),
    meanContextTokens: mean(records.map((r) => r.contextTokens || 0)),
    totalCost: sum(records.map((r) => r.cost || 0)),
    meanCost: mean(records.map((r) => r.cost || 0)),
  };
}

/**
 * Cross-arm comparison vs a control arm. Produces Δ, Cr, L_C and degradation for the test arm.
 * `control` and `test` are arrays of per-task records (aligned by task id ideally, but the
 * metrics here are aggregate so alignment isn't required for Δ/Cr).
 */
export function compareArms(control, test) {
  const ctrl = summarizeArm(control);
  const tst = summarizeArm(test);
  const delta = retrievalLift(tst.resolve, ctrl.resolve);
  const cr = compression(tst.meanContextTokens, ctrl.meanContextTokens);
  const dCost = tst.meanCost - ctrl.meanCost;
  return {
    control: ctrl,
    test: tst,
    retrievalLift_delta: delta,
    compression_Cr: cr,
    costAdjustedLift_L_C: costAdjustedLift(delta, dCost),
    degradation: contextDegradation(test),
  };
}
