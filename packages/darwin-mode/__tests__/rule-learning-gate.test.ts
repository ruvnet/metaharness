import { describe, expect, it } from 'vitest';
import { evaluateRuleLearning, type RuleEvaluationRequest, type RuleHostRunner } from '../src/rule-learning-gate.js';
const h = (n: number) => String(n).repeat(64);
const request: RuleEvaluationRequest = { runId: 'fixture-1', rulebookHash: h(6), candidate: { candidateHash: h(1), programHash: h(2) }, baseline: { candidateHash: h(3), programHash: h(4) }, datasetHash: h(5), families: ['a', 'b', 'c'], seeds: [1, 2, 3, 4, 5] };
const runner: RuleHostRunner = async c => ({ successes: c.candidateHash === h(1) ? 7 : 5, samples: 10, interactions: c.candidateHash === h(1) ? 75 : 100, replaySteps: 10, independentProbes: 10, replayMismatches: 0, failedHiddenProbes: 0, receiptHash: h(7) });
describe('independent rule learning gate', () => {
  it('accepts exact thresholds and produces stable bound evidence', async () => {
    const a = await evaluateRuleLearning(request, runner);
    expect(a.accepted).toBe(true);
    expect(a).toEqual(await evaluateRuleLearning(request, runner));
    expect(a.evidenceHash).not.toEqual((await evaluateRuleLearning({ ...request, datasetHash: h(8) }, runner)).evidenceHash);
    expect(a.ruleLearningEvidence?.schema).toBe('rule-learning-evidence/v1');
  });
  it.each([{ seeds: [1, 1, 2, 3, 4] }, { seeds: [1] }, { families: ['a', 'a', 'b'] }, { families: ['a', 'b'] }, { maxRegression: NaN }, { datasetHash: 'invalid' }, { timeoutMs: Infinity }])('rejects invalid requests %j', async patch => {
    await expect(evaluateRuleLearning({ ...request, ...patch }, runner)).rejects.toThrow();
  });
  it.each([{ samples: 0 }, { successes: NaN }, { successes: 11 }, { interactions: -1 }, { interactions: 0 }, { replaySteps: 0 }, { independentProbes: 0 }, { receiptHash: 'fake' }])('rejects invalid host evidence %j', async patch => {
    await expect(evaluateRuleLearning(request, async c => ({ ...await runner(c), ...patch }))).rejects.toThrow();
  });
  it.each([{ replayMismatches: 1 }, { failedHiddenProbes: 1 }, { successes: 5 }, { interactions: 100 }])('fails closed on unmet gate %j', async patch => {
    const report = await evaluateRuleLearning(request, async c => ({ ...await runner(c), ...(c.candidateHash === h(1) ? patch : {}) }));
    expect(report.accepted).toBe(false);
    expect(report.ruleLearningEvidence).toBeUndefined();
  });
  it('detects nondeterministic receipts', async () => {
    let n = 0;
    const report = await evaluateRuleLearning(request, async c => ({ ...await runner(c), receiptHash: h(++n % 2 ? 8 : 9) }));
    expect(report.reasons).toContain('non-reproducible measurement');
    expect(report.ruleLearningEvidence).toBeUndefined();
  });
  it('rejects family aggregate interaction overflow', async () => {
    await expect(evaluateRuleLearning(request, async c => ({ ...await runner(c), interactions: Number.MAX_SAFE_INTEGER }))).rejects.toThrow('overflow');
  });
  it('rejects one regressing family despite two gains', async () => {
    expect((await evaluateRuleLearning(request, async c => ({ ...await runner(c), ...(c.family === 'c' && c.candidateHash === h(1) ? { successes: 4 } : {}) }))).reasons).toContain('family regression');
  });
  it('aborts asynchronous host work at deadline', async () => {
    let signal: AbortSignal | undefined;
    await expect(evaluateRuleLearning({ ...request, timeoutMs: 5 }, async c => { signal = c.signal; return new Promise(() => {}); })).rejects.toThrow('deadline');
    expect(signal?.aborted).toBe(true);
  });
});
