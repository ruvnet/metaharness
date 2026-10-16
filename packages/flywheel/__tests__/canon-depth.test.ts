// @metaharness/flywheel — canon()'s recursion-depth bound.
//
// `canon()` is this package's single choke point: `receipts.ts` (sign/verify), `replay.ts`
// (`sealedFieldsAuthentic`), and `multigeneration-proof.ts` (reviewer-attestation check, prior-child
// binding, the final evidence digest) all canonicalize through it. Several of those call sites
// canon() an UNTRUSTED `receipt.payload` (or evidence field) directly, with no prior depth validation
// and no surrounding try/catch — because `verifyReplayBundle`/`verifyMultiGenerationEvidence` are
// designed to always return a structured `{pass, failures}` verdict, never throw. With no depth bound,
// a crafted deeply-nested field exhausted the native call stack instead: an opaque, engine-specific
// RangeError, not the clean, deterministic rejection those verdict functions otherwise guarantee. Every
// case below proves the FIX (a clean rejection), not just "didn't crash" — a version that silently
// accepted unbounded nesting would also "not crash."
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { canon, canonEquals, makeSigner, verifyReceipt, verifyReplayBundle, type ReplayBundle, type PromotionReceipt } from '../src/index.js';
import {
  MULTIGEN_AUTHORITY,
  MULTIGEN_PROOF_VERSION,
  verifyMultiGenerationEvidence,
  type GenerationEvidence,
  type MultiGenerationEvidence,
} from '../src/multigeneration-proof.js';

function deepNest(n: number): unknown {
  let o: unknown = { leaf: true };
  for (let i = 0; i < n; i++) o = { next: o };
  return o;
}

describe('canon() — recursion-depth bound', () => {
  it('canonicalizes normal, shallow values exactly as before (byte-identical)', () => {
    expect(canon({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canon([1, 2, { a: 1 }])).toBe('[1,2,{"a":1}]');
  });
  it('still canonicalizes a reasonably-nested value (well under the bound), deterministically', () => {
    expect(canon(deepNest(20))).toBe(canon(deepNest(20)));
  });
  it('throws a clear, bounded Error — not a native stack overflow — past the depth limit', () => {
    expect(() => canon(deepNest(100_000))).toThrow(/exceeds max nesting depth/);
  });
});

describe('canonEquals() — fail-closed comparison', () => {
  it('matches canon(a) === canon(b) for normal values', () => {
    expect(canonEquals({ a: 1 }, { a: 1 })).toBe(true);
    expect(canonEquals({ a: 1 }, { a: 2 })).toBe(false);
  });
  it('returns false, never throws, when either side exceeds the depth bound', () => {
    expect(canonEquals(deepNest(100_000), { a: 1 })).toBe(false);
    expect(canonEquals({ a: 1 }, deepNest(100_000))).toBe(false);
  });
});

describe('verifyReceipt() stays fail-closed on an over-deep payload', () => {
  it('returns false, not throw, for a receipt whose payload cannot be canonicalized', () => {
    const signer = makeSigner();
    const receipt = signer.sign({ kind: 'test' }) as PromotionReceipt;
    (receipt as { payload: unknown }).payload = deepNest(100_000);
    expect(verifyReceipt(receipt)).toBe(false);
  });
});

describe('verifyReplayBundle() — the exact crash this candidate closes', () => {
  const validReceipt = (): PromotionReceipt =>
    ({ payload: { kind: 'root', root: 'root' }, signature: 'sig', publicKey: 'pk', alg: 'ed25519' });

  it('rejects a crafted deeply-nested receipt.payload field as sealedFieldsAuthentic, never throws', () => {
    const bundle: ReplayBundle = {
      data_source: 'SYNTHETIC',
      root_id: 'root',
      chain: [
        { id: 'root', generation: 0, parents: [], mutation: null, primaryDelta: 0, anchorScore: null, verdict: 'ROOT', failureReasons: [], receipt: validReceipt(), createdAt: 'g0' },
        {
          id: 'c1', generation: 1, parents: ['root'], mutation: { target: 't', summary: 's' }, primaryDelta: 1,
          anchorScore: null, verdict: 'PROMOTED', failureReasons: [],
          receipt: { payload: { kind: 'candidate', id: 'c1', verdict: 'PROMOTED', failureReasons: deepNest(100_000) }, signature: 'sig', publicKey: 'pk', alg: 'ed25519' },
          createdAt: 'g1',
        },
      ],
      all_commits: [],
      lift_curve: [],
      gate_fingerprint: null,
      verified_improvements: 1,
      anchor_surviving_improvements: 0,
      milestone_reached: false,
      created_at: 'g1',
    };
    bundle.all_commits = bundle.chain;

    let verdict: ReturnType<typeof verifyReplayBundle> | undefined;
    expect(() => { verdict = verifyReplayBundle(bundle); }).not.toThrow();
    expect(verdict!.pass).toBe(false);
    expect(verdict!.failures).toContain('sealedFieldsAuthentic');
  });
});

describe('verifyMultiGenerationEvidence() — the exact crash this candidate closes', () => {
  const digest = (label: string) => `sha256:${createHash('sha256').update(label).digest('hex')}`;
  const budget = { attempts: 20, evaluationCalls: 40, processStarts: 20, tokenCeiling: 200_000, costMicroUsdCeiling: 500_000 };
  const probe = (wins: number, best: number, median: number, cost: number) =>
    ({ budget: { ...budget }, successfulSuccessors: wins, bestSuccessorLift: best, medianSuccessorLift: median, actualCostMicroUsd: cost });
  const outcome = (primary: number, costPerWin: number) => ({ primary, costPerWin, safetyViolations: 0, regressions: 0 });

  it('fails closed (undigestable_evidence) instead of throwing when a generation smuggles a deeply-nested extra field', () => {
    // `validOutcome()` only checks the 4 NAMED Outcome fields are valid numbers — it never rejects an
    // object for carrying extra keys. `coreGeneration()` spreads the whole GenerationEvidence (minus
    // reviewerAttestations) into the unconditional final evidenceDigest computation, so an extra,
    // deeply-nested key on `child` sails past every named-field check and still reaches canon().
    const child = { ...outcome(0.6, 9), extra: deepNest(100_000) };
    const g: GenerationEvidence = {
      generation: 1,
      parentId: 'root',
      childId: 'g1',
      sourceDigest: digest('source-1'),
      selectionSetDigest: digest('selection-1'),
      confirmationSetDigest: digest('confirmation-1'),
      evidenceClass: 'synthetic',
      baseline: outcome(0.5, 10),
      child: child as unknown as GenerationEvidence['child'],
      parentImprover: probe(4, 0.06, 0.02, 220_000),
      childImprover: probe(6, 0.08, 0.03, 220_000),
      controls: [],
      reviewerAttestations: [],
      authority: MULTIGEN_AUTHORITY,
    };
    const e: MultiGenerationEvidence = {
      version: MULTIGEN_PROOF_VERSION,
      runId: 'run:canon-depth-fixture',
      rootId: 'root',
      gateDigest: digest('gate-v1'),
      createdAt: '2026-10-16T00:00:00Z',
      generations: [g],
      authority: MULTIGEN_AUTHORITY,
    };
    const expectation = { runId: e.runId, rootId: e.rootId, gateDigest: e.gateDigest, trustedReviewerKeys: {} };

    let verdict: ReturnType<typeof verifyMultiGenerationEvidence> | undefined;
    expect(() => { verdict = verifyMultiGenerationEvidence(e, expectation); }).not.toThrow();
    expect(verdict!.pass).toBe(false);
    expect(verdict!.failures).toContain('undigestable_evidence');
  });
});
