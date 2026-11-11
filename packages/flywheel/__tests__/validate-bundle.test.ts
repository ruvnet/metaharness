// @metaharness/flywheel — adversarial coverage for the fail-closed ReplayBundle runtime boundary
// (validate-bundle.ts). Added in response to PR review on #341: the negative-primary RangeError fix
// closed one reachable crash, but nothing previously stopped NaN/Infinity/null/string/object values in a
// bundle's numeric fields from silently reaching graph's arithmetic or analyzeBundle's aggregation with
// no error and no exit-code signal. Every case here proves REJECTION, not just "didn't throw" — a
// validator that silently accepted everything would also "not throw."
import { describe, it, expect } from 'vitest';
import { validateReplayBundle } from '../src/validate-bundle.js';
import { verifyReplayBundle } from '../src/replay.js';
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

// 2026-11-11 dream-cycle (flywheel-promotion): `cli.ts`'s `loadBundle()` runs every bundle it reads
// through `validateReplayBundle()` before calling `verifyReplayBundle()` — but `verifyReplayBundle` is
// also re-exported from `index.ts` as the documented entry point for an INDEPENDENT reviewer with no
// trust in the producer (see replay.ts's file header). A caller that imports it directly, bypassing the
// CLI, got no such gate: a malformed top-level `ReplayBundle` reached `verifyReplayBundle`'s own
// iteration/property access and threw an uncaught TypeError, breaking its own documented "always return
// a verdict, never throw" contract. Confirmed live against the pre-fix build (`node -e` against
// `dist/cjs/replay.js`): a non-array `chain` threw "Cannot read properties of undefined (reading
// 'payload')"; a bundle missing `all_commits` threw "b.all_commits is not iterable" — neither is a
// hypothetical. Every case below proves a clean REJECTED verdict, not just "didn't throw" — a version
// that silently coerced the bad shape into a passing verdict would also "not throw."
describe('verifyReplayBundle() — fail-closed on a malformed top-level bundle (does not just trust the CLI)', () => {
  it('does not throw, and fails closed, when chain is not an array', () => {
    const bundle = { ...validBundle(), chain: 'not-an-array' } as unknown as ReplayBundle;
    let verdict: ReturnType<typeof verifyReplayBundle> | undefined;
    expect(() => { verdict = verifyReplayBundle(bundle); }).not.toThrow();
    expect(verdict!.pass).toBe(false);
    expect(verdict!.failures).toContain('invalid_bundle');
  });

  it('does not throw, and fails closed, when all_commits is missing entirely', () => {
    const bundle = validBundle() as unknown as Record<string, unknown>;
    delete bundle.all_commits;
    let verdict: ReturnType<typeof verifyReplayBundle> | undefined;
    expect(() => { verdict = verifyReplayBundle(bundle as unknown as ReplayBundle); }).not.toThrow();
    expect(verdict!.pass).toBe(false);
    expect(verdict!.failures).toContain('invalid_bundle');
  });

  it('does not throw, and fails closed, when a chain node\'s parents is not an array', () => {
    const bundle = validBundle();
    (bundle.chain[0] as unknown as Record<string, unknown>).parents = 'not-an-array';
    let verdict: ReturnType<typeof verifyReplayBundle> | undefined;
    expect(() => { verdict = verifyReplayBundle(bundle); }).not.toThrow();
    expect(verdict!.pass).toBe(false);
    expect(verdict!.failures).toContain('invalid_bundle');
  });

  it('rejects a NaN/Infinity-poisoned numeric field instead of letting it reach gate re-execution unflagged', () => {
    const bundle = validBundle() as unknown as Record<string, unknown>;
    bundle.verified_improvements = NaN;
    let verdict: ReturnType<typeof verifyReplayBundle> | undefined;
    expect(() => { verdict = verifyReplayBundle(bundle as unknown as ReplayBundle); }).not.toThrow();
    expect(verdict!.pass).toBe(false);
    expect(verdict!.failures).toContain('invalid_bundle');
  });

  it('does not add invalid_bundle for a structurally well-formed bundle (no behavior change on the happy path)', () => {
    // validBundle()'s receipt is a fixture stub, not a real Ed25519 signature, so `receipts` still fails —
    // this only proves the NEW `invalid_bundle` gate stays silent for correctly-shaped bundles.
    const bundle = validBundle();
    const verdict = verifyReplayBundle(bundle);
    expect(verdict.failures).not.toContain('invalid_bundle');
    expect(verdict.chainSummary).not.toBe('');
  });
});
