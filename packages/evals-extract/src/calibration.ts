// @metaharness/evals-extract — CONFIDENCE CALIBRATION.
//
// Confidence feeds two decisions: escalate (below escalationThreshold) and abstain (below abstainThreshold).
// The confidenceRule lever picks how it is derived. We also compute a suite-level CALIBRATION ERROR (a
// reliability gap): a well-calibrated policy's mean confidence on the objects it commits to should track its
// actual field-correctness. Worsening calibration blocks promotion (folded into the extract gate) — a policy
// that extracts correctly but lies about its confidence is not an improvement.
import type { ConfidenceRule } from './genome.js';

export interface ConfidenceInput {
  /** Model self-reported logprob-ish confidence in [0,1], if available. */
  selfReport?: number;
  /** Fraction of required fields the extraction actually populated, in [0,1]. */
  fieldCoverage?: number;
  /** Verifier stack agreement in [0,1]. */
  verifierAgreement?: number;
}

export function confidence(rule: ConfidenceRule, x: ConfidenceInput): number {
  const sr = clamp01(x.selfReport ?? 0.5);
  const fc = clamp01(x.fieldCoverage ?? 0.5);
  const va = clamp01(x.verifierAgreement ?? 0.5);
  switch (rule) {
    case 'selfReport': return sr;
    case 'fieldCoverage': return fc;
    case 'verifierAgreement': return va;
    case 'hybrid': return clamp01(0.4 * sr + 0.3 * fc + 0.3 * va);
  }
}

/** Expected Calibration Error over committed extractions, binned. Lower is better. Abstentions are excluded
 *  (you cannot be mis-calibrated about an object you declined to emit). */
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
