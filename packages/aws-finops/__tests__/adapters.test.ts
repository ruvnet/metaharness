// SPDX-License-Identifier: MIT
//
// Adapter tests: infracost & checkov JSON → normalized reports. Uses fixtures that
// mirror the real tool shapes (classic infracost breakdown/diff; checkov results
// object). Pure parsing — no binaries.

import { describe, it, expect } from 'vitest';
import { parseCostReport, costDelta } from '../src/infracost-adapter.js';
import { parsePolicyReport, newFailures } from '../src/checkov-adapter.js';

// Classic infracost breakdown shape (totals as strings, resources under projects).
const baselineJson = {
  currency: 'USD',
  totalMonthlyCost: '120.00',
  projects: [
    {
      breakdown: {
        resources: [
          { name: 'aws_ebs_volume.data', resourceType: 'aws_ebs_volume', monthlyCost: '80.00' },
          { name: 'aws_instance.web', resourceType: 'aws_instance', monthlyCost: '40.00' },
        ],
      },
    },
  ],
};
const patchedJson = {
  currency: 'USD',
  totalMonthlyCost: '92.00', // gp2->gp3 dropped the volume from 80 to 52
  projects: [
    {
      breakdown: {
        resources: [
          { name: 'aws_ebs_volume.data', resourceType: 'aws_ebs_volume', monthlyCost: '52.00' },
          { name: 'aws_instance.web', resourceType: 'aws_instance', monthlyCost: '40.00' },
        ],
      },
    },
  ],
};

describe('infracost adapter', () => {
  it('parses classic breakdown totals and resources', () => {
    const r = parseCostReport(baselineJson);
    expect(r.totalMonthlyUsd).toBe(120);
    expect(r.currency).toBe('USD');
    expect(r.resources).toHaveLength(2);
    expect(r.resources[0]).toEqual({ address: 'aws_ebs_volume.data', resourceType: 'aws_ebs_volume', monthlyUsd: 80 });
  });

  it('sums resources when no explicit total is present', () => {
    const r = parseCostReport({ projects: [{ breakdown: { resources: [{ name: 'a.b', monthlyCost: 3 }, { name: 'c.d', monthlyCost: 4 }] } }] });
    expect(r.totalMonthlyUsd).toBe(7);
  });

  it('parses the modern scan --json shape (monthly_cost)', () => {
    const r = parseCostReport({ monthly_cost: 742.64, monthly_savings: 187.12, failing_policies: 3 });
    expect(r.totalMonthlyUsd).toBe(742.64);
  });

  it('computes a negative delta when the patch is cheaper', () => {
    const d = costDelta(parseCostReport(baselineJson), parseCostReport(patchedJson));
    expect(d.diffMonthlyUsd).toBe(-28);
    expect(d.baselineMonthlyUsd).toBe(120);
    expect(d.patchedMonthlyUsd).toBe(92);
  });

  it('prefers a native diffTotalMonthlyCost when supplied', () => {
    const d = costDelta(parseCostReport(baselineJson), parseCostReport(patchedJson), { diffTotalMonthlyCost: '-28.00' });
    expect(d.diffMonthlyUsd).toBe(-28);
  });

  it('degrades to zero on garbage rather than throwing', () => {
    expect(parseCostReport(null).totalMonthlyUsd).toBe(0);
    expect(parseCostReport({ totalMonthlyCost: 'not-a-number' }).totalMonthlyUsd).toBe(0);
  });
});

// checkov results shape.
const mkCheckov = (passed: Array<[string, string]>, failed: Array<[string, string]>) => ({
  results: {
    passed_checks: passed.map(([check_id, resource]) => ({ check_id, resource })),
    failed_checks: failed.map(([check_id, resource]) => ({ check_id, resource })),
  },
});

describe('checkov adapter', () => {
  it('parses passed/failed counts and stable failed keys', () => {
    const r = parsePolicyReport(mkCheckov([['CKV_AWS_1', 'aws_s3_bucket.a']], [['CKV_AWS_79', 'aws_instance.web']]));
    expect(r.passed).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.failedKeys).toEqual(['CKV_AWS_79@aws_instance.web']);
  });

  it('handles the array-of-reports form (multi-framework)', () => {
    const r = parsePolicyReport([
      mkCheckov([['CKV_AWS_1', 'a']], []),
      mkCheckov([], [['CKV_AWS_2', 'b']]),
    ]);
    expect(r.passed).toBe(1);
    expect(r.failed).toBe(1);
  });

  it('newFailures detects only NEW failures introduced by the patch', () => {
    const before = parsePolicyReport(mkCheckov([], [['CKV_AWS_79', 'aws_instance.web']]));
    // patch fixed the old failure but introduced a new one elsewhere
    const after = parsePolicyReport(mkCheckov([], [['CKV_AWS_8', 'aws_ebs_volume.data']]));
    expect(newFailures(before, after)).toEqual(['CKV_AWS_8@aws_ebs_volume.data']);
  });

  it('newFailures is empty when the patch only fixes or preserves failures', () => {
    const before = parsePolicyReport(mkCheckov([], [['CKV_AWS_79', 'r1'], ['CKV_AWS_8', 'r2']]));
    const after = parsePolicyReport(mkCheckov([], [['CKV_AWS_8', 'r2']]));
    expect(newFailures(before, after)).toEqual([]);
  });
});
