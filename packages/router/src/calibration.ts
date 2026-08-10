// SPDX-License-Identifier: MIT
//
// @metaharness/router — calibration audit for routing quality predictions.
//
// Thesis: the router picks the cheapest candidate whose PREDICTED quality
// clears the bar, so the whole cost-optimality argument rests on those
// predictions being calibrated against realized outcomes. A router whose
// predictions are miscalibrated silently overpays (systematic underprediction
// pushes traffic to dear models) or under-delivers (systematic overprediction
// ships work below the bar) — and nothing in route() itself can detect either.
// This module audits it: feed it (predictedQuality, realized outcome) pairs —
// recorded RouterExample outcomes, or turn-credit quality labels produced
// upstream — and it reports Brier score, reliability bins, and expected
// calibration error (ECE).
//
// Honest bound: calibration is necessary, not sufficient — a predictor that
// always says the base rate is perfectly calibrated and useless for routing
// (zero resolution). And small bins are noisy: a 3-sample bin's meanRealized
// says almost nothing, which is why every bin reports its count — read gaps
// only where counts are large. Pure, deterministic, dependency-free;
// structural types only (no import of turn-credit or any other package).

/** One audited prediction: what the router predicted vs. what actually happened. */
export interface CalibrationPair {
  /** The router's predicted quality, in [0, 1]. */
  predicted: number;
  /** Realized outcome, in [0, 1] (use 0/1 for binary success labels). */
  realized: number;
}

/** One reliability bin over predicted-quality space [lo, hi). Last bin includes 1. */
export interface ReliabilityBin {
  lo: number;
  hi: number;
  /** Samples whose prediction fell in this bin. Small counts ⇒ noisy gap — report, don't trust. */
  count: number;
  /** Mean predicted quality in the bin (0 when count is 0). */
  meanPredicted: number;
  /** Mean realized outcome in the bin (0 when count is 0). */
  meanRealized: number;
  /** meanRealized − meanPredicted. Positive ⇒ underprediction, negative ⇒ overprediction. */
  gap: number;
}

export interface CalibrationReport {
  samples: number;
  brier: number;
  ece: number;
  bins: ReliabilityBin[];
  /** The non-empty bin with the largest |gap| (lowest bin wins ties); null with zero samples. */
  worstBin: ReliabilityBin | null;
}

const DEFAULT_BIN_COUNT = 10;

/** Round to 6 decimals — the artifact precision used across metaharness. */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function validate(pairs: CalibrationPair[]): void {
  for (let i = 0; i < pairs.length; i++) {
    const { predicted, realized } = pairs[i];
    if (!Number.isFinite(predicted) || predicted < 0 || predicted > 1) {
      throw new RangeError(`calibration: pairs[${i}].predicted must be in [0,1], got ${predicted}`);
    }
    if (!Number.isFinite(realized) || realized < 0 || realized > 1) {
      throw new RangeError(`calibration: pairs[${i}].realized must be in [0,1], got ${realized}`);
    }
  }
}

/**
 * Brier score: mean squared error between predicted and realized, in [0, 1].
 * Lower is better; 0 is a perfect sharp predictor. For a calibrated predictor
 * emitting p against binary outcomes the expected per-sample score is p(1−p).
 * Empty input returns 0 (zero-sample audit — see calibrationReport).
 */
export function brierScore(pairs: CalibrationPair[]): number {
  validate(pairs);
  if (pairs.length === 0) return 0;
  let s = 0;
  for (const { predicted, realized } of pairs) {
    const d = predicted - realized;
    s += d * d;
  }
  return s / pairs.length;
}

/**
 * Equal-width reliability bins over predicted quality. Bin i covers
 * [i/binCount, (i+1)/binCount), with the last bin closed at 1. All binCount
 * bins are returned (empty ones with count 0) so the histogram shape is stable
 * regardless of the data — callers weight by count.
 */
export function reliabilityBins(pairs: CalibrationPair[], binCount = DEFAULT_BIN_COUNT): ReliabilityBin[] {
  if (!Number.isInteger(binCount) || binCount < 1) {
    throw new RangeError(`calibration: binCount must be a positive integer, got ${binCount}`);
  }
  validate(pairs);
  const counts = new Array<number>(binCount).fill(0);
  const sumPredicted = new Array<number>(binCount).fill(0);
  const sumRealized = new Array<number>(binCount).fill(0);
  for (const { predicted, realized } of pairs) {
    const i = Math.min(Math.floor(predicted * binCount), binCount - 1);
    counts[i] += 1;
    sumPredicted[i] += predicted;
    sumRealized[i] += realized;
  }
  const bins: ReliabilityBin[] = new Array(binCount);
  for (let i = 0; i < binCount; i++) {
    const count = counts[i];
    const meanPredicted = count > 0 ? sumPredicted[i] / count : 0;
    const meanRealized = count > 0 ? sumRealized[i] / count : 0;
    bins[i] = {
      lo: i / binCount,
      hi: (i + 1) / binCount,
      count,
      meanPredicted,
      meanRealized,
      gap: meanRealized - meanPredicted,
    };
  }
  return bins;
}

/**
 * Expected calibration error: the count-weighted mean of per-bin |gap|.
 * 0 for a perfectly calibrated predictor (and for empty input — zero-sample
 * audit, not evidence of calibration).
 */
export function expectedCalibrationError(pairs: CalibrationPair[], binCount = DEFAULT_BIN_COUNT): number {
  const bins = reliabilityBins(pairs, binCount);
  const total = pairs.length;
  if (total === 0) return 0;
  let weighted = 0;
  for (const b of bins) weighted += b.count * Math.abs(b.gap);
  return weighted / total;
}

/**
 * Full calibration audit: sample count, Brier, ECE, the reliability bins, and
 * the worst non-empty bin by |gap| (null with zero samples). Every numeric
 * field is rounded to 6 decimals — this is the artifact shape.
 */
export function calibrationReport(pairs: CalibrationPair[], binCount = DEFAULT_BIN_COUNT): CalibrationReport {
  const rawBins = reliabilityBins(pairs, binCount);
  const bins = rawBins.map((b) => ({
    lo: round6(b.lo),
    hi: round6(b.hi),
    count: b.count,
    meanPredicted: round6(b.meanPredicted),
    meanRealized: round6(b.meanRealized),
    gap: round6(b.gap),
  }));
  let worstBin: ReliabilityBin | null = null;
  for (const b of bins) {
    if (b.count === 0) continue;
    if (worstBin === null || Math.abs(b.gap) > Math.abs(worstBin.gap)) worstBin = b;
  }
  return {
    samples: pairs.length,
    brier: round6(brierScore(pairs)),
    ece: round6(expectedCalibrationError(pairs, binCount)),
    bins,
    worstBin,
  };
}
