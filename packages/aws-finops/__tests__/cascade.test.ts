// SPDX-License-Identifier: MIT
//
// Cascade tests — the cheap→frontier→oracle orchestration, with injected lanes so
// the whole pipeline is deterministic and binary-free. Models the real escalation:
// the cheap proposer fixes the easy hotspot; the hard one only succeeds on the
// frontier escalation; a third hotspot is triaged away.

import { describe, it, expect } from 'vitest';
import { runCascade } from '../src/cascade.js';
import type { CascadeLanes, Hotspot } from '../src/cascade.js';
import type { CostReport, OptimizationProposal, VerifiedSaving } from '../src/index.js';

const baseline: CostReport = {
  totalMonthlyUsd: 200,
  currency: 'USD',
  resources: [
    { address: 'aws_ebs_volume.data', resourceType: 'aws_ebs_volume', monthlyUsd: 80 },
    { address: 'aws_db_instance.main', resourceType: 'aws_db_instance', monthlyUsd: 100 },
    { address: 'aws_s3_bucket.logs', resourceType: 'aws_s3_bucket', monthlyUsd: 20 },
  ],
};

const hotspots: Hotspot[] = [
  { address: 'aws_ebs_volume.data', kind: 'gp2-to-gp3', monthlyUsd: 80 },
  { address: 'aws_db_instance.main', kind: 'rightsize', monthlyUsd: 100 },
  { address: 'aws_s3_bucket.logs', kind: 'noise', monthlyUsd: 20 },
];

const mkProposal = (h: Hotspot): OptimizationProposal => ({
  address: h.address,
  kind: h.kind,
  patchedTemplate: `# patched ${h.address}`,
  requiresUtilizationEvidence: h.kind === 'rightsize',
  rationale: `optimize ${h.address}`,
});
const mkSaving = (h: Hotspot, usd: number): VerifiedSaving => ({
  address: h.address,
  kind: h.kind,
  monthlySavingsUsd: usd,
  rationale: 'r',
  utilizationBacked: h.kind === 'rightsize',
});

// Lanes: triage drops "noise"; cheap proposer only solves gp2-to-gp3; the rightsize
// needs the frontier proposer. Costs are tiny (the $0.04 economics).
const lanes: CascadeLanes = {
  triage: async (h) => ({ keep: h.kind !== 'noise', costUsd: 0.00001 }),
  propose: async (h, tier) => {
    if (h.kind === 'gp2-to-gp3') return { proposal: mkProposal(h), costUsd: tier === 'cheap' ? 0.00002 : 0.0002 };
    if (h.kind === 'rightsize') {
      // cheap proposer fails to produce a viable patch; frontier succeeds.
      return { proposal: tier === 'frontier' ? mkProposal(h) : null, costUsd: tier === 'cheap' ? 0.00002 : 0.0002 };
    }
    return { proposal: null, costUsd: 0 };
  },
  verify: async (p) => {
    const usd = p.kind === 'gp2-to-gp3' ? 28 : p.kind === 'rightsize' ? 40 : 0;
    if (usd <= 0) return { verdict: { accepted: false, reasons: ['no savings'] }, saving: null };
    const h = hotspots.find((x) => x.address === p.address)!;
    return { verdict: { accepted: true, reasons: ['PASS'] }, saving: mkSaving(h, usd) };
  },
};

describe('runCascade', () => {
  it('verifies savings on real hotspots, escalating only when the cheap lane fails', async () => {
    const r = await runCascade(baseline, hotspots, lanes);
    expect(r.verified.map((v) => v.address).sort()).toEqual(['aws_db_instance.main', 'aws_ebs_volume.data']);
    // gp2->gp3 landed on the cheap lane (not escalated); rightsize required frontier.
    const ebs = r.trace.find((t) => t.address === 'aws_ebs_volume.data')!;
    const db = r.trace.find((t) => t.address === 'aws_db_instance.main')!;
    const s3 = r.trace.find((t) => t.address === 'aws_s3_bucket.logs')!;
    expect(ebs.escalated).toBe(false);
    expect(db.escalated).toBe(true);
    expect(s3.kept).toBe(false);
  });

  it('processes hotspots highest-cost-first', async () => {
    const r = await runCascade(baseline, hotspots, lanes);
    expect(r.trace[0].address).toBe('aws_db_instance.main'); // $100 first
  });

  it('shrinks the residual by the verified savings', async () => {
    const r = await runCascade(baseline, hotspots, lanes);
    expect(r.residual.realizedSavingsUsd).toBe(68); // 28 + 40
    expect(r.residual.residualMonthlyUsd).toBe(132); // 200 - 68
  });

  it('reports cost-per-verified-dollar in the right (tiny) order of magnitude', async () => {
    const r = await runCascade(baseline, hotspots, lanes);
    // total LLM spend is fractions of a cent vs $68/mo saved → << 0.01
    expect(r.costPerVerifiedDollar).toBeLessThan(0.001);
    expect(r.llmCostUsd).toBeGreaterThan(0);
  });

  it('without escalation, the rightsize is not recovered', async () => {
    const r = await runCascade(baseline, hotspots, lanes, { escalateOnFail: false });
    expect(r.verified.map((v) => v.address)).toEqual(['aws_ebs_volume.data']);
  });

  it('is deterministic across runs', async () => {
    const a = await runCascade(baseline, hotspots, lanes);
    const b = await runCascade(baseline, hotspots, lanes);
    expect(a.verified).toEqual(b.verified);
    expect(a.residual).toEqual(b.residual);
  });
});
