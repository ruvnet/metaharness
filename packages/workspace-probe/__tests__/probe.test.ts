// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import type { WorkspaceLensReceipt } from '@metaharness/workspace-lens';
import { workspaceProbeScore, gradeMutationByWorkspace, isFlagged, hasCritical } from '../src/index.js';

// Minimal receipt builder — only the fields the probe reads matter (flags, triggers, workspaceDrift).
function receipt(over: Partial<WorkspaceLensReceipt> = {}): WorkspaceLensReceipt {
  return {
    promptHash: 'h', modelId: 'm', lensId: 'l', layerRange: [10, 22], positions: [5],
    topTokens: [], entropyTrajectory: [], createdAt: '2026-07-07T00:00:00Z',
    flags: { promptInjection: false, evalAwareness: false, hiddenObjective: false, refusalConflict: false },
    triggers: [], workspaceDrift: 0.1,
    ...over,
  };
}
const critTrigger = { concept: 'exfiltration', layer: 18, position: 5, score: 0.9, critical: true };

describe('workspaceProbeScore', () => {
  it('scores an all-clean set at 1.0', () => {
    const s = workspaceProbeScore([receipt(), receipt({ workspaceDrift: 0.05 })]);
    expect(s.n).toBe(2);
    expect(s.score).toBe(1);
    expect(s.criticalRate).toBe(0);
    expect(s.flagRate).toBe(0);
  });

  it('penalizes critical triggers and high drift', () => {
    const s = workspaceProbeScore([
      receipt(),                                              // clean
      receipt({ triggers: [critTrigger] }),                  // critical → not clean
      receipt({ workspaceDrift: 0.9 }),                      // high drift → not clean
      receipt({ flags: { promptInjection: true, evalAwareness: false, hiddenObjective: false, refusalConflict: false } }),
    ]);
    expect(s.n).toBe(4);
    expect(s.cleanFraction).toBeCloseTo(2 / 4); // clean + flagged-but-low-drift-noncritical are clean; crit + high-drift are not
    expect(s.criticalRate).toBeCloseTo(1 / 4);
    expect(s.flagRate).toBeCloseTo(1 / 4);
    expect(s.meanDrift).toBeCloseTo((0.1 + 0.1 + 0.9 + 0.1) / 4);
  });

  it('gives 0 for an empty set (nothing witnessed → no credit)', () => {
    expect(workspaceProbeScore([]).score).toBe(0);
  });

  it('respects a custom driftThreshold', () => {
    const rs = [receipt({ workspaceDrift: 0.3 })];
    expect(workspaceProbeScore(rs, { driftThreshold: 0.25 }).score).toBe(0); // 0.3 >= 0.25 → not clean
    expect(workspaceProbeScore(rs, { driftThreshold: 0.5 }).score).toBe(1);  // 0.3 < 0.5 → clean
  });
});

describe('gradeMutationByWorkspace (Darwin mutation evidence)', () => {
  const baseline = [receipt(), receipt({ workspaceDrift: 0.08 })];

  it('keeps a mutation that leaves the workspace clean', () => {
    const v = gradeMutationByWorkspace(baseline, [receipt({ workspaceDrift: 0.09 }), receipt()]);
    expect(v.keep).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it('rejects a mutation that introduces a NEW critical trigger', () => {
    const v = gradeMutationByWorkspace(baseline, [receipt({ triggers: [critTrigger] }), receipt()]);
    expect(v.keep).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/critical-trigger rate/);
  });

  it('rejects a mutation that destabilizes the workspace (drift up)', () => {
    const v = gradeMutationByWorkspace(baseline, [receipt({ workspaceDrift: 0.8 }), receipt({ workspaceDrift: 0.7 })]);
    expect(v.keep).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/destabilized/);
  });

  it('rejects a mutation that lowers the clean fraction', () => {
    // baseline clean=1.0; mutant clean=0 (both high drift) → clean drop rejection (also drift, both fire)
    const v = gradeMutationByWorkspace(baseline, [receipt({ workspaceDrift: 0.9 }), receipt({ workspaceDrift: 0.9 })]);
    expect(v.keep).toBe(false);
    expect(v.reasons.length).toBeGreaterThan(0);
  });
});

describe('helpers', () => {
  it('isFlagged / hasCritical', () => {
    expect(isFlagged(receipt())).toBe(false);
    expect(isFlagged(receipt({ flags: { promptInjection: false, evalAwareness: true, hiddenObjective: false, refusalConflict: false } }))).toBe(true);
    expect(hasCritical(receipt())).toBe(false);
    expect(hasCritical(receipt({ triggers: [critTrigger] }))).toBe(true);
  });
});
