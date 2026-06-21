// SPDX-License-Identifier: MIT
//
// Oracle tests — the anti-hallucination spine. A proposal is accepted iff build +
// compliance + savings (+ utilization evidence for capacity changes) all pass. Each
// gate has a rejection test so the oracle provably refuses unsafe/non-saving patches.

import { describe, it, expect } from 'vitest';
import { verifyProposal, toVerifiedSaving } from '../src/oracle.js';
import type { OracleInput, OptimizationProposal, PolicyReport } from '../src/index.js';

const clean: PolicyReport = { passed: 5, failed: 0, failedKeys: [] };

const gp3Patch: OptimizationProposal = {
  address: 'aws_ebs_volume.data',
  kind: 'gp2-to-gp3',
  patchedTemplate: 'resource "aws_ebs_volume" "data" { type = "gp3" }',
  requiresUtilizationEvidence: false,
  rationale: 'gp3 is ~20% cheaper than gp2 at equal capacity with higher baseline IOPS',
};

const baseInput = (over: Partial<OracleInput> = {}): OracleInput => ({
  buildOk: true,
  delta: { baselineMonthlyUsd: 120, patchedMonthlyUsd: 92, diffMonthlyUsd: -28 },
  policyBefore: clean,
  policyAfter: clean,
  proposal: gp3Patch,
  ...over,
});

describe('verifyProposal — accept path', () => {
  it('accepts a build-safe, compliance-safe, cheaper patch', () => {
    const v = verifyProposal(baseInput());
    expect(v.accepted).toBe(true);
    expect(v.reasons).toContain('PASS build: terraform validate/plan ok');
    expect(v.reasons.some((r) => r.startsWith('PASS savings'))).toBe(true);
  });

  it('produces a VerifiedSaving with positive monthly savings', () => {
    const s = toVerifiedSaving(baseInput());
    expect(s.monthlySavingsUsd).toBe(28);
    expect(s.kind).toBe('gp2-to-gp3');
    expect(s.utilizationBacked).toBe(false);
  });
});

describe('verifyProposal — rejection gates', () => {
  it('rejects when the build fails', () => {
    const v = verifyProposal(baseInput({ buildOk: false }));
    expect(v.accepted).toBe(false);
    expect(v.reasons[0]).toContain('REJECT build');
  });

  it('rejects a patch that introduces a NEW compliance failure', () => {
    const v = verifyProposal(
      baseInput({ policyAfter: { passed: 4, failed: 1, failedKeys: ['CKV_AWS_8@aws_ebs_volume.data'] } }),
    );
    expect(v.accepted).toBe(false);
    expect(v.reasons.some((r) => r.includes('REJECT compliance'))).toBe(true);
  });

  it('allows a patch that FIXES a pre-existing failure (non-regression, not zero-failures)', () => {
    const v = verifyProposal(
      baseInput({
        policyBefore: { passed: 4, failed: 1, failedKeys: ['CKV_AWS_8@aws_ebs_volume.data'] },
        policyAfter: clean,
      }),
    );
    expect(v.accepted).toBe(true);
  });

  it('rejects when the modeled bill does not actually drop', () => {
    const v = verifyProposal(baseInput({ delta: { baselineMonthlyUsd: 120, patchedMonthlyUsd: 121, diffMonthlyUsd: 1 } }));
    expect(v.accepted).toBe(false);
    expect(v.reasons.some((r) => r.includes('REJECT savings'))).toBe(true);
  });

  it('rejects a sub-epsilon "saving" below minSavingsUsd', () => {
    const v = verifyProposal(
      baseInput({ delta: { baselineMonthlyUsd: 120, patchedMonthlyUsd: 119.999, diffMonthlyUsd: -0.001 } }),
      { minSavingsUsd: 0.01 },
    );
    expect(v.accepted).toBe(false);
  });
});

describe('verifyProposal — utilization evidence gate (rightsizing)', () => {
  const rightsize: OptimizationProposal = {
    address: 'aws_instance.web',
    kind: 'rightsize',
    patchedTemplate: 'resource "aws_instance" "web" { instance_type = "t3.small" }',
    requiresUtilizationEvidence: true,
    rationale: 'downsize m5.large -> t3.small',
  };
  const delta = { baselineMonthlyUsd: 120, patchedMonthlyUsd: 80, diffMonthlyUsd: -40 };

  it('rejects a rightsize with NO utilization data (never guess)', () => {
    const v = verifyProposal(baseInput({ proposal: rightsize, delta }));
    expect(v.accepted).toBe(false);
    expect(v.reasons.some((r) => r.includes('REJECT evidence'))).toBe(true);
  });

  it('rejects a rightsize when p95 CPU is too high to downsize safely', () => {
    const v = verifyProposal(
      baseInput({ proposal: rightsize, delta, utilization: { 'aws_instance.web': { address: 'aws_instance.web', windowDays: 14, cpuP95: 72 } } }),
    );
    expect(v.accepted).toBe(false);
    expect(v.reasons.some((r) => r.includes('not safe to downsize'))).toBe(true);
  });

  it('accepts a rightsize when utilization proves under-provisioning', () => {
    const v = verifyProposal(
      baseInput({ proposal: rightsize, delta, utilization: { 'aws_instance.web': { address: 'aws_instance.web', windowDays: 14, cpuP95: 12 } } }),
    );
    expect(v.accepted).toBe(true);
    const s = toVerifiedSaving(baseInput({ proposal: rightsize, delta, utilization: { 'aws_instance.web': { address: 'aws_instance.web', windowDays: 14, cpuP95: 12 } } }));
    expect(s.utilizationBacked).toBe(true);
    expect(s.monthlySavingsUsd).toBe(40);
  });
});
