// SPDX-License-Identifier: MIT
//
// Tests for pipeline.ts — the end-to-end discovery PIPELINE. Fully deterministic:
// lanes are MOCKED (no LLM, no code execution). The load-bearing properties are
//  (1) findings + cost aggregate correctly across targets;
//  (2) resume — a second run with the SAME CheckpointStore marks targets
//      resumed:true and does NOT re-invoke the lanes (proven via call counters);
//  (3) router classification picks the recorded lane;
//  (4) ledgerByKind/totals are correct and deterministic.

import { describe, it, expect } from 'vitest';
import { runDiscoveryPipeline, type PipelineTarget } from '../src/pipeline.js';
import type { CodeTarget, DiscoveryLanes } from '../src/discovery.js';
import { CheckpointStore } from '../src/checkpoints.js';
import type { TaskSignal } from '../src/router.js';

const mkTarget = (path: string): CodeTarget => ({ path, language: 'python', source: `# ${path}` });

// A spying lane factory: every injected lane bumps a shared counter so the test
// can assert exactly how many times the lanes were invoked (zero on resume).
function spyLanes(): { lanes: DiscoveryLanes; calls: { triage: number; propose: number; verify: number; cost: number } } {
  const calls = { triage: 0, propose: 0, verify: 0, cost: 0 };
  const lanes: DiscoveryLanes = {
    triage: async () => {
      calls.triage += 1;
      return [
        { fn: 'real_bug', weakness: 'CWE-369 divide-by-zero', rationale: 'unguarded /' },
        { fn: 'false_alarm', weakness: 'CWE-125 oob', rationale: 'maybe' },
      ];
    },
    propose: async (_t, c) => {
      calls.propose += 1;
      return { fn: c.fn, args: [0], expectedProblem: 'raises' };
    },
    // real_bug triggers; false_alarm does not (anti-hallucination).
    verify: (_t, p) => {
      calls.verify += 1;
      return p.fn === 'real_bug' ? { triggered: true, evidenceClass: 'ZeroDivisionError' } : { triggered: false };
    },
    cost: () => {
      calls.cost += 1;
      return 4;
    },
  };
  return { lanes, calls };
}

const cheapSignal = (id: string): TaskSignal => ({ id, sizeTokens: 100, risk: 0.1, value: 0.1, longHorizon: false });
const frontierSignal = (id: string): TaskSignal => ({ id, sizeTokens: 100, risk: 0.1, value: 0.95, longHorizon: false });

describe('runDiscoveryPipeline — aggregation', () => {
  it('aggregates verified findings and cost across targets', async () => {
    const { lanes } = spyLanes();
    const targets: PipelineTarget[] = [
      { id: 't1', target: mkTarget('a.py') },
      { id: 't2', target: mkTarget('b.py') },
    ];
    const r = await runDiscoveryPipeline(targets, lanes);

    expect(r.perTarget).toHaveLength(2);
    // Each target verifies exactly real_bug (1 finding) at cost 4.
    for (const t of r.perTarget) {
      expect(t.verified).toBe(1);
      expect(t.costUnits).toBe(4);
      expect(t.resumed).toBe(false);
      expect(t.findings.map((f) => f.fn)).toEqual(['real_bug']);
    }
    expect(r.totalVerified).toBe(2);
    expect(r.totalCostUnits).toBe(8);
    expect(r.checkpoints).toBe(2);
  });
});

describe('runDiscoveryPipeline — resume', () => {
  it('a second run with the same store marks targets resumed and does NOT re-invoke the lanes', async () => {
    const store = new CheckpointStore();
    const targets: PipelineTarget[] = [
      { id: 't1', target: mkTarget('a.py') },
      { id: 't2', target: mkTarget('b.py') },
    ];

    const first = spyLanes();
    const r1 = await runDiscoveryPipeline(targets, first.lanes, { store });
    expect(r1.perTarget.every((t) => t.resumed === false)).toBe(true);
    // First run actually invoked the lanes (2 targets → 2 triage calls).
    expect(first.calls.triage).toBe(2);
    expect(first.calls.propose).toBeGreaterThan(0);

    const second = spyLanes();
    const r2 = await runDiscoveryPipeline(targets, second.lanes, { store });
    // Every target is now served from the checkpoint.
    expect(r2.perTarget.every((t) => t.resumed === true)).toBe(true);
    // The second run NEVER touched the lanes.
    expect(second.calls).toEqual({ triage: 0, propose: 0, verify: 0, cost: 0 });

    // Resume reproduces the first run's findings/cost byte-for-byte.
    expect(r2.totalVerified).toBe(r1.totalVerified);
    expect(r2.totalCostUnits).toBe(r1.totalCostUnits);
    expect(r2.perTarget.map((t) => t.findings)).toEqual(r1.perTarget.map((t) => t.findings));
    expect(r2.checkpoints).toBe(2);
  });

  it('resumes only the already-checkpointed targets and runs the new ones', async () => {
    const store = new CheckpointStore();
    const { lanes: l1 } = spyLanes();
    await runDiscoveryPipeline([{ id: 't1', target: mkTarget('a.py') }], l1, { store });

    const second = spyLanes();
    const r = await runDiscoveryPipeline(
      [
        { id: 't1', target: mkTarget('a.py') },
        { id: 't2', target: mkTarget('b.py') },
      ],
      second.lanes,
      { store },
    );
    expect(r.perTarget.find((t) => t.id === 't1')?.resumed).toBe(true);
    expect(r.perTarget.find((t) => t.id === 't2')?.resumed).toBe(false);
    // Only the new target (t2) invoked the lanes.
    expect(second.calls.triage).toBe(1);
  });
});

describe('runDiscoveryPipeline — router classification', () => {
  it('records the lane classify() picks for each target', async () => {
    const { lanes } = spyLanes();
    const targets: PipelineTarget[] = [
      { id: 'cheap1', target: mkTarget('a.py'), signal: cheapSignal('cheap1') },
      { id: 'frontier1', target: mkTarget('b.py'), signal: frontierSignal('frontier1') },
      { id: 'nosignal', target: mkTarget('c.py') }, // no signal → defaults to cheap
    ];
    const r = await runDiscoveryPipeline(targets, lanes);
    expect(r.perTarget.find((t) => t.id === 'cheap1')?.lane).toBe('cheap');
    expect(r.perTarget.find((t) => t.id === 'frontier1')?.lane).toBe('frontier');
    expect(r.perTarget.find((t) => t.id === 'nosignal')?.lane).toBe('cheap');
  });
});

describe('runDiscoveryPipeline — ledger + determinism', () => {
  it('ledgerByKind splits cost by span kind (cheap→tool, frontier→mutation)', async () => {
    const { lanes } = spyLanes();
    const targets: PipelineTarget[] = [
      { id: 'cheap1', target: mkTarget('a.py'), signal: cheapSignal('cheap1') },
      { id: 'frontier1', target: mkTarget('b.py'), signal: frontierSignal('frontier1') },
    ];
    const r = await runDiscoveryPipeline(targets, lanes);
    // Each target costs 4: one cheap (tool) + one frontier (mutation).
    expect(r.ledgerByKind).toEqual({ tool: 4, mutation: 4 });
    expect(r.totalCostUnits).toBe(8);
  });

  it('is deterministic: same inputs → identical result', async () => {
    const targets: PipelineTarget[] = [
      { id: 't1', target: mkTarget('a.py'), signal: frontierSignal('t1') },
      { id: 't2', target: mkTarget('b.py'), signal: cheapSignal('t2') },
    ];
    const a = await runDiscoveryPipeline(targets, spyLanes().lanes);
    const b = await runDiscoveryPipeline(targets, spyLanes().lanes);
    expect(a).toEqual(b);
  });
});
