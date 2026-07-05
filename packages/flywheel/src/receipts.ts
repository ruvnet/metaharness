// @metaharness/flywheel — Ed25519 receipts. Every promotion is signed; a receiver VERIFIES the
// signature with the embedded public key. Trust comes from the verifiable signature, not from the
// producer — so a lineage can be replayed and audited with no access to the machine that made it.
import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, type KeyObject } from 'node:crypto';
import type { PromotionReceipt, Signer } from './types.js';

/** Deterministic, sorted-key JSON canonicalization — the exact bytes that get signed. */
export function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
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
