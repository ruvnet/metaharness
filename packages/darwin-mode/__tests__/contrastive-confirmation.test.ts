import { describe, expect, it, vi } from 'vitest';
import { confirmContrastive, pairedSignPValue } from '../src/contrastive/confirmation.js';
import type { ConfirmationOptions, ConfirmationPairInput, ConfirmationPairOutput } from '../src/contrastive/confirmation.js';

function fixture(count = 20): ConfirmationOptions {
  return {
    tenantId: 'tenant-a', projectId: 'project-a', environment: { dataset: 'frozen-1', seed: 3 },
    envelope: { tools: ['classify'], network: false },
    baseline: { components: [{ id: 'routing', scope: 'domain', content: { calibrated: false } }] },
    candidate: { components: [{ id: 'routing', scope: 'domain', content: { calibrated: true } }] },
    developmentTaskIds: ['dev:1'],
    confirmationTaskIds: Array.from({ length: count }, (_, index) => 'holdout:' + index),
    policy: { minCases: 20, minWins: 5, maxRegressions: 0, minGain: 0.05, alpha: 0.05 },
    budget: { maxUsd: count / 10, maxCalls: count, timeoutMs: 1000, pairUsd: 0.1 },
    evaluator: { surfaceAware: true, async evaluatePair(input) {
      return { tenantId: input.tenantId, projectId: input.projectId, environmentDigest: input.environmentDigest, envelopeDigest: input.envelopeDigest,
        taskId: input.taskId, appliedBaselineDigest: input.baselineDigest, appliedCandidateDigest: input.candidateDigest,
        baselinePassed: false, candidatePassed: true, costUsd: 0.01 };
    } },
  };
}

describe('independent paired confirmation', () => {
  it('confirms only after the entire frozen set and binds its policy and provenance', async () => {
    const config = fixture();
    const spy = vi.fn(config.evaluator.evaluatePair);
    config.evaluator.evaluatePair = spy;
    const result = await confirmContrastive(config);
    expect(result.verdict).toBe('confirmed');
    expect(result.stats).toEqual({ cases: 20, wins: 20, losses: 0, ties: 0,
      baselinePassed: 0, candidatePassed: 20, gain: 1, pValue: 2 ** -20 });
    expect(spy).toHaveBeenCalledTimes(20);
    expect(result.calls).toBe(20);
    expect(result.receipts.every(r => r.baselinePassed === false && r.candidatePassed === true)).toBe(true);
    expect(result.reservedUsd).toBe(2);
    expect(result.policy).toEqual(config.policy);
    expect(result.policyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.developmentSetDigest).not.toBe(result.confirmationSetDigest);
    expect(result.promotion).toBe('not-authorized');
    expect(Object.isFrozen(result.receipts)).toBe(true);
    expect(result.receipts.map(x => x.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it('counts equal outcomes as ties without adding them to discordant evidence', async () => {
    const config = fixture();
    const evaluatePair = config.evaluator.evaluatePair;
    config.evaluator.evaluatePair = async input => {
      const number = Number(input.taskId.split(':')[1]);
      return { ...await evaluatePair(input), baselinePassed: number >= 5, candidatePassed: true };
    };
    const result = await confirmContrastive(config);
    expect(result.verdict).toBe('confirmed');
    expect(result.stats.wins).toBe(5);
    expect(result.stats.ties).toBe(15);
    expect(result.stats.pValue).toBe(1 / 32);
    expect(result.stats.gain).toBe(0.25);
  });

  it('rejects forbidden regressions despite many wins and completes all tasks', async () => {
    const config = fixture();
    const evaluatePair = config.evaluator.evaluatePair;
    config.evaluator.evaluatePair = async input => ({ ...await evaluatePair(input),
      baselinePassed: input.taskId === 'holdout:0', candidatePassed: input.taskId !== 'holdout:0' });
    const result = await confirmContrastive(config);
    expect(result.verdict).toBe('rejected');
    expect(result.reason).toBe('regression-limit');
    expect(result.calls).toBe(20);
    expect(result.stats.losses).toBe(1);
  });

  it('marks completed low-sample confirmation inconclusive', async () => {
    const result = await confirmContrastive(fixture(3));
    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toBe('insufficient-cases');
    expect(result.calls).toBe(3);
  });

  it('rejects weak paired evidence even when the candidate wins more', async () => {
    const config = fixture();
    const evaluatePair = config.evaluator.evaluatePair;
    config.evaluator.evaluatePair = async input => ({ ...await evaluatePair(input),
      baselinePassed: false, candidatePassed: input.taskId === 'holdout:0' });
    const result = await confirmContrastive({ ...config, policy: { ...config.policy, minWins: 1, minGain: 0 } });
    expect(result.reason).toBe('insufficient-evidence');
    expect(result.stats.pValue).toBe(0.5);
  });

  it('rejects identical documents without executing a pair', async () => {
    const config = fixture();
    const spy = vi.fn(config.evaluator.evaluatePair);
    const result = await confirmContrastive({ ...config, candidate: config.baseline, evaluator: { surfaceAware: true, evaluatePair: spy } });
    expect(result.verdict).toBe('rejected');
    expect(result.reason).toBe('identical-candidate');
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    { developmentTaskIds: ['holdout:0'] },
    { developmentTaskIds: ['dev:1', 'dev:1'] },
    { confirmationTaskIds: ['case:1', 'case:1'] },
  ])('rejects overlap or duplicates before effects: %j', async override => {
    const config = fixture();
    const spy = vi.fn(config.evaluator.evaluatePair);
    await expect(confirmContrastive({ ...config, ...override, evaluator: { surfaceAware: true, evaluatePair: spy } })).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('freezes all policy, document and environment snapshots against caller and callback mutation', async () => {
    const config = fixture();
    const evaluatePair = config.evaluator.evaluatePair;
    config.evaluator.evaluatePair = async input => {
      (config.environment as { seed: number }).seed = 99;
      (config.policy as { alpha: number }).alpha = 0.5;
      expect((input.environment as { seed: number }).seed).toBe(3);
      expect(() => { (input.envelope as { network: boolean }).network = true; }).toThrow();
      expect(Object.hasOwn(input, 'policy')).toBe(false);
      expect(Object.hasOwn(input, 'answers')).toBe(false);
      return evaluatePair(input);
    };
    const result = await confirmContrastive(config);
    expect(result.policy.alpha).toBe(0.05);
  });

  it('pre-reserves exact decimal budget and stops without partial confirmation', async () => {
    const config = fixture();
    const result = await confirmContrastive({ ...config, budget: { ...config.budget, maxUsd: 0.7 } });
    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toBe('budget');
    expect(result.calls).toBe(7);
    expect(result.stats.cases).toBe(7);
    expect(result.reservedUsd).toBe(0.7);
    expect(result.receipts.at(-1)?.reservedUsd).toBe(0);
  });

  it('never starts a pair that cannot fit its declared ceiling', async () => {
    const config = fixture();
    const spy = vi.fn(config.evaluator.evaluatePair);
    const result = await confirmContrastive({ ...config, budget: { ...config.budget, maxUsd: 0 },
      evaluator: { surfaceAware: true, evaluatePair: spy } });
    expect(result.calls).toBe(0);
    expect(result.verdict).toBe('inconclusive');
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -0.01, 0.11])('rejects malformed or excessive cost %s', async costUsd => {
    const config = fixture();
    const evaluatePair = config.evaluator.evaluatePair;
    config.evaluator.evaluatePair = async input => ({ ...await evaluatePair(input), costUsd });
    const result = await confirmContrastive(config);
    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toBe('invalid');
    expect(result.reportedUsd).toBe(Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : 0.1);
    expect(result.stats.cases).toBe(0);
    expect(result.receipts[0]).not.toHaveProperty('baselinePassed');
  });

  it.each(['tenantId', 'projectId', 'environmentDigest', 'envelopeDigest', 'taskId', 'appliedBaselineDigest', 'appliedCandidateDigest'])(
    'rejects mismatched pair identity %s', async field => {
      const config = fixture();
      const evaluatePair = config.evaluator.evaluatePair;
      config.evaluator.evaluatePair = async input => ({ ...await evaluatePair(input), [field]: 'wrong' });
      const result = await confirmContrastive(config);
      expect(result.reason).toBe('invalid');
      expect(result.stats.cases).toBe(0);
    });

  it('requires literal independent boolean outcomes', async () => {
    const config = fixture();
    const evaluatePair = config.evaluator.evaluatePair;
    config.evaluator.evaluatePair = async input => ({ ...await evaluatePair(input), baselinePassed: 'false' as unknown as boolean });
    expect((await confirmContrastive(config)).reason).toBe('invalid');
  });

  it('discards late outcomes and aborts the adapter signal', async () => {
    const config = fixture();
    let input: ConfirmationPairInput | undefined;
    let complete: ((value: ConfirmationPairOutput) => void) | undefined;
    config.evaluator.evaluatePair = async value => { input = value; return new Promise(resolve => { complete = resolve; }); };
    const result = await confirmContrastive({ ...config, budget: { ...config.budget, timeoutMs: 5 } });
    expect(result.reason).toBe('timeout');
    expect(input!.signal.aborted).toBe(true);
    const serialized = JSON.stringify(result);
    complete!({ tenantId: input!.tenantId, projectId: input!.projectId, environmentDigest: input!.environmentDigest, envelopeDigest: input!.envelopeDigest,
      taskId: input!.taskId, appliedBaselineDigest: input!.baselineDigest, appliedCandidateDigest: input!.candidateDigest,
      baselinePassed: false, candidatePassed: true, costUsd: 0 });
    await Promise.resolve(); await Promise.resolve();
    expect(JSON.stringify(result)).toBe(serialized);
    expect(result.stats.cases).toBe(0);
  });

  it('bounds total time across pairs and never dispatches another pair after the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const config = fixture(3);
      const original = config.evaluator.evaluatePair;
      const spy = vi.fn(async (input: ConfirmationPairInput) => {
        // Each 20ms pair fits 30ms individually, but two cannot fit the round.
        await new Promise(resolve => setTimeout(resolve, 20));
        return original(input);
      });
      const pending = confirmContrastive({ ...config, budget: { ...config.budget, timeoutMs: 30 },
        evaluator: { surfaceAware: true, evaluatePair: spy } });
      await vi.advanceTimersByTimeAsync(31);
      const result = await pending;
      expect(result.verdict).toBe('inconclusive');
      expect(result.reason).toBe('timeout');
      expect(result.stats.cases).toBe(1);
      expect(result.calls).toBe(2);
      expect(result.receipts.map(item => item.status)).toEqual(['success', 'timeout']);
      expect(result.reportedUsd).toBeCloseTo(0.11);
      expect(result.reservedUsd).toBe(0.2);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[1][0].signal.aborted).toBe(true);
      const saved = JSON.stringify(result);
      await vi.advanceTimersByTimeAsync(100);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).toBe(saved);
    } finally {
      vi.useRealTimers();
    }
  });

  it('redacts failure details and charges unknown failures conservatively', async () => {
    const config = fixture();
    config.evaluator.evaluatePair = async () => { throw new Error('provider secret'); };
    const result = await confirmContrastive(config);
    expect(result.reason).toBe('failure');
    expect(result.reportedUsd).toBe(0.1);
    expect(JSON.stringify(result)).not.toContain('provider secret');
  });

  it.each([
    { minCases: 0 }, { minWins: 0 }, { maxRegressions: -1 }, { minGain: 1.01 },
    { alpha: 0 }, { alpha: 0.51 }, { alpha: NaN },
  ])('rejects malformed confirmation policy %j', async override => {
    const config = fixture();
    await expect(confirmContrastive({ ...config, policy: { ...config.policy, ...override } })).rejects.toThrow();
  });
});

describe('exact one-sided paired sign probability', () => {
  it.each([
    [0, 0, 1], [0, 5, 1], [1, 0, 0.5], [2, 0, 0.25], [5, 0, 0.03125],
    [2, 1, 0.5], [3, 1, 0.3125], [1, 3, 0.9375],
  ])('matches exact small tail for wins=%i losses=%i', (wins, losses, expected) => {
    expect(pairedSignPValue(wins, losses)).toBe(expected);
  });
  it('handles the maximum bound without cancellation or zero underflow', () => {
    expect(pairedSignPValue(4096, 0)).toBe(Number.MIN_VALUE);
    expect(pairedSignPValue(2048, 2048)).toBeGreaterThan(0.5);
    expect(pairedSignPValue(2048, 2048)).toBeLessThan(0.51);
    expect(() => pairedSignPValue(4096, 1)).toThrow();
    expect(() => pairedSignPValue(1.5, 0)).toThrow();
  });
});
