import { describe, expect, it } from 'vitest';

import { clusteredBootstrapInterval, shuffledArms, signFlipPValue } from '../src/stats.js';

describe('paired statistics', () => {
  it('uses cluster resampling and an exact one-sided sign-flip test', () => {
    expect(clusteredBootstrapInterval({
      clusterValues: [100, 100, 100, 100, 100, 100],
      resamples: 1_000,
      confidenceLevel: 0.95,
      seed: 7,
    })).toEqual([100, 100]);
    expect(signFlipPValue({
      clusterValues: [100, 100, 100, 100, 100, 100],
      resamples: 1_000,
      seed: 7,
    })).toBe(1 / 64);
  });

  it('randomizes arm order deterministically without dropping an arm', () => {
    const arms = ['direct', 'direct-reflection', 'avo'] as const;
    expect(shuffledArms(arms, 251)).toEqual(shuffledArms(arms, 251));
    expect(new Set(shuffledArms(arms, 251))).toEqual(new Set(arms));
  });
});
