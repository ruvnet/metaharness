// SPDX-License-Identifier: MIT
//
// Tests for discovery.ts — the defensive zero-day discovery harness. Fully
// deterministic: lanes are mocked, no LLM, no code execution. The load-bearing
// property is that ONLY execution-verified findings are reported — an LLM
// hypothesis whose proof does not actually trigger is dropped (no hallucinated
// findings).

import { describe, it, expect, vi } from 'vitest';
import { runDiscovery, severityOf, type CodeTarget, type DiscoveryLanes } from '../src/discovery.js';

const target: CodeTarget = { path: 'x.py', language: 'python', source: 'def f(): pass' };

function lanes(over: Partial<DiscoveryLanes> = {}): DiscoveryLanes {
  return {
    triage: async () => [
      { fn: 'real_bug', weakness: 'CWE-369 divide-by-zero', rationale: 'unguarded /' },
      { fn: 'false_alarm', weakness: 'CWE-125 oob', rationale: 'maybe' },
    ],
    propose: async (_t, c) => ({ fn: c.fn, args: [0], expectedProblem: 'raises' }),
    // real_bug's proof triggers; false_alarm's proof does NOT (the anti-hallucination case).
    verify: (_t, p) => (p.fn === 'real_bug' ? { triggered: true, evidenceClass: 'ZeroDivisionError' } : { triggered: false }),
    cost: () => 4,
    ...over,
  };
}

describe('runDiscovery — verification spine', () => {
  it('reports only execution-verified findings (drops unproven hypotheses)', async () => {
    const r = await runDiscovery(target, lanes());
    expect(r.candidates).toBe(2);
    expect(r.proposed).toBe(2);
    expect(r.verified).toBe(1); // only real_bug confirmed
    expect(r.findings.map((f) => f.fn)).toEqual(['real_bug']);
    expect(r.findings[0]).toMatchObject({ source: 'runtime', verified: true, evidenceClass: 'ZeroDivisionError', proofArgsRedacted: true });
  });

  it('ranks a bare TypeError below genuine edge-case faults (severity heuristic)', async () => {
    expect(severityOf('TypeError')).toBe('low'); // "wrong type" — trivially reachable
    expect(severityOf('AttributeError')).toBe('low');
    expect(severityOf('ZeroDivisionError')).toBe('medium');
    expect(severityOf('IndexError')).toBe('medium');
    const r = await runDiscovery(target, lanes()); // real_bug → ZeroDivisionError
    expect(r.findings[0].severity).toBe('medium');
  });

  it('never emits the proof input (defensive: redacted, only the exception class)', async () => {
    const r = await runDiscovery(target, lanes());
    const f = r.findings[0];
    expect(f).not.toHaveProperty('args');
    expect(f.proofArgsRedacted).toBe(true);
  });

  it('includes tool-verified static findings as a separate channel', async () => {
    const r = await runDiscovery(target, lanes({
      staticScan: () => [{ fn: 'uses_eval', weakness: 'CWE-94 eval', source: 'static', verified: true }],
    }));
    expect(r.findings.some((f) => f.source === 'static' && f.fn === 'uses_eval')).toBe(true);
    expect(r.findings.some((f) => f.source === 'runtime' && f.fn === 'real_bug')).toBe(true);
  });

  it('computes cost per VERIFIED finding (the product metric)', async () => {
    const r = await runDiscovery(target, lanes({ cost: () => 10 }));
    expect(r.costPerVerifiedFinding).toBe(10); // 10 cost / 1 verified
  });

  it('null cost-per-finding when nothing is verified', async () => {
    const r = await runDiscovery(target, lanes({ verify: () => ({ triggered: false }) }));
    expect(r.verified).toBe(0);
    expect(r.costPerVerifiedFinding).toBeNull();
  });

  it('respects the escalation cap (cost guard) — frontier not called past the cap', async () => {
    const propose = vi.fn(async (_t, c) => ({ fn: c.fn, args: [0], expectedProblem: 'x' }));
    const r = await runDiscovery(target, lanes({ propose }), { maxEscalations: 1 });
    expect(propose).toHaveBeenCalledTimes(1);
    expect(r.proposed).toBe(1);
  });

  it('de-duplicates findings by (source, fn, weakness)', async () => {
    const r = await runDiscovery(target, lanes({
      triage: async () => [
        { fn: 'real_bug', weakness: 'CWE-369 divide-by-zero', rationale: 'a' },
        { fn: 'real_bug', weakness: 'CWE-369 divide-by-zero', rationale: 'dup' },
      ],
    }));
    expect(r.findings.filter((f) => f.fn === 'real_bug')).toHaveLength(1);
  });
});

describe('runDiscovery — skipStaticallyCovered (opt-in)', () => {
  it('skips the frontier call for a candidate whose fn is already a static finding', async () => {
    const propose = vi.fn(async (_t: CodeTarget, c: { fn: string }) => ({ fn: c.fn, args: [0], expectedProblem: 'x' }));
    const r = await runDiscovery(
      target,
      lanes({
        // static channel already verified `real_bug`; triage also flags it + false_alarm.
        staticScan: () => [{ fn: 'real_bug', weakness: 'CWE-369 divide-by-zero', source: 'static', verified: true }],
        propose,
      }),
      { skipStaticallyCovered: true },
    );
    // propose must NOT be called for the statically-covered `real_bug`; only `false_alarm`.
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose).toHaveBeenCalledWith(target, expect.objectContaining({ fn: 'false_alarm' }));
    expect(r.skipped).toBe(1);
    // the static finding still appears.
    expect(r.findings.some((f) => f.source === 'static' && f.fn === 'real_bug')).toBe(true);
  });

  it('does NOT skip anything by default (skipStaticallyCovered defaults to false)', async () => {
    const propose = vi.fn(async (_t: CodeTarget, c: { fn: string }) => ({ fn: c.fn, args: [0], expectedProblem: 'x' }));
    const r = await runDiscovery(
      target,
      lanes({
        staticScan: () => [{ fn: 'real_bug', weakness: 'CWE-369 divide-by-zero', source: 'static', verified: true }],
        propose,
      }),
    );
    // both triage candidates escalated even though one is statically covered.
    expect(propose).toHaveBeenCalledTimes(2);
    expect(r.skipped).toBe(0);
  });
});

describe('runDiscovery — deterministic concurrency', () => {
  // Triage emits many candidates that all verify, so ordering is observable.
  const many = async () =>
    Array.from({ length: 10 }, (_v, i) => ({
      fn: `bug_${i}`,
      weakness: 'CWE-369 divide-by-zero',
      rationale: `r${i}`,
    }));

  // propose resolves after a pseudo-random (but seeded) delay to scramble completion order.
  const jittered = (): DiscoveryLanes['propose'] => {
    let n = 0;
    return async (_t, c) => {
      const delay = (n++ * 7) % 5; // varying micro-delays
      await new Promise((res) => setTimeout(res, delay));
      return { fn: c.fn, args: [0], expectedProblem: 'x' };
    };
  };

  it('produces identical findings ordering across runs despite async completion timing', async () => {
    const makeLanes = () => lanes({ triage: many, propose: jittered(), verify: () => ({ triggered: true, evidenceClass: 'E' }) });
    const r1 = await runDiscovery(target, makeLanes(), { concurrency: 4 });
    const r2 = await runDiscovery(target, makeLanes(), { concurrency: 4 });
    const order = Array.from({ length: 10 }, (_v, i) => `bug_${i}`);
    expect(r1.findings.map((f) => f.fn)).toEqual(order);
    expect(r2.findings.map((f) => f.fn)).toEqual(r1.findings.map((f) => f.fn));
    expect(r1.proposed).toBe(10);
  });

  it('respects maxEscalations in candidate order under concurrency', async () => {
    const r = await runDiscovery(
      target,
      lanes({ triage: many, propose: jittered(), verify: () => ({ triggered: true, evidenceClass: 'E' }) }),
      { concurrency: 4, maxEscalations: 3 },
    );
    expect(r.proposed).toBe(3);
    expect(r.findings.map((f) => f.fn)).toEqual(['bug_0', 'bug_1', 'bug_2']);
  });
});
