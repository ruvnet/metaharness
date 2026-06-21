// SPDX-License-Identifier: MIT
//
// Residual tests — the shrinking modeled bill. Each verified saving shrinks the
// residual; convergence fires when nothing remains or no progress was made.

import { describe, it, expect } from 'vitest';
import { computeResidual, residualConverged } from '../src/residual.js';
import type { CostReport, VerifiedSaving } from '../src/index.js';

const baseline: CostReport = {
  totalMonthlyUsd: 120,
  currency: 'USD',
  resources: [
    { address: 'aws_ebs_volume.data', resourceType: 'aws_ebs_volume', monthlyUsd: 80 },
    { address: 'aws_instance.web', resourceType: 'aws_instance', monthlyUsd: 40 },
  ],
};

const saving = (address: string, usd: number): VerifiedSaving => ({
  address,
  kind: 'x',
  monthlySavingsUsd: usd,
  rationale: 'r',
  utilizationBacked: false,
});

describe('computeResidual', () => {
  it('shrinks the bill by the verified savings and lists what remains', () => {
    const r = computeResidual(baseline, [saving('aws_ebs_volume.data', 28)]);
    expect(r.baselineMonthlyUsd).toBe(120);
    expect(r.realizedSavingsUsd).toBe(28);
    expect(r.residualMonthlyUsd).toBe(92);
    expect(r.savingsRatio).toBe(round6(28 / 120));
    expect(r.unoptimizedAddresses).toEqual(['aws_instance.web']);
  });

  it('clamps savings to the baseline (cannot save more than the bill)', () => {
    const r = computeResidual(baseline, [saving('aws_ebs_volume.data', 999)]);
    expect(r.realizedSavingsUsd).toBe(120);
    expect(r.residualMonthlyUsd).toBe(0);
  });

  it('reports an empty residual set when every resource is optimized', () => {
    const r = computeResidual(baseline, [saving('aws_ebs_volume.data', 28), saving('aws_instance.web', 10)]);
    expect(r.unoptimizedAddresses).toEqual([]);
    expect(r.residualMonthlyUsd).toBe(82);
  });

  it('handles a zero-cost baseline without dividing by zero', () => {
    const r = computeResidual({ totalMonthlyUsd: 0, currency: 'USD', resources: [] }, []);
    expect(r.savingsRatio).toBe(0);
    expect(r.residualMonthlyUsd).toBe(0);
  });
});

describe('residualConverged', () => {
  it('converges when nothing is left to optimize', () => {
    const r = computeResidual(baseline, [saving('aws_ebs_volume.data', 28), saving('aws_instance.web', 10)]);
    expect(residualConverged(null, r)).toBe(true);
  });

  it('does not converge on the first generation with work remaining', () => {
    const r = computeResidual(baseline, [saving('aws_ebs_volume.data', 28)]);
    expect(residualConverged(null, r)).toBe(false);
  });

  it('converges when a generation makes no new progress', () => {
    const prev = computeResidual(baseline, [saving('aws_ebs_volume.data', 28)]);
    const next = computeResidual(baseline, [saving('aws_ebs_volume.data', 28)]); // same savings
    expect(residualConverged(prev, next)).toBe(true);
  });

  it('keeps going when a generation lands more savings (work still remaining)', () => {
    // 3-resource baseline so two savings still leave one resource unoptimized.
    const big: CostReport = {
      totalMonthlyUsd: 160,
      currency: 'USD',
      resources: [
        ...baseline.resources,
        { address: 'aws_db_instance.main', resourceType: 'aws_db_instance', monthlyUsd: 40 },
      ],
    };
    const prev = computeResidual(big, [saving('aws_ebs_volume.data', 28)]);
    const next = computeResidual(big, [saving('aws_ebs_volume.data', 28), saving('aws_instance.web', 5)]);
    expect(next.unoptimizedAddresses).toEqual(['aws_db_instance.main']);
    expect(residualConverged(prev, next)).toBe(false);
  });
});

// local copy of round6 for the ratio assertion (kept tiny to avoid import churn)
function round6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}
