// @metaharness/turn-credit — tests (ADR-248). The claims under test are the
// paper's invariants, not vibes: the recursion matches its closed form, the
// prior clip keeps unanimous groups finite, reshaping is bounded and
// sign-preserving, the governed preset caps modulation at ±10%, pivotal turns
// are the large belief revisions, proxy mode is labelled, and everything is
// byte-deterministic.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GOVERNED_DEFAULTS,
  PAPER_DEFAULTS,
  advantageFromOutcome,
  attributeMutation,
  beliefTrajectory,
  buildCreditReceiptPayload,
  clipPrior,
  creditByLabel,
  digest,
  evidenceFromLogProbs,
  evidenceFromScorePairs,
  logit,
  processTrajectory,
  reshapedAdvantage,
  sigmoid,
  toMemoryFeedback,
  toQualityLabels,
} from '../src/index.js';
import { dispatch } from '../src/cli.js';
import type { TrajectoryCredit, TurnEvidence } from '../src/types.js';

const EV = (values: number[], labels?: string[]): TurnEvidence[] =>
  values.map((evidence, i) => ({ turn: i + 1, evidence, ...(labels?.[i] ? { label: labels[i] } : {}) }));

describe('belief recursion', () => {
  it('matches the closed form B_k = sigmoid(logit(B0) + c_k) with decayed accumulation', () => {
    const gamma = 0.95;
    const prior = 0.25;
    const evidence = EV([0.4, -0.2, 0.7]);
    const steps = beliefTrajectory(evidence, prior, gamma);
    let c = 0;
    let prev = prior;
    for (const [i, s] of steps.entries()) {
      c = gamma * c + evidence[i].evidence;
      const expected = sigmoid(logit(prior) + c);
      expect(s.belief).toBeCloseTo(expected, 6);
      expect(s.revision).toBeCloseTo(expected - prev, 6);
      prev = expected;
    }
  });

  it('gamma=1 accumulates without decay; gamma<1 discounts old evidence', () => {
    const evidence = EV([1, 0, 0, 0]);
    const noDecay = beliefTrajectory(evidence, 0.5, 1.0);
    const decayed = beliefTrajectory(evidence, 0.5, 0.8);
    expect(noDecay[3].belief).toBeCloseTo(noDecay[0].belief, 6);
    expect(decayed[3].belief).toBeLessThan(decayed[0].belief);
  });

  it('clipPrior keeps log-odds finite for unanimous groups (R=0 and R=1)', () => {
    expect(Number.isFinite(logit(clipPrior(0, 1e-4)))).toBe(true);
    expect(Number.isFinite(logit(clipPrior(1, 1e-4)))).toBe(true);
    expect(clipPrior(0, 1e-4)).toBe(1e-4);
    expect(clipPrior(1, 1e-4)).toBe(1 - 1e-4);
  });
});

describe('outcome alignment + bounded reshaping', () => {
  const run = (success: boolean, config = PAPER_DEFAULTS) =>
    processTrajectory({
      evidence: EV([0.5, -0.3, 1.2, 0.1, -0.8]),
      mode: 'logprob-gap',
      prior: 0.3,
      success,
      config,
    });

  it('credits flip sign on failed trajectories (q_k = sign(A)·dB_k)', () => {
    const ok = run(true);
    const bad = run(false);
    expect(ok.outcomeSign).toBe(1);
    expect(bad.outcomeSign).toBe(-1);
    for (const [i, c] of ok.credits.entries()) {
      expect(c.credit).toBeCloseTo(c.revision, 6);
      expect(bad.credits[i].credit).toBeCloseTo(-bad.credits[i].revision, 6);
    }
  });

  it('weights stay in [1−b, 1+b] and multipliers in [1−λb, 1+λb]; sign(A) is preserved', () => {
    const r = run(true);
    const { bound, mix } = PAPER_DEFAULTS;
    for (const c of r.credits) {
      expect(c.weight).toBeGreaterThanOrEqual(1 - bound);
      expect(c.weight).toBeLessThanOrEqual(1 + bound);
      expect(c.multiplier).toBeGreaterThanOrEqual(1 - mix * bound - 1e-9);
      expect(c.multiplier).toBeLessThanOrEqual(1 + mix * bound + 1e-9);
      expect(Math.sign(reshapedAdvantage(r.advantage, c))).toBe(Math.sign(r.advantage));
    }
    expect(r.boundPct).toBeCloseTo(mix * bound, 6);
  });

  it('GOVERNED_DEFAULTS cap modulation at ±10%', () => {
    const r = run(true, GOVERNED_DEFAULTS);
    expect(r.boundPct).toBeCloseTo(0.1, 6);
    for (const c of r.credits) {
      expect(Math.abs(c.multiplier - 1)).toBeLessThanOrEqual(0.1 + 1e-9);
    }
  });

  it('zero advantage yields neutral sign and no positive credits', () => {
    const r = processTrajectory({
      evidence: EV([0.5, -0.5]),
      mode: 'logprob-gap',
      prior: 0.5,
      advantage: 0,
    });
    expect(r.outcomeSign).toBe(0);
    for (const c of r.credits) expect(c.credit).toBe(0);
  });
});

describe('pivotal turns', () => {
  it('a single large evidence spike is identified as pivotal', () => {
    const r = processTrajectory({
      evidence: EV([0.05, 0.02, 2.5, 0.03, 0.01]),
      mode: 'logprob-gap',
      prior: 0.3,
      success: true,
    });
    expect(r.pivotalTurns).toContain(3);
    expect(r.pivotalTurns).not.toContain(2);
    expect(r.credits.find((c) => c.turn === 3)?.pivotal).toBe(true);
  });

  it('flat evidence marks nothing pivotal beyond the shared maximum band', () => {
    const r = processTrajectory({
      evidence: EV([0, 0, 0]),
      mode: 'logprob-gap',
      prior: 0.5,
      success: true,
    });
    expect(r.pivotalTurns).toEqual([]);
  });
});

describe('evidence construction', () => {
  it('logprob mode sums per-token gaps; mismatched token counts throw', () => {
    const [e] = evidenceFromLogProbs([
      { turn: 1, withContext: [-0.1, -0.2], withoutContext: [-0.4, -0.5] },
    ]);
    expect(e.evidence).toBeCloseTo(0.6, 6);
    expect(() =>
      evidenceFromLogProbs([{ turn: 1, withContext: [-0.1], withoutContext: [-0.1, -0.2] }]),
    ).toThrow(/token counts differ/);
  });

  it('verifier-delta pairs become scaled evidence and the result is labelled proxy', () => {
    const evidence = evidenceFromScorePairs(
      [{ turn: 1, scoreWith: 0.8, scoreWithout: 0.6, label: 'tool:grep' }],
      0.5,
    );
    expect(evidence[0].evidence).toBeCloseTo(0.1, 6);
    expect(evidence[0].label).toBe('tool:grep');
    const r = processTrajectory({ evidence, mode: 'verifier-delta-proxy', prior: 0.4, success: true });
    expect(r.proxy).toBe(true);
    expect(r.mode).toBe('verifier-delta-proxy');
  });

  it('advantageFromOutcome is the GRPO-style group-mean baseline', () => {
    expect(advantageFromOutcome(true, 0.3)).toBeCloseTo(0.7, 6);
    expect(advantageFromOutcome(false, 0.3)).toBeCloseTo(-0.3, 6);
  });
});

describe('adapters', () => {
  const labelled = () =>
    processTrajectory({
      evidence: EV([0.6, -0.2, 1.4, 0.1], ['route:cheap', 'retry', 'tool:edit', 'retry']),
      mode: 'logprob-gap',
      prior: 0.3,
      success: true,
    });

  it('creditByLabel aggregates credit per decision label, sorted by total credit', () => {
    const byLabel = creditByLabel(labelled());
    expect(byLabel.map((l) => l.label)).toContain('tool:edit');
    expect(byLabel.find((l) => l.label === 'retry')?.turns).toBe(2);
    const totals = byLabel.map((l) => l.totalCredit);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
  });

  it('attributeMutation reports per-label deltas and whether the mutated surface improved', () => {
    const parent = labelled();
    const child = processTrajectory({
      evidence: EV([0.6, 0.9, 1.4, 0.1], ['route:cheap', 'retry', 'tool:edit', 'retry']),
      mode: 'logprob-gap',
      prior: 0.3,
      success: true,
    });
    const attr = attributeMutation(parent, child, 'retry');
    const retry = attr.labelDeltas.find((l) => l.label === 'retry');
    expect(retry).toBeDefined();
    expect(attr.surfaceImproved).toBe(retry!.delta > 0);
  });

  it('toQualityLabels maps multipliers onto [0,1]', () => {
    for (const q of toQualityLabels(labelled())) {
      expect(q.quality).toBeGreaterThanOrEqual(0);
      expect(q.quality).toBeLessThanOrEqual(1);
    }
  });

  it('toMemoryFeedback emits credit-weighted records only for turns with retrievals', () => {
    const r = labelled();
    const fb = toMemoryFeedback(r, new Map([[1, ['skill-a']], [3, ['skill-b', 'skill-c']]]));
    expect(fb).toHaveLength(2);
    for (const f of fb) {
      expect(f.resolved).toBe(true);
      expect(f.weight).toBeGreaterThan(0);
    }
  });
});

describe('receipts + determinism', () => {
  const input = {
    evidence: EV([0.5, -0.3, 1.2]),
    mode: 'verifier-delta-proxy' as const,
    prior: 0.3,
    success: true,
  };

  it('re-processing the same trace is byte-identical (canonical digest match)', () => {
    expect(digest(processTrajectory(input))).toBe(digest(processTrajectory(input)));
  });

  it('receipt payload carries revisions, weights, pivotal turns, proxy flag, and digests', () => {
    const credit = processTrajectory(input);
    const payload = buildCreditReceiptPayload({
      credit,
      verifierVersion: 'verifier@1.2.3',
      retrievedEvidence: { skill: 'unlock-then-open' },
      trajectory: { steps: ['a', 'b', 'c'] },
    });
    expect(payload.schema).toBe('turn-credit-receipt/v1');
    expect(payload.proxy).toBe(true);
    expect(payload.verifierVersion).toBe('verifier@1.2.3');
    expect(payload.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.trajectoryDigest).toMatch(/^[0-9a-f]{64}$/);
    expect((payload.beliefRevisions as unknown[]).length).toBe(3);
    // A tampered trajectory changes the digest — the tamper-evidence claim.
    const tampered = buildCreditReceiptPayload({
      credit,
      verifierVersion: 'verifier@1.2.3',
      retrievedEvidence: { skill: 'unlock-then-open' },
      trajectory: { steps: ['a', 'b', 'X'] },
    });
    expect(tampered.trajectoryDigest).not.toBe(payload.trajectoryDigest);
  });
});

describe('cli dispatch', () => {
  it('process + report round-trip on a score-pair input file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-credit-'));
    const inPath = join(dir, 'input.json');
    const outPath = join(dir, 'credit.json');
    writeFileSync(
      inPath,
      JSON.stringify({
        prior: 0.3,
        success: true,
        turns: [
          { turn: 1, label: 'route:cheap', scoreWith: 0.7, scoreWithout: 0.5 },
          { turn: 2, label: 'tool:edit', scoreWith: 0.9, scoreWithout: 0.2 },
        ],
      }),
    );
    const p = await dispatch('process', [inPath, '--out', outPath, '--governed']);
    expect(p.code).toBe(0);
    expect(p.lines.join('\n')).toContain('PROXY');
    expect(p.lines.join('\n')).toContain('±10%');
    const credit = JSON.parse(readFileSync(outPath, 'utf-8')) as TrajectoryCredit;
    expect(credit.schema).toBe('turn-credit/v1');
    const r = await dispatch('report', [outPath]);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toContain('tool:edit');
  });

  it('unknown verb prints usage with a non-zero code', async () => {
    const r = await dispatch('nope', []);
    expect(r.code).toBe(2);
    expect(r.lines[0]).toContain('turn-credit');
  });
});
