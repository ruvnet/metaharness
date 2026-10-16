// @metaharness/flywheel — Ed25519 receipts. Every promotion is signed; a receiver VERIFIES the
// signature with the embedded public key. Trust comes from the verifiable signature, not from the
// producer — so a lineage can be replayed and audited with no access to the machine that made it.
import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, type KeyObject } from 'node:crypto';
import type { PromotionReceipt, Signer } from './types.js';

/** No real `PromotionReceipt.payload` this package produces nests more than a handful of levels
 *  (flat score/lineage fields, at most one object-valued field deep) — generous enough to never reject
 *  a legitimate payload, bounded enough to fail fast on a crafted one. See MAX_CANON_DEPTH below. */
const MAX_CANON_DEPTH = 64;

/** Deterministic, sorted-key JSON canonicalization — the exact bytes that get signed.
 *
 * `canon()` is this package's single choke point: `receipts.ts` (sign/verify), `replay.ts`
 * (`sealedFieldsAuthentic`), `multigeneration-proof.ts` (`validAttestation`, prior-child binding), and
 * `review-context.ts` (`packetDigest`) all canonicalize through this one function. Several of those call
 * sites canon() an UNTRUSTED `receipt.payload` directly (no prior shape/depth validation — unlike
 * review-context.ts's own packet fields, which are already bounded by `snapshotRecord`/`snapshotArray`
 * before they ever reach here) and do so with no surrounding try/catch, because `verifyReplayBundle`/
 * `verifyMultiGenerationEvidence` are designed to always return a structured `{pass, failures}` verdict,
 * never throw. Recursing with no depth bound let a crafted payload's nesting exhaust the native call
 * stack instead: an opaque, engine-specific `RangeError` whose trip depth varies with available stack
 * space, not the clean, deterministic rejection those verdict functions otherwise guarantee. Bounding
 * depth here — the one function every caller already goes through — fixes every call site at once rather
 * than adding an ad hoc guard at each of them. */
export function canon(v: unknown, depth = 0): string {
  if (depth > MAX_CANON_DEPTH) {
    throw new Error(`canon: value exceeds max nesting depth (${MAX_CANON_DEPTH}) — refusing to canonicalize`);
  }
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canon(x, depth + 1)).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k], depth + 1)}`).join(',')}}`;
}

/** `canon(a) === canon(b)`, except a value too deep to canonicalize counts as NOT equal rather than
 *  throwing. `replay.ts`'s `sealedFieldsAuthentic` check and `multigeneration-proof.ts`'s prior-child
 *  binding / reviewer-attestation check compare an untrusted `receipt.payload` (or evidence) field
 *  against a live/expected value and are designed to always return a structured verdict, never throw —
 *  a field that cannot be safely canonicalized cannot be confirmed to match, so it must fail the check
 *  it was guarding, the same as any other mismatch, not escape the verdict function as an uncaught error. */
export function canonEquals(a: unknown, b: unknown): boolean {
  try {
    return canon(a) === canon(b);
  } catch {
    return false;
  }
}

/** A per-process Ed25519 signer. For production, wrap a secret-backed or HSM key behind the same
 *  {@link Signer} interface — the flywheel core never sees the private key. */
export function makeSigner(): Signer {
  const kp = generateKeyPairSync('ed25519');
  const pub = (kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
  return {
    publicKey: () => pub,
    sign: (payload: Record<string, unknown>): PromotionReceipt => ({
      payload,
      signature: edSign(null, Buffer.from(canon(payload)), kp.privateKey).toString('base64'),
      publicKey: pub,
      alg: 'ed25519',
    }),
  };
}

/** Independently verify a receipt — recompute canon, check the signature against the EMBEDDED key. */
export function verifyReceipt(r: PromotionReceipt): boolean {
  try {
    const pub: KeyObject = createPublicKey({ key: Buffer.from(r.publicKey, 'base64'), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(canon(r.payload)), pub, Buffer.from(r.signature, 'base64'));
  } catch {
    return false;
  }
}
