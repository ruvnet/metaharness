// @metaharness/flywheel — adversarial coverage for the fail-closed ReplayBundle runtime boundary
// (validate-bundle.ts). Added in response to PR review on #341: the negative-primary RangeError fix
// closed one reachable crash, but nothing previously stopped NaN/Infinity/null/string/object values in a
// bundle's numeric fields from silently reaching graph's arithmetic or analyzeBundle's aggregation with
// no error and no exit-code signal. Every case here proves REJECTION, not just "didn't throw" — a
// validator that silently accepted everything would also "not throw."
import { describe, it, expect } from 'vitest';
import { validateReplayBundle } from '../src/validate-bundle.js';
import type { ReplayBundle } from '../src/index.js';

const validReceipt = { payload: { kind: 'root', root: 'root' }, signature: 'sig', publicKey: 'pk', alg: 'ed25519' as const };

const validBundle = (): ReplayBundle => ({
  data_source: 'SYNTHETIC',
  root_id: 'root',
  chain: [
    { id: 'root', generation: 0, parents: [], mutation: null, primaryDelta: 0, anchorScore: null, verdict: 'ROOT', failureReasons: [], receipt: validReceipt, createdAt: 'g0' },
  ],
  all_commits: [
    { id: 'root', generation: 0, parents: [], mutation: null, primaryDelta: 0, anchorScore: null, verdict: 'ROOT', failureReasons: [], receipt: validReceipt, createdAt: 'g0' },
  ],
  lift_curve: [{ generation: 0, primary: 5, delta: 0, anchor: null }],
  gate_fingerprint: null,
  verified_improvements: 0,
  anchor_surviving_improvements: 0,
  milestone_reached: false,
  created_at: 'g0',
});

describe('validateReplayBundle — valid input', () => {
  it('accepts a well-formed bundle', () => {
    expect(validateReplayBundle(validBundle())).toEqual({ valid: true, errors: [] });
  });
  it('accepts negative-but-finite primary/delta values (the 09-21 graph fix scenario) — not a schema violation', () => {
    const b = validBundle();
    b.lift_curve = [{ generation: 0, primary: -16, delta: -8, anchor: null }];
    expect(validateReplayBundle(b).valid).toBe(true);
  });
});

describe('validateReplayBundle — non-finite numerics (NaN / Infinity)', () => {
  it('rejects NaN in lift_curve.primary', () => {
    const b = validBundle();
    (b.lift_curve[0] as { primary: number }).primary = NaN;
    const r = validateReplayBundle(b);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('lift_curve[0].primary'))).toBe(true);
  });
  it('rejects Infinity in verified_improvements', () => {
    const b = validBundle() as unknown as Record<string, unknown>;
    b.verified_improvements = Infinity;
    const r = validateReplayBundle(b);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('verified_improvements'))).toBe(true);
  });
  it('rejects -Infinity in a LineageCommit.primaryDelta', () => {
    const b = validBundle();
    (b.chain[0] as { primaryDelta: number }).primaryDelta = -Infinity;
    const r = validateReplayBundle(b);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('chain[0].primaryDelta'))).toBe(true);
  });
  it('rejects NaN in a nested Score.costPerWin', () => {
    const b = validBundle();
    (b.chain[0] as Record<string, unknown>).candidateScore = { primary: 1, noopRate: 0, costPerWin: NaN, regressed: false };
    const r = validateReplayBundle(b);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('chain[0].candidateScore.costPerWin'))).toBe(true);
  });
});

describe('validateReplayBundle — oversized numerics', () => {
  it('rejects a numeric field far outside any plausible domain (1e300)', () => {
    const b = validBundle();
    (b.lift_curve[0] as { primary: number }).primary = 1e300;
    const r = validateReplayBundle(b);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('lift_curve[0].primary'))).toBe(true);
  });
});

describe('validateReplayBundle — wrong types (null / string / object in place of a number)', () => {
  it('rejects null where a required number is expected (generation)', () => {
    const b = validBundle();
    (b.lift_curve[0] as unknown as Record<string, unknown>).generation = null;
    const r = validateReplayBundle(b);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('lift_curve[0].generation'))).toBe(true);
  });
  it('rejects a string where a number is expected (verified_improvements)', () => {
    const b = validBundle() as unknown as Record<string, unknown>;
    b.verified_improvements = '3';
    const r = validateReplayBundle(b);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('verified_improvements'))).toBe(true);
  });
  it('rejects an object where a number is expected (chain[0].primaryDelta)', () => {
    const b = validBundle();
    (b.chain[0] as unknown as Record<string, unknown>).primaryDelta = { toString: () => '0' };
    const r = validateReplayBundle(b);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('chain[0].primaryDelta'))).toBe(true);
  });
  it('rejects a non-object root value (array, string, number, null)', () => {
    expect(validateReplayBundle([]).valid).toBe(false);
    expect(validateReplayBundle('not a bundle').valid).toBe(false);
    expect(validateReplayBundle(42).valid).toBe(false);
    expect(validateReplayBundle(null).valid).toBe(false);
  });
});

describe('validateReplayBundle — multiple simultaneous violations', () => {
  it('collects every error in one pass, not just the first', () => {
    const b = validBundle() as unknown as Record<string, unknown>;
    b.verified_improvements = NaN;
    b.anchor_surviving_improvements = 'bad';
    (b.lift_curve as unknown[])[0] = { generation: 0, primary: Infinity, delta: 0, anchor: null };
    const r = validateReplayBundle(b);
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});
