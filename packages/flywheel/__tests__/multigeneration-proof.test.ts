import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { makeSigner } from '../src/receipts.js';
import {
  MULTIGEN_AUTHORITY,
  MULTIGEN_PROOF_VERSION,
  reviewerAttestationPayload,
  verifyMultiGenerationEvidence,
  type GenerationEvidence,
  type MultiGenerationEvidence,
  type ReviewerAttestation,
} from '../src/multigeneration-proof.js';

const digest = (label: string): string => `sha256:${createHash('sha256').update(label).digest('hex')}`;
const budget = { attempts: 20, evaluationCalls: 40, processStarts: 20, tokenCeiling: 200_000, costMicroUsdCeiling: 500_000 };
const probe = (wins: number, best: number, median: number, cost: number) => ({
  budget: { ...budget },
  successfulSuccessors: wins,
  bestSuccessorLift: best,
  medianSuccessorLift: median,
  actualCostMicroUsd: cost,
});
const outcome = (primary: number, costPerWin: number) => ({ primary, costPerWin, safetyViolations: 0, regressions: 0 });
const control = (arm: 'frozen' | 'static' | 'shuffled' | 'previous', primary: number, wins: number) => ({
  arm,
  outcome: outcome(primary, 9),
  improver: probe(wins, 0.04, 0.01, 200_000),
});

const reviewerA = makeSigner();
const reviewerB = makeSigner();
const trustedReviewerKeys = {
  'reviewer:a': reviewerA.publicKey(),
  'reviewer:b': reviewerB.publicKey(),
};

const attest = (runId: string, g: GenerationEvidence): ReviewerAttestation[] => [
  { reviewerId: 'reviewer:a', receipt: reviewerA.sign(reviewerAttestationPayload(runId, g, 'reviewer:a')) },
  { reviewerId: 'reviewer:b', receipt: reviewerB.sign(reviewerAttestationPayload(runId, g, 'reviewer:b')) },
];

const makeEvidence = (evidenceClass: GenerationEvidence['evidenceClass'] = 'synthetic'): MultiGenerationEvidence => {
  const runId = 'run:multigen:fixture';
  const rows = [
    { parentId: 'root', childId: 'g1', baseline: outcome(0.60, 10), child: outcome(0.66, 9), parent: probe(4, 0.06, 0.02, 220_000), next: probe(6, 0.08, 0.03, 220_000) },
    { parentId: 'g1', childId: 'g2', baseline: outcome(0.66, 9), child: outcome(0.72, 8), parent: probe(6, 0.08, 0.03, 220_000), next: probe(8, 0.10, 0.04, 220_000) },
    { parentId: 'g2', childId: 'g3', baseline: outcome(0.72, 8), child: outcome(0.79, 7), parent: probe(8, 0.10, 0.04, 220_000), next: probe(10, 0.12, 0.05, 220_000) },
  ];

  const generations = rows.map((row, index): GenerationEvidence => {
    const g: GenerationEvidence = {
      generation: index + 1,
      parentId: row.parentId,
      childId: row.childId,
      sourceDigest: digest(`source-${index + 1}`),
      selectionSetDigest: digest(`selection-${index + 1}`),
      confirmationSetDigest: digest(`confirmation-${index + 1}`),
      evidenceClass,
      baseline: row.baseline,
      child: row.child,
      parentImprover: row.parent,
      childImprover: row.next,
      controls: [
        control('frozen', row.child.primary - 0.04, Math.max(1, row.next.successfulSuccessors - 3)),
        control('static', row.child.primary - 0.03, Math.max(1, row.next.successfulSuccessors - 3)),
        control('shuffled', row.child.primary - 0.05, Math.max(1, row.next.successfulSuccessors - 4)),
        control('previous', row.child.primary - 0.02, Math.max(1, row.next.successfulSuccessors - 2)),
      ],
      reviewerAttestations: [],
      authority: MULTIGEN_AUTHORITY,
    };
    g.reviewerAttestations = attest(runId, g);
    return g;
  });

  return {
    version: MULTIGEN_PROOF_VERSION,
    runId,
    rootId: 'root',
    gateDigest: digest('gate-v1'),
    createdAt: '2026-09-27T00:00:00Z',
    generations,
    authority: MULTIGEN_AUTHORITY,
  };
};

const expectation = (e: MultiGenerationEvidence) => ({
  runId: e.runId,
  rootId: e.rootId,
  gateDigest: e.gateDigest,
  trustedReviewerKeys,
});

describe('multi-generation improvement proof', () => {
  it('accepts three synthetic generations only as synthetic recursive-improver evidence', () => {
    const e = makeEvidence();
    const verdict = verifyMultiGenerationEvidence(e, expectation(e));
    expect(verdict.pass).toBe(true);
    expect(verdict.proofClass).toBe('SYNTHETIC_RECURSIVE_IMPROVER');
    expect(verdict.recursiveImproverEvidence).toBe(true);
    expect(verdict.independentConfirmation).toBe(false);
    expect(verdict.derived.map((x) => x.improverYieldDelta)).toEqual([
      0.09999999999999998,
      0.10000000000000003,
      0.09999999999999998,
    ]);
  });

  it('rejects an improver plateau even when task capability keeps increasing', () => {
    const e = makeEvidence();
    e.generations[1]!.childImprover.successfulSuccessors = e.generations[1]!.parentImprover.successfulSuccessors;
    e.generations[1]!.reviewerAttestations = attest(e.runId, e.generations[1]!);
    const verdict = verifyMultiGenerationEvidence(e, expectation(e));
    expect(verdict.pass).toBe(false);
    expect(verdict.failures).toContain('gen2:improver_yield_not_improved');
  });

  it('rejects confirmation-set reuse across generations', () => {
    const e = makeEvidence();
    e.generations[2]!.confirmationSetDigest = e.generations[1]!.confirmationSetDigest;
    e.generations[2]!.reviewerAttestations = attest(e.runId, e.generations[2]!);
    const verdict = verifyMultiGenerationEvidence(e, expectation(e));
    expect(verdict.pass).toBe(false);
    expect(verdict.failures).toContain('gen3:confirmation_reused');
  });

  it('rejects insufficient capability lift', () => {
    const e = makeEvidence();
    e.generations[0]!.child.primary = e.generations[0]!.baseline.primary + 0.005;
    e.generations[0]!.reviewerAttestations = attest(e.runId, e.generations[0]!);
    const verdict = verifyMultiGenerationEvidence(e, expectation(e));
    expect(verdict.pass).toBe(false);
    expect(verdict.failures).toContain('gen1:capability_not_improved');
  });

  it('rejects post-attestation tampering', () => {
    const e = makeEvidence();
    e.generations[0]!.child.primary += 0.01;
    const verdict = verifyMultiGenerationEvidence(e, expectation(e));
    expect(verdict.pass).toBe(false);
    expect(verdict.failures).toContain('gen1:insufficient_trusted_reviewers');
  });

  it('requires externally frozen confirmation digests for independent confirmation', () => {
    const e = makeEvidence('independent_confirmation');
    const verdict = verifyMultiGenerationEvidence(e, {
      ...expectation(e),
      sealedConfirmationSetDigests: e.generations.map((g) => g.confirmationSetDigest),
    });
    expect(verdict.pass).toBe(true);
    expect(verdict.proofClass).toBe('INDEPENDENT_CONFIRMATION');
    expect(verdict.independentConfirmation).toBe(true);
  });

  it('does not accept a self-applied independent-confirmation label', () => {
    const e = makeEvidence('independent_confirmation');
    const verdict = verifyMultiGenerationEvidence(e, {
      ...expectation(e),
      sealedConfirmationSetDigests: [digest('wrong-1'), digest('wrong-2'), digest('wrong-3')],
    });
    expect(verdict.independentConfirmation).toBe(false);
    expect(verdict.proofClass).not.toBe('INDEPENDENT_CONFIRMATION');
  });
});
