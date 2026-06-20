// SPDX-License-Identifier: MIT
//
// Tests for handoffs.ts (ADR-163 Typed Handoffs): schema validation of a hop's
// input/output pair, immediate rejection of a schema-invalid output BEFORE
// proceeding, the typed-vs-free-form retry A/B, and the locked, high-risk
// defensive terminal hop (Security→Disclosure).

import { describe, it, expect } from 'vitest';
import {
  validateHandoff,
  defaultChain,
  HandoffChain,
  simulateRetries,
  type HandoffContract,
  type HandoffExecutor,
} from '../src/handoffs.js';

const contract: HandoffContract = {
  from: 'A',
  to: 'B',
  inputSchema: [
    { name: 'task', type: 'string', required: true },
    { name: 'opts', type: 'object', required: false },
  ],
  outputSchema: [
    { name: 'plan', type: 'array', required: true },
    { name: 'ok', type: 'boolean', required: true },
  ],
  riskLevel: 'low',
  allowedTools: ['read'],
  budgetCostUnits: 4,
  escalationThreshold: 0.7,
};

describe('validateHandoff', () => {
  it('accepts a valid input/output pair (extra fields allowed, optional may be absent)', () => {
    const r = validateHandoff(
      contract,
      { task: 'do', extra: 123 },
      { plan: ['a', 'b'], ok: true, note: 'x' },
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects a missing required field and a wrong-typed field, reporting all errors', () => {
    const r = validateHandoff(
      contract,
      {}, // missing required `task`
      { plan: 'not-an-array', ok: true }, // `plan` should be array
    );
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBe(2);
    expect(r.errors.some((e) => e.includes("missing required field 'task'"))).toBe(true);
    expect(r.errors.some((e) => e.includes("'plan' expected array but got string"))).toBe(true);
  });
});

describe('HandoffChain', () => {
  it('rejects a hop whose output is schema-invalid BEFORE proceeding (no retry on schema failure)', () => {
    const chain = new HandoffChain([contract]);
    let calls = 0;
    const executors: Record<string, HandoffExecutor> = {
      B: () => {
        calls += 1;
        // Returns ok=true but a schema-invalid output (plan is a string).
        return { output: { plan: 'oops', ok: true }, ok: true };
      },
    };
    const res = chain.run({ task: 'go' }, executors, { maxRetriesPerHop: 3 });
    expect(res.completed).toBe(false);
    expect(res.terminatedAt).toBe('B');
    expect(res.rejectedReason).toContain("'plan' expected array");
    expect(res.retries).toBe(0); // schema failure is NOT retried
    expect(calls).toBe(1); // executor ran exactly once
  });

  it('completes a valid chain end-to-end', () => {
    const chain = new HandoffChain([contract]);
    const executors: Record<string, HandoffExecutor> = {
      B: () => ({ output: { plan: ['x'], ok: true }, ok: true }),
    };
    const res = chain.run({ task: 'go' }, executors);
    expect(res.completed).toBe(true);
    expect(res.rejectedReason).toBeUndefined();
  });
});

describe('typed vs free-form retries (A/B)', () => {
  it('typed handoffs incur fewer retries than free-form on the same seed/tasks', () => {
    const typed = simulateRetries({ typed: true, tasks: 100, seed: 42 });
    const free = simulateRetries({ typed: false, tasks: 100, seed: 42 });
    expect(typed.retries).toBeLessThan(free.retries);
    // Deterministic: re-running yields identical counts.
    expect(simulateRetries({ typed: true, tasks: 100, seed: 42 }).retries).toBe(typed.retries);
  });
});

describe('defaultChain defensive invariants', () => {
  it('ends at Disclosure with an immutable, high-risk Security→Disclosure hop', () => {
    const chain = defaultChain();
    const last = chain[chain.length - 1];
    expect(last.from).toBe('Security');
    expect(last.to).toBe('Disclosure');
    expect(last.riskLevel).toBe('high');
    expect(last.immutable).toBe(true);
    // No weaponization/release terminal stage exists in the chain.
    expect(chain.some((c) => /release|exploit|weaponi/i.test(c.to))).toBe(false);
  });
});
