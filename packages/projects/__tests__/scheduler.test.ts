// SPDX-License-Identifier: MIT
//
// Tests for scheduler.ts (ADR-160 Escalation Scheduler): budget caps, bounded
// retries (no infinite loops), security fail-closed, the happy path, and the
// guarantee that every run returns a valid typed TerminationReason.

import { describe, it, expect } from 'vitest';
import {
  EscalationScheduler,
  defaultSchedulerPolicy,
  type SchedNode,
  type NodeResult,
  type TerminationReason,
} from '../src/scheduler.js';

const REASONS: TerminationReason[] = [
  'success',
  'budget_exhausted',
  'max_retries',
  'max_escalations',
  'max_reviewer_passes',
  'context_overflow',
  'security_uncertain',
];

/** A node that returns a fixed result on every attempt. */
function fixedNode(id: string, res: NodeResult): SchedNode {
  return { id, run: () => res };
}

describe('scheduler budget cap', () => {
  it('terminates with budget_exhausted and overshoots by at most one node cost', () => {
    const policy = { ...defaultSchedulerPolicy(), costBudget: 10, maxRetriesPerNode: 1 };
    const sched = new EscalationScheduler(policy);
    // Five ok nodes each costing 4 → cumulative 4,8,12... crosses 10 at node 3.
    const nodes = Array.from({ length: 5 }, (_, i) =>
      fixedNode(`n${i}`, { ok: true, costUnits: 4, timeUnits: 0 }),
    );
    const out = sched.run(nodes);
    expect(out.reason).toBe('budget_exhausted');
    // Never exceeds budget by more than one node's cost (4).
    expect(out.costUnits).toBeLessThanOrEqual(policy.costBudget + 4);
  });
});

describe('scheduler bounded retries', () => {
  it('an always-failing node terminates with max_retries after exactly maxRetriesPerNode attempts', () => {
    const policy = { ...defaultSchedulerPolicy(), maxRetriesPerNode: 3 };
    const sched = new EscalationScheduler(policy);
    let calls = 0;
    const node: SchedNode = {
      id: 'flaky',
      run: () => {
        calls += 1;
        return { ok: false, costUnits: 0.1, timeUnits: 0.1 };
      },
    };
    const out = sched.run([node]);
    expect(out.reason).toBe('max_retries');
    expect(calls).toBe(3);
    expect(out.perNode[0]).toEqual({ id: 'flaky', attempts: 3, ok: false });
  });

  it('does not loop forever even with zero-cost failing nodes', () => {
    const sched = new EscalationScheduler({ ...defaultSchedulerPolicy(), maxRetriesPerNode: 2 });
    const node = fixedNode('z', { ok: false, costUnits: 0, timeUnits: 0 });
    const out = sched.run([node]);
    expect(out.reason).toBe('max_retries');
    expect(out.steps).toBe(2);
  });
});

describe('scheduler security fail-closed', () => {
  it('terminates immediately with security_uncertain', () => {
    const sched = new EscalationScheduler(defaultSchedulerPolicy());
    const nodes = [
      fixedNode('a', { ok: true, costUnits: 1, timeUnits: 1 }),
      fixedNode('b', { ok: false, costUnits: 1, timeUnits: 1, securityUncertain: true }),
      fixedNode('c', { ok: true, costUnits: 1, timeUnits: 1 }),
    ];
    const out = sched.run(nodes);
    expect(out.reason).toBe('security_uncertain');
    // Node c never ran.
    expect(out.perNode.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('does NOT fail closed when the policy disables it', () => {
    const sched = new EscalationScheduler({
      ...defaultSchedulerPolicy(),
      failClosedOnSecurityUncertainty: false,
    });
    const out = sched.run([
      fixedNode('a', { ok: true, costUnits: 1, timeUnits: 1, securityUncertain: true }),
    ]);
    expect(out.reason).toBe('success');
  });
});

describe('scheduler happy path', () => {
  it('all-ok nodes within budget yield success', () => {
    const sched = new EscalationScheduler(defaultSchedulerPolicy());
    const nodes = Array.from({ length: 4 }, (_, i) =>
      fixedNode(`n${i}`, { ok: true, costUnits: 1, timeUnits: 0.5 }),
    );
    const out = sched.run(nodes);
    expect(out.reason).toBe('success');
    expect(out.perNode.every((p) => p.ok)).toBe(true);
  });
});

describe('scheduler escalation + context bounds', () => {
  it('too many escalations terminate with max_escalations', () => {
    const sched = new EscalationScheduler({ ...defaultSchedulerPolicy(), maxFrontierEscalations: 1 });
    const nodes = [
      fixedNode('a', { ok: true, costUnits: 1, timeUnits: 0, escalate: true }),
      fixedNode('b', { ok: true, costUnits: 1, timeUnits: 0, escalate: true }),
    ];
    const out = sched.run(nodes);
    expect(out.reason).toBe('max_escalations');
    expect(out.escalations).toBe(2);
  });

  it('context growth past the ratio terminates with context_overflow', () => {
    const sched = new EscalationScheduler({ ...defaultSchedulerPolicy(), maxContextGrowthRatio: 2 });
    const out = sched.run([fixedNode('a', { ok: true, costUnits: 1, timeUnits: 0, contextGrowth: 3 })]);
    expect(out.reason).toBe('context_overflow');
  });
});

describe('scheduler termination invariant', () => {
  it('every run returns a valid TerminationReason', () => {
    const scenarios: SchedNode[][] = [
      [],
      [fixedNode('ok', { ok: true, costUnits: 1, timeUnits: 1 })],
      [fixedNode('fail', { ok: false, costUnits: 1, timeUnits: 1 })],
      [fixedNode('sec', { ok: false, costUnits: 1, timeUnits: 1, securityUncertain: true })],
      [fixedNode('big', { ok: true, costUnits: 1000, timeUnits: 1 })],
    ];
    for (const nodes of scenarios) {
      const out = new EscalationScheduler(defaultSchedulerPolicy()).run(nodes);
      expect(REASONS).toContain(out.reason);
    }
  });
});

describe('scheduler reviewer-pass cap (typed reason)', () => {
  it('exceeding maxReviewerPasses terminates with the distinct max_reviewer_passes reason', () => {
    const sched = new EscalationScheduler({ ...defaultSchedulerPolicy(), maxReviewerPasses: 2 });
    const nodes = ['review-1', 'review-2', 'review-3'].map((id) =>
      fixedNode(id, { ok: true, costUnits: 1, timeUnits: 0 }),
    );
    const out = sched.run(nodes);
    expect(out.reason).toBe('max_reviewer_passes'); // not conflated with max_escalations
  });
});

describe('scheduler precedence at a collision point', () => {
  it('security uncertainty beats a simultaneous budget breach', () => {
    const sched = new EscalationScheduler({ ...defaultSchedulerPolicy(), costBudget: 5 });
    // One node blows the budget AND reports security uncertainty in the same attempt.
    const out = sched.run([fixedNode('x', { ok: false, costUnits: 1000, timeUnits: 0, securityUncertain: true })]);
    expect(out.reason).toBe('security_uncertain');
  });
});

describe('scheduler retry-budget floor', () => {
  it('maxRetriesPerNode=0 still gives a node at least one attempt (not a 0-attempt max_retries)', () => {
    const sched = new EscalationScheduler({ ...defaultSchedulerPolicy(), maxRetriesPerNode: 0 });
    const out = sched.run([fixedNode('f', { ok: false, costUnits: 1, timeUnits: 0 })]);
    expect(out.reason).toBe('max_retries');
    expect(out.perNode[0].attempts).toBe(1); // invoked once, not zero
  });
});
