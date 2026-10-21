import { describe, it, expect } from 'vitest';
import { runBoundedLearning, type BoundedLearningConfig, type LearningAdapters } from '../src/bounded-learning.js';
import { makeSigner, verifyReceipt } from '../src/receipts.js';
const config = (): BoundedLearningConfig => ({ baseline: { strategy: 'base', permissions: 'frozen' },
  families: ['files', 'routing'], allowedLevers: ['strategy'], sourceDigest: 'a'.repeat(64),
  trainingDigest: 'b'.repeat(64), confirmationDigest: 'c'.repeat(64), evidenceClass: 'independent_confirmation',
  maxRounds: 2, maxCalls: 30, maxCostMicroUsd: 3000, perCallCostMicroUsd: 100, timeoutMs: 500 });
const adapters = (): LearningAdapters => ({
  propose: async () => ({ value: { strategy: 'candidate', permissions: 'frozen' }, costMicroUsd: 10 }),
  evaluate: async p => ({ successes: p.strategy === 'base' ? 8 : 9, trials: 10, costMicroUsd: p.strategy === 'base' ? 50 : 10, permissionViolations: 0 }),
});
const run = (a = adapters(), c = config()) => runBoundedLearning(c, a, makeSigner());
describe('bounded learning', () => {
  it('seals complete evidence without promotion authority', async () => {
    const r = await run();
    expect(r.verdict).toBe('REVIEW_REQUIRED'); expect(r.authority).toBe('none');
    expect(r.calls).toBe(24); expect(r.costMicroUsd).toBe(640);
    expect(verifyReceipt(r.receipt)).toBe(true);
    expect(r.records.filter(x => x.kind === 'corrupt')).toHaveLength(4);
  });
  it('does not send confirmation scores or configuration to the proposer', async () => {
    const a = adapters(), seen: unknown[] = [];
    a.propose = async input => { seen.push(structuredClone(input)); return { value: { strategy: 'candidate', permissions: 'frozen' }, costMicroUsd: 10 }; };
    await run(a);
    expect(Object.keys(seen[0] as object).sort()).toEqual(['baseline', 'round', 'training']);
    expect(JSON.stringify(seen)).not.toContain('confirmation');
  });
  it.each([NaN, Infinity, -1, 0, 1.5])('rejects invalid budget %s before dispatch', async n => {
    await expect(run(adapters(), { ...config(), maxCostMicroUsd: n })).rejects.toThrow('Invalid');
  });
  it('stops before the first over-budget call', async () => {
    const r = await run(adapters(), { ...config(), maxCalls: 1 });
    expect(r.calls).toBe(1); expect(r.verdict).toBe('REJECTED');
  });
  it('forbids permission mutations', async () => {
    const a = adapters(); a.propose = async () => ({ value: { strategy: 'candidate', permissions: '*' }, costMicroUsd: 10 });
    expect((await run(a)).reasons).toContain('Candidate changed a forbidden lever');
  });
  it('rejects a corrupt-skill regression in either family', async () => {
    const a = adapters(), original = a.evaluate;
    a.evaluate = async (p, f, s, l) => s === 'corrupt' && f === 'routing' && p.strategy === 'candidate'
      ? { successes: 7, trials: 10, costMicroUsd: 10, permissionViolations: 0 } : original(p, f, s, l);
    expect((await run(a)).reasons).toContain('routing/corrupt: efficiency or quality gate failed');
  });
  it('rejects serving gains that do not repay development cost', async () => {
    const a = adapters(); a.evaluate = async p => ({ successes: p.strategy === 'base' ? 8 : 9,
      trials: 10, costMicroUsd: 10, permissionViolations: 0 });
    expect((await run(a)).reasons).toContain('Full-cycle efficiency gate failed');
  });
  it('rejects synthetic claims even when every numeric threshold passes', async () => {
    expect((await run(adapters(), { ...config(), evidenceClass: 'synthetic' })).verdict).toBe('REJECTED');
  });
  it('aborts stalled adapters and preserves unknown-cost reservations', async () => {
    const a = adapters(); let signal: AbortSignal | undefined;
    a.evaluate = async (_p, _f, _s, limits) => { signal = limits.signal; return new Promise(() => {}); };
    const r = await run(a, { ...config(), timeoutMs: 10 });
    expect(r.verdict).toBe('REJECTED'); expect(signal?.aborted).toBe(true);
    expect(r.calls).toBe(1); expect(r.costMicroUsd).toBe(100);
  });
  it('rejects overlapping split identities', async () => {
    await expect(run(adapters(), { ...config(), confirmationDigest: 'b'.repeat(64) })).rejects.toThrow();
  });
  it('fails closed on malformed observations and accounting', async () => {
    const a = adapters(); a.evaluate = async () => ({ successes: 11, trials: 10, costMicroUsd: 10, permissionViolations: 0 });
    expect((await run(a)).verdict).toBe('REJECTED');
    a.evaluate = async () => ({ successes: 9, trials: 10, costMicroUsd: 101, permissionViolations: 0 });
    expect((await run(a)).reasons).toContain('Invalid or exceeded cost reservation');
  });
  it('stops immediately on a permission violation', async () => {
    const a = adapters(); a.evaluate = async () => ({ successes: 9, trials: 10, costMicroUsd: 10, permissionViolations: 1 });
    const r = await run(a); expect(r.calls).toBe(1); expect(r.verdict).toBe('REJECTED');
  });
});
