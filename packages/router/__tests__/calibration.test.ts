// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  brierScore,
  reliabilityBins,
  expectedCalibrationError,
  calibrationReport,
  type CalibrationPair,
} from '../src/index.js';

// Perfectly calibrated fixture (binary outcomes):
//  - 5 pairs predicted 0.80, realized four 1s + one 0  → bin meanRealized 0.80, gap 0
//  - 4 pairs predicted 0.25, realized one 1 + three 0s → bin meanRealized 0.25, gap 0
// Closed-form Brier = (5·0.8·0.2 + 4·0.25·0.75) / 9 = (0.8 + 0.75) / 9 = 0.172222…
const calibrated: CalibrationPair[] = [
  { predicted: 0.8, realized: 1 },
  { predicted: 0.8, realized: 1 },
  { predicted: 0.8, realized: 1 },
  { predicted: 0.8, realized: 1 },
  { predicted: 0.8, realized: 0 },
  { predicted: 0.25, realized: 1 },
  { predicted: 0.25, realized: 0 },
  { predicted: 0.25, realized: 0 },
  { predicted: 0.25, realized: 0 },
];

// Deliberately miscalibrated fixture:
//  - 6 pairs predicted 0.9 that all failed  (bin [0.9,1.0]: gap −0.9, the worst)
//  - 4 pairs predicted 0.3 that all succeeded (bin [0.3,0.4): gap +0.7)
// ECE = (6·0.9 + 4·0.7) / 10 = 0.82;  Brier = (6·0.81 + 4·0.49) / 10 = 0.682
const miscalibrated: CalibrationPair[] = [
  ...Array.from({ length: 6 }, () => ({ predicted: 0.9, realized: 0 })),
  ...Array.from({ length: 4 }, () => ({ predicted: 0.3, realized: 1 })),
];

describe('brierScore', () => {
  it('matches the closed-form value on the calibrated fixture', () => {
    expect(brierScore(calibrated)).toBeCloseTo(1.55 / 9, 12);
  });

  it('is 0 for perfect sharp predictions and 1 for maximally wrong ones', () => {
    expect(brierScore([{ predicted: 1, realized: 1 }, { predicted: 0, realized: 0 }])).toBe(0);
    expect(brierScore([{ predicted: 1, realized: 0 }, { predicted: 0, realized: 1 }])).toBe(1);
  });

  it('rejects out-of-range inputs', () => {
    expect(() => brierScore([{ predicted: 1.5, realized: 0 }])).toThrow(RangeError);
    expect(() => brierScore([{ predicted: 0.5, realized: -0.1 }])).toThrow(RangeError);
    expect(() => brierScore([{ predicted: NaN, realized: 0 }])).toThrow(RangeError);
  });
});

describe('reliabilityBins', () => {
  it('returns all bins with correct counts, means, and gaps', () => {
    const bins = reliabilityBins(calibrated);
    expect(bins).toHaveLength(10);
    const b8 = bins[8]; // [0.8, 0.9)
    expect(b8.count).toBe(5);
    expect(b8.meanPredicted).toBeCloseTo(0.8, 12);
    expect(b8.meanRealized).toBeCloseTo(0.8, 12);
    expect(b8.gap).toBeCloseTo(0, 12);
    const b2 = bins[2]; // [0.2, 0.3)
    expect(b2.count).toBe(4);
    expect(b2.meanPredicted).toBeCloseTo(0.25, 12);
    expect(b2.meanRealized).toBeCloseTo(0.25, 12);
    // every other bin is empty
    const others = bins.filter((_, i) => i !== 8 && i !== 2);
    for (const b of others) expect(b.count).toBe(0);
  });

  it('puts predicted=1.0 into the last bin instead of overflowing', () => {
    const bins = reliabilityBins([{ predicted: 1, realized: 1 }], 4);
    expect(bins).toHaveLength(4);
    expect(bins[3].count).toBe(1);
    expect(bins[3].hi).toBe(1);
  });

  it('rejects a non-positive or fractional binCount', () => {
    expect(() => reliabilityBins(calibrated, 0)).toThrow(RangeError);
    expect(() => reliabilityBins(calibrated, 2.5)).toThrow(RangeError);
  });
});

describe('expectedCalibrationError', () => {
  it('is ~0 on the perfectly calibrated fixture', () => {
    expect(expectedCalibrationError(calibrated)).toBeCloseTo(0, 12);
  });

  it('matches the hand-computed 0.82 on the miscalibrated fixture', () => {
    expect(expectedCalibrationError(miscalibrated)).toBeCloseTo(0.82, 12);
  });
});

describe('calibrationReport', () => {
  it('reports the calibrated fixture as calibrated (round6 artifact values)', () => {
    const r = calibrationReport(calibrated);
    expect(r.samples).toBe(9);
    expect(r.brier).toBe(0.172222); // round6(1.55 / 9)
    expect(r.ece).toBe(0);
    expect(r.worstBin?.gap).toBe(0);
  });

  it('flags the miscalibrated fixture with a large ece and the correct worstBin', () => {
    const r = calibrationReport(miscalibrated);
    expect(r.samples).toBe(10);
    expect(r.brier).toBe(0.682);
    expect(r.ece).toBe(0.82);
    expect(r.worstBin).not.toBeNull();
    expect(r.worstBin!.lo).toBe(0.9);
    expect(r.worstBin!.count).toBe(6);
    expect(r.worstBin!.gap).toBe(-0.9); // overprediction: realized 0 vs predicted 0.9
  });

  it('handles empty input as a zero-sample report (defined behavior)', () => {
    const r = calibrationReport([]);
    expect(r.samples).toBe(0);
    expect(r.brier).toBe(0);
    expect(r.ece).toBe(0);
    expect(r.worstBin).toBeNull();
    expect(r.bins).toHaveLength(10);
    for (const b of r.bins) expect(b.count).toBe(0);
  });

  it('is deterministic: two runs on the same input are deep-equal', () => {
    expect(calibrationReport(miscalibrated)).toEqual(calibrationReport(miscalibrated));
    expect(calibrationReport(calibrated, 7)).toEqual(calibrationReport(calibrated, 7));
    expect(brierScore(calibrated)).toBe(brierScore(calibrated));
    expect(reliabilityBins(miscalibrated)).toEqual(reliabilityBins(miscalibrated));
  });
});
