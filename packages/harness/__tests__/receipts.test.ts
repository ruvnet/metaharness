// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { ReceiptLog, hash, canonical } from '../src/receipts.js';

describe('hash / canonical', () => {
  it('is order-independent over object keys', () => {
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }));
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
  });
  it('differs when a value changes', () => {
    expect(hash({ a: 1 })).not.toBe(hash({ a: 2 }));
  });
});

function seed(): ReceiptLog {
  const log = new ReceiptLog();
  log.append({ runId: 'r', step: 's1', input: { i: 1 }, output: { o: 1 }, agent: 'coder', model: 'haiku', costUsd: 0.01, latencyMs: 100, verdict: 'pass' });
  log.append({ runId: 'r', step: 's2', input: { i: 2 }, output: { o: 2 }, agent: 'tester', model: 'opus', costUsd: 0.04, latencyMs: 200, verdict: 'pass' });
  return log;
}

describe('ReceiptLog (hash-chained, tamper-evident)', () => {
  it('verifies an untampered chain', () => {
    const log = seed();
    expect(log.verify().ok).toBe(true);
    expect(log.totalCostUsd()).toBeCloseTo(0.05);
  });

  it('chains genesis → first → second', () => {
    const log = seed();
    const [a, b] = log.entries();
    expect(a.prevHash).toBe('0'.repeat(64));
    expect(b.prevHash).toBe(a.thisHash);
  });

  it('detects a tampered field', () => {
    const log = seed();
    // Mutate a stored receipt out from under the chain.
    (log.entries()[0] as { costUsd: number }).costUsd = 999;
    const v = log.verify();
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.brokenAt).toBe(0);
  });

  it('detects reordering', () => {
    const log = seed();
    const e = log.entries() as unknown as Array<unknown>;
    [e[0], e[1]] = [e[1], e[0]];
    expect(log.verify().ok).toBe(false);
  });
});
