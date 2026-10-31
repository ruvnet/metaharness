// @metaharness/avo — `canonical()`'s recursion-depth bound and non-finite-number rejection.
//
// `canonical()` (crypto.ts) is this package's own independent canonicalization primitive — it is
// NOT the same function as `@metaharness/flywheel`'s `canon()`, just the same algorithm reimplemented
// here because AVO signs its own Ed25519 `ActionReceipt`/`VariationCheckpoint` trust chain
// (`sha256`/`transitionHash`/`checkpointHash`/`verifyReceipt`/`verifyVariationCheckpoint`, all reachable
// from `GovernedVariationOperator.run()` on every action). `flywheel/receipts.ts`'s `canon()` was
// hardened against two gaps on 2026-10-16 (unbounded recursion depth) and 2026-10-21 (NaN/Infinity/
// -Infinity collapsing to the same `"null"` token as `JSON.stringify` produces for real `null`,
// letting a non-finite value be swapped for `null` in a signed field undetected). Because `canonical()`
// is a separate implementation, not a shared import, it carried both gaps independently and was
// unaffected by either prior fix. This test proves the ported fix, not just "didn't crash" — a version
// that silently accepted unbounded nesting or collapsed NaN/Infinity to null would also "not crash."
import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  canonical,
  sha256,
  transitionHash,
  checkpointHash,
  verifyReceipt,
  verifyVariationCheckpoint,
  createCheckpoint,
  Ed25519ReceiptSigner,
  type ActionReceipt,
  type VariationCheckpoint,
  type VariationState,
} from '../src/index.js';

function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return new Ed25519ReceiptSigner('test-key', privateKey, publicKey);
}

function deepNest(n: number): unknown {
  let o: unknown = { leaf: true };
  for (let i = 0; i < n; i++) o = { next: o };
  return o;
}

describe('canonical() — recursion-depth bound', () => {
  it('canonicalizes normal, shallow values exactly as before (byte-identical)', () => {
    expect(canonical({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonical([1, 2, { a: 1 }])).toBe('[1,2,{"a":1}]');
    expect(canonical(undefined)).toBe('null');
    expect(canonical({ a: 1, b: undefined })).toBe('{"a":1}');
  });
  it('still canonicalizes a reasonably-nested value (well under the bound), deterministically', () => {
    expect(canonical(deepNest(20))).toBe(canonical(deepNest(20)));
  });
  it('throws a clear, bounded Error — not a native stack overflow — past the depth limit', () => {
    expect(() => canonical(deepNest(100_000))).toThrow(/exceeds max nesting depth/);
  });
});

describe('canonical() — non-finite numbers', () => {
  it('BASELINE BUG (documented, now fixed): NaN/Infinity no longer collide with null', () => {
    // Pre-fix, `canonical(NaN) === canonical(null) === canonical(undefined) === 'null'` — a live field
    // tampered between a non-finite value and null/undefined was undetectable by comparing canonical
    // strings. Post-fix each throws distinctly instead of silently encoding to the same token.
    expect(canonical(null)).toBe('null');
    expect(() => canonical(NaN)).toThrow(/non-finite numbers/);
    expect(() => canonical(Infinity)).toThrow(/non-finite numbers/);
    expect(() => canonical(-Infinity)).toThrow(/non-finite numbers/);
  });
  it('rejects a non-finite number nested inside an object or array', () => {
    expect(() => canonical({ quality: NaN })).toThrow(/non-finite numbers/);
    expect(() => canonical([1, Infinity, 3])).toThrow(/non-finite numbers/);
  });
  it('sha256()/transitionHash()/checkpointHash() all propagate the rejection', () => {
    expect(() => sha256({ x: NaN })).toThrow(/non-finite numbers/);
    expect(() =>
      transitionHash({
        previousStateHash: 'genesis',
        action: 'noop' as unknown as never,
        observation: { ok: true, durationMs: 1, costUsd: NaN, workspaceDigest: 'd' },
        policyDecision: { verdict: 'allow', reason: 'r', policyVersion: 'v1', riskCharge: 0 },
        workspaceDigest: 'd',
      }),
    ).toThrow(/non-finite numbers/);
    expect(() => checkpointHash({ schema: 1, runtimeVersion: NaN as unknown as string, policyVersion: 'v', evaluatorVersion: 'v', state: {} as unknown as VariationState, signer: 's' })).toThrow(/non-finite numbers/);
  });
});

describe('verifyReceipt() stays fail-closed on an uncanonicalizable receipt', () => {
  it('returns false, never throws, when the observation carries a non-finite value', () => {
    const s = signer();
    const receipt: ActionReceipt = {
      sequence: 1,
      previousStateHash: 'genesis',
      stateHash: 'genesis', // deliberately wrong/irrelevant — canonicalization fails before this is reached
      action: 'noop' as unknown as never,
      observation: { ok: true, durationMs: 1, costUsd: NaN, workspaceDigest: 'd' },
      policyDecision: { verdict: 'allow', reason: 'r', policyVersion: 'v1', riskCharge: 0 },
      workspaceDigest: 'd',
      costUsd: NaN,
      signature: s.sign('genesis'),
      signer: s.id,
    };
    expect(() => verifyReceipt(receipt, s)).not.toThrow();
    expect(verifyReceipt(receipt, s)).toBe(false);
  });
  it('returns false, never throws, on a receipt deep enough to exceed the canonicalization bound', () => {
    const s = signer();
    const receipt: ActionReceipt = {
      sequence: 1,
      previousStateHash: 'genesis',
      stateHash: 'genesis',
      action: 'noop' as unknown as never,
      observation: { ok: true, durationMs: 1, costUsd: 0, workspaceDigest: 'd', data: deepNest(100_000) },
      policyDecision: { verdict: 'allow', reason: 'r', policyVersion: 'v1', riskCharge: 0 },
      workspaceDigest: 'd',
      costUsd: 0,
      signature: s.sign('genesis'),
      signer: s.id,
    };
    expect(() => verifyReceipt(receipt, s)).not.toThrow();
    expect(verifyReceipt(receipt, s)).toBe(false);
  });
  it('still verifies a genuinely authentic, finite, shallow receipt as true (no false rejections)', () => {
    const s = signer();
    const observation = { ok: true, durationMs: 1, costUsd: 0.01, workspaceDigest: 'd' } as const;
    const policyDecision = { verdict: 'allow', reason: 'r', policyVersion: 'v1', riskCharge: 0 } as const;
    const stateHash = transitionHash({ previousStateHash: 'genesis', action: 'noop' as unknown as never, observation, policyDecision, workspaceDigest: 'd' });
    const receipt: ActionReceipt = {
      sequence: 1,
      previousStateHash: 'genesis',
      stateHash,
      action: 'noop' as unknown as never,
      observation,
      policyDecision,
      workspaceDigest: 'd',
      costUsd: 0.01,
      signature: s.sign(stateHash),
      signer: s.id,
    };
    expect(verifyReceipt(receipt, s)).toBe(true);
  });
});

describe('verifyVariationCheckpoint() stays fail-closed on an uncanonicalizable checkpoint', () => {
  it('returns false, never throws, when the checkpointed state carries a non-finite value', () => {
    const s = signer();
    const checkpoint: VariationCheckpoint = {
      schema: 1,
      runtimeVersion: '0.1.0',
      policyVersion: 'v1',
      evaluatorVersion: 'v1',
      state: { corrupt: NaN } as unknown as VariationState,
      checkpointHash: 'irrelevant',
      signature: s.sign('irrelevant'),
      signer: s.id,
    };
    expect(() => verifyVariationCheckpoint(checkpoint, s)).not.toThrow();
    expect(verifyVariationCheckpoint(checkpoint, s)).toBe(false);
  });
  it('still verifies a genuine checkpoint built by createCheckpoint() as true (no false rejections)', () => {
    const s = signer();
    const checkpoint = createCheckpoint({
      runtimeVersion: '0.1.0',
      policyVersion: 'v1',
      evaluatorVersion: 'v1',
      state: { schema: 1, runId: 'r1' } as unknown as VariationState,
      signer: s,
    });
    expect(verifyVariationCheckpoint(checkpoint, s)).toBe(true);
  });
});
