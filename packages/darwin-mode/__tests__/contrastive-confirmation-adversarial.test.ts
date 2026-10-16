import { describe, expect, it, vi } from 'vitest';
import { confirmContrastive, pairedSignPValue } from '../src/contrastive/confirmation.js';
import type { ConfirmationOptions, ConfirmationPairInput, ConfirmationPairOutput } from '../src/contrastive/confirmation-types.js';

function paired(input: ConfirmationPairInput, overrides: Partial<ConfirmationPairOutput> = {}): ConfirmationPairOutput {
  return { tenantId: input.tenantId, projectId: input.projectId, environmentDigest: input.environmentDigest, envelopeDigest: input.envelopeDigest,
    taskId: input.taskId, appliedBaselineDigest: input.baselineDigest, appliedCandidateDigest: input.candidateDigest,
    baselinePassed: false, candidatePassed: true, costUsd: 0.01, ...overrides };
}
function options(n = 20): ConfirmationOptions {
  return { tenantId: 'tenant-a', projectId: 'project-a', environment: { evaluator: 'v1', data: 'heldout-v1' },
    envelope: { tools: ['read'], network: false, promotion: false },
    baseline: { components: [{ id: 'procedure', scope: 'invariant', content: { check: false } }] },
    candidate: { components: [{ id: 'procedure', scope: 'invariant', content: { check: true } }] },
    developmentTaskIds: ['dev-1'], confirmationTaskIds: Array.from({ length: n }, (_, i) => `holdout-${i}`),
    policy: { minCases: 10, minWins: 5, maxRegressions: 0, minGain: 0.1, alpha: 0.05 },
    budget: { maxUsd: 3, maxCalls: n, timeoutMs: 1000, pairUsd: 0.1 },
    evaluator: { surfaceAware: true, evaluatePair: async input => paired(input) },
  };
}
async function rejectBeforeEffects(input: ConfirmationOptions) {
  const evaluatePair = vi.fn(input.evaluator.evaluatePair);
  let result;
  try { result = await confirmContrastive({ ...input, evaluator: { ...input.evaluator, evaluatePair } }); }
  catch (error) { expect(error).toBeInstanceOf(Error); }
  if (result) expect(result.verdict).not.toBe('confirmed');
  expect(evaluatePair).not.toHaveBeenCalled();
}

describe('confirmation independent adversarial review', () => {
  it('confirms a complete decisive comparison without promotion', async () => {
    const r = await confirmContrastive(options());
    expect(r.verdict).toBe('confirmed'); expect(r.promotion).toBe('not-authorized');
    expect(r.stats).toMatchObject({ cases: 20, wins: 20, losses: 0, ties: 0, baselinePassed: 0, candidatePassed: 20, gain: 1 });
    expect(r.calls).toBe(20); expect(r.stats.pValue).toBe(2 ** -20); expect(r.reservedUsd).toBe(2);
  });
  it('refuses to execute an identical baseline and candidate', async () => {
    const o = options(); await rejectBeforeEffects({ ...o, candidate: o.baseline });
  });
  it('rejects declared development and confirmation task overlap', async () => {
    const o = options(); await rejectBeforeEffects({ ...o, developmentTaskIds: [o.confirmationTaskIds[0]] });
  });
  it.each(['developmentTaskIds', 'confirmationTaskIds'] as const)('rejects duplicate %s', async key => {
    const o = options(); await rejectBeforeEffects({ ...o, [key]: ['duplicate', 'duplicate'] });
  });
  it.each([[0,0,1], [1,0,0.5], [5,0,0.03125], [4,1,0.1875], [8,2,0.0546875], [9,1,0.0107421875], [5,5,0.623046875]])('matches an exact binomial tail for %i wins and %i losses', (wins, losses, expected) => {
    expect(pairedSignPValue(wins, losses)).toBe(expected);
  });
  it('never underflows a positive tail to zero and handles the maximum sample size', () => {
    expect(pairedSignPValue(4096, 0)).toBe(Number.MIN_VALUE);
    expect(pairedSignPValue(0, 4096)).toBe(1);
    expect(pairedSignPValue(2048, 2048)).toBeGreaterThan(0.5);
    expect(pairedSignPValue(2048, 2048)).toBeLessThan(0.51);
  });
  it('matches an independent exact integer reference conservatively across 101 tails', () => {
    const n = 100; let previous = 1;
    for (let wins = 0; wins <= n; wins++) {
      let term = 1n; let numerator = 0n;
      for (let k = 0; k <= n; k++) { if (k >= wins) numerator += term; if (k < n) term = term * BigInt(n-k) / BigInt(k+1); }
      const p = pairedSignPValue(wins, n - wins);
      expect(p).toBeLessThanOrEqual(previous); previous = p;
      expect(p).toBeCloseTo(Number(numerator) / 2 ** n, 14);
      const buffer = new ArrayBuffer(8); const view = new DataView(buffer); view.setFloat64(0, p);
      const bits = view.getBigUint64(0); const rawExponent = Number((bits >> 52n) & 2047n);
      const significand = (bits & ((1n << 52n) - 1n)) + (rawExponent ? 1n << 52n : 0n);
      const exponent = (rawExponent ? rawExponent - 1023 - 52 : -1074) + n;
      expect(exponent >= 0 ? (significand << BigInt(exponent)) >= numerator : significand >= (numerator << BigInt(-exponent))).toBe(true);
    }
  });
  it.each([[-1,1], [1.5,1], [NaN,0], [Infinity,0], [4097,0]])('rejects invalid exact-test inputs %s %s', (wins, losses) => {
    expect(() => pairedSignPValue(wins, losses)).toThrow();
  });
  it.each([true, false])('ties cannot confirm, even when all outcomes equal %s', async passed => {
    const o = options(); const r = await confirmContrastive({ ...o, evaluator: { surfaceAware: true, evaluatePair: async i => paired(i, { baselinePassed: passed, candidatePassed: passed }) } });
    expect(r.verdict).toBe('rejected'); expect(r.stats.wins).toBe(0); expect(r.stats.pValue).toBe(1); expect(r.stats.ties).toBe(20);
  });
  it('aggregate lift and significance cannot hide a forbidden regression', async () => {
    const o = options(); const r = await confirmContrastive({ ...o, evaluator: { surfaceAware: true, evaluatePair: async i => paired(i, i.taskId === 'holdout-0' ? { baselinePassed: true, candidatePassed: false } : {}) } });
    expect(r.stats.gain).toBe(0.9); expect(r.stats.pValue).toBeLessThan(0.05); expect(r.stats.losses).toBe(1); expect(r.verdict).toBe('rejected');
  });
  it('finishes the full declared holdout before confirmation', async () => {
    const o = options(); const evaluatePair = vi.fn(o.evaluator.evaluatePair);
    const r = await confirmContrastive({ ...o, evaluator: { surfaceAware: true, evaluatePair } });
    expect(evaluatePair).toHaveBeenCalledTimes(20); expect(r.receipts).toHaveLength(20); expect(r.stats.cases).toBe(20);
  });
  it('an incomplete statistically significant prefix remains inconclusive', async () => {
    const o = options(); const r = await confirmContrastive({ ...o, budget: { ...o.budget, maxCalls: 12 } });
    expect(r.stats.pValue).toBeLessThan(0.05); expect(r.stats.wins).toBe(12); expect(r.verdict).toBe('inconclusive'); expect(r.calls).toBe(12);
  });
  it('too few fully completed cases remain inconclusive', async () => {
    const r = await confirmContrastive(options(8));
    expect(r.stats.pValue).toBeLessThan(0.05); expect(r.stats.cases).toBe(8); expect(r.verdict).toBe('inconclusive');
  });
  it.each(['tenantId', 'projectId', 'environmentDigest', 'envelopeDigest', 'taskId', 'appliedBaselineDigest', 'appliedCandidateDigest'] as const)('rejects mismatched pair binding %s', async key => {
    const o = options(); const r = await confirmContrastive({ ...o, evaluator: { surfaceAware: true, evaluatePair: async i => paired(i, { [key]: 'wrong' }) } });
    expect(r.verdict).toBe('inconclusive'); expect(r.calls).toBe(1); expect(r.stats.cases).toBe(0); expect(r.receipts[0].status).toBe('invalid');
  });
  it.each([1, 0, 'true', null])('rejects nonboolean outcome %s', async candidatePassed => {
    const o = options(); const r = await confirmContrastive({ ...o, evaluator: { surfaceAware: true, evaluatePair: async i => paired(i, { candidatePassed: candidatePassed as boolean }) } });
    expect(r.verdict).toBe('inconclusive'); expect(r.stats.cases).toBe(0); expect(r.calls).toBe(1);
  });
  it('rejects adapter score/promotion fields instead of trusting them', async () => {
    const o = options(); const r = await confirmContrastive({ ...o, evaluator: { surfaceAware: true, evaluatePair: async i => ({ ...paired(i), confirmed: true, pValue: 0, promotion: 'authorized' }) } });
    expect(r.verdict).toBe('inconclusive'); expect(r.promotion).toBe('not-authorized'); expect(r.stats.cases).toBe(0);
  });
  it('later failures cannot promote an earlier winning prefix', async () => {
    const o = options(); let calls = 0;
    const r = await confirmContrastive({ ...o, evaluator: { surfaceAware: true, evaluatePair: async i => { if (++calls === 15) throw new Error('adapter unavailable'); return paired(i); } } });
    expect(r.stats.pValue).toBeLessThan(0.05); expect(r.verdict).toBe('inconclusive'); expect(r.calls).toBe(15); expect(r.receipts.at(-1)?.status).toBe('failure');
  });
  it('freezes paired documents, environment and capability envelope before effects', async () => {
    const o = options(); let frozen = false; let blocked = false;
    const pending = confirmContrastive({ ...o, evaluator: { surfaceAware: true, evaluatePair: async i => {
      frozen = Object.isFrozen(i) && Object.isFrozen(i.baseline.components[0].content) && Object.isFrozen(i.candidate.components) && Object.isFrozen(i.environment) && Object.isFrozen((i.envelope as any).tools);
      try { (i.envelope as any).tools.push('shell'); } catch { blocked = true; }
      return paired(i);
    } } });
    (o.candidate.components[0].content as any).check = 'changed-outside'; (o.envelope as any).network = true;
    const r = await pending; expect(frozen).toBe(true); expect(blocked).toBe(true); expect(r.verdict).toBe('confirmed');
  });
  it('uses the initial policy despite caller mutation during evaluation', async () => {
    const o = options(); (o.policy as any).maxRegressions = 2; let index = 0;
    const pending = confirmContrastive({ ...o, evaluator: { surfaceAware: true, evaluatePair: async i => {
      const n = index++; return paired(i, n < 8 ? {} : n < 10 ? { baselinePassed: true, candidatePassed: false } : { baselinePassed: true, candidatePassed: true });
    } } });
    (o.policy as any).alpha = 0.5;
    const r = await pending; expect(r.stats.pValue).toBe(0.0546875); expect(r.verdict).toBe('rejected');
  });
  it('rejects late completion after cancellation and does not start another pair', async () => {
    const o = options(); let resolve!: (out: ConfirmationPairOutput) => void; let input!: ConfirmationPairInput;
    const pending = confirmContrastive({ ...o, budget: { ...o.budget, timeoutMs: 10 }, evaluator: { surfaceAware: true, evaluatePair: i => { input = i; return new Promise(r => { resolve = r; }); } } });
    const r = await pending; const saved = JSON.stringify(r); expect(input.signal.aborted).toBe(true); expect(r.verdict).toBe('inconclusive'); expect(r.calls).toBe(1);
    resolve(paired(input)); await Promise.resolve(); await Promise.resolve(); expect(JSON.stringify(r)).toBe(saved); expect(r.stats.cases).toBe(0); expect(r.reportedUsd).toBe(0.1);
  });
  it.each([NaN, Infinity, -1, 2])('fails closed with auditable cost for %s', async costUsd => {
    const o = options(); const r = await confirmContrastive({ ...o, evaluator: { surfaceAware: true, evaluatePair: async i => paired(i, { costUsd }) } });
    expect(r.verdict).toBe('inconclusive'); expect(r.calls).toBe(1); expect(r.reservedUsd).toBe(0.1); expect(r.reportedUsd).toBe(costUsd === 2 ? 2 : 0.1);
  });
  it('makes no call when the first ceiling cannot be reserved', async () => {
    const o = options(); await rejectBeforeEffects({ ...o, budget: { ...o.budget, maxUsd: 0 } });
  });
  it.each([{ alpha: 0 }, { alpha: 1 }, { minWins: 0 }, { minCases: 0 }, { maxRegressions: -1 }, { minGain: NaN }])('rejects invalid confirmation policy %j before effects', async changed => {
    const o = options(); await rejectBeforeEffects({ ...o, policy: { ...o.policy, ...changed } });
  });
  it('rejects hostile JSON envelopes without invoking getters', async () => {
    let reads = 0; const envelope = Object.defineProperty({}, 'tools', { enumerable: true, get() { reads++; return ['shell']; } });
    await rejectBeforeEffects({ ...options(), envelope }); expect(reads).toBe(0);
    await rejectBeforeEffects({ ...options(), environment: JSON.parse('{"__proto__":{"polluted":true}}') }); expect(({} as any).polluted).toBeUndefined();
  });
  it('binds decisions to frozen policy, environment, candidate and declared task sets', async () => {
    const o = options(); const first = await confirmContrastive(o);
    const changedPolicy = await confirmContrastive({ ...o, policy: { ...o.policy, alpha: 0.01 } });
    const changedEnvironment = await confirmContrastive({ ...o, environment: { evaluator: 'v2', data: 'heldout-v1' } });
    const changedDevelopment = await confirmContrastive({ ...o, developmentTaskIds: ['dev-other'] });
    expect(first.policyDigest).not.toBe(changedPolicy.policyDigest); expect(first.environmentDigest).not.toBe(changedEnvironment.environmentDigest);
    expect(first.developmentSetDigest).not.toBe(changedDevelopment.developmentSetDigest); expect(first.confirmationSetDigest).toBe(changedDevelopment.confirmationSetDigest);
    expect(Object.isFrozen(first.policy)).toBe(true); expect(first.policy).toEqual(o.policy); expect(Object.isFrozen(first.receipts)).toBe(true);
  });
  it('allows paired counts to be independently reconstructed from success receipts', async () => {
    const o = options(); let index = 0;
    const r = await confirmContrastive({ ...o, evaluator: { surfaceAware: true, evaluatePair: async i => {
      const n = index++; return paired(i, n < 8 ? {} : n < 10 ? { baselinePassed: true, candidatePassed: false } : { baselinePassed: true, candidatePassed: true });
    } } });
    const good = r.receipts.filter(x => x.status === 'success');
    expect(good.filter(x => x.baselinePassed === false && x.candidatePassed === true)).toHaveLength(r.stats.wins);
    expect(good.filter(x => x.baselinePassed === true && x.candidatePassed === false)).toHaveLength(r.stats.losses);
    expect(good.filter(x => x.baselinePassed === x.candidatePassed)).toHaveLength(r.stats.ties);
    const failed = await confirmContrastive({ ...o, evaluator: { surfaceAware: true, evaluatePair: async () => { throw new Error('unavailable'); } } });
    expect(Object.hasOwn(failed.receipts[0], 'baselinePassed')).toBe(false); expect(Object.hasOwn(failed.receipts[0], 'candidatePassed')).toBe(false);
  });
  it('applies one total deadline across pairs instead of resetting it per pair', async () => {
    const o = options(2); let now = 0; const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const r = await confirmContrastive({ ...o, policy: { ...o.policy, minCases: 1, minWins: 1, alpha: 0.5 }, budget: { ...o.budget, timeoutMs: 10 }, evaluator: { surfaceAware: true, evaluatePair: async i => { now += 6; return paired(i); } } });
      expect(r.verdict).toBe('inconclusive'); expect(r.reason).toBe('timeout'); expect(r.stats.cases).toBe(1); expect(r.calls).toBe(2);
    } finally { clock.mockRestore(); }
  });
});
