// @metaharness/evals-sql — CONFIDENCE CALIBRATION.
//
// Confidence feeds two decisions: escalate (below escalationThreshold) and abstain (below abstainThreshold).
// The confidenceRule lever picks how it is derived. We also compute a suite-level CALIBRATION ERROR (a
// reliability gap): a well-calibrated policy's mean confidence on the queries it commits to should track its
// actual execution accuracy. Worsening calibration blocks promotion (folded into the SQL gate) — a policy
// that gets queries right but lies about its confidence is not an improvement.
import type { ConfidenceRule } from './genome.js';

export interface ConfidenceInput {
  /** Model self-reported logprob-ish confidence in [0,1], if available. */
  logprob?: number;
  /** Self-consistency agreement in [0,1] (fraction of sampled queries agreeing). */
  selfConsistency?: number;
  /** Execute-and-compare agreement in [0,1] (fraction of sampled result sets agreeing). */
  executionAgreement?: number;
}

export function confidence(rule: ConfidenceRule, x: ConfidenceInput): number {
  const lp = clamp01(x.logprob ?? 0.5);
  const sc = clamp01(x.selfConsistency ?? 0.5);
  const ea = clamp01(x.executionAgreement ?? 0.5);
  switch (rule) {
    case 'logprob': return lp;
    case 'selfConsistency': return sc;
    case 'executionAgreement': return ea;
    case 'hybrid': return clamp01(0.4 * lp + 0.3 * sc + 0.3 * ea);
  }
}

/** Expected Calibration Error over committed queries, binned. Lower is better. Abstentions are excluded
 *  (you cannot be mis-calibrated about a query you declined to give). */
export function calibrationError(
  committed: Array<{ confidence: number; correct: boolean }>,
  bins = 10,
): number {
  if (committed.length === 0) return 0;
  const buckets: Array<{ conf: number; acc: number; n: number }> = Array.from({ length: bins }, () => ({ conf: 0, acc: 0, n: 0 }));
  for (const c of committed) {
    const i = Math.min(bins - 1, Math.floor(clamp01(c.confidence) * bins));
    buckets[i].conf += c.confidence;
    buckets[i].acc += c.correct ? 1 : 0;
    buckets[i].n += 1;
  }
  let ece = 0;
  for (const b of buckets) {
    if (b.n === 0) continue;
    ece += (b.n / committed.length) * Math.abs(b.conf / b.n - b.acc / b.n);
  }
  return ece;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
