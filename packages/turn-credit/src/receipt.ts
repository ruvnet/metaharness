// @metaharness/turn-credit — receipt payload (ADR-248 §6). Everything an auditor
// needs to re-check a credit assignment, shaped to drop straight into the signed
// receipt seams that already exist: the flywheel's Ed25519 `Signer.sign(payload)`
// (payload is an open bag) or a harness ReceiptLog step. This module builds the
// payload and its digests; SIGNING stays where the keys live — in the caller.

import { createHash } from 'node:crypto';
import type { TrajectoryCredit } from './types.js';

/** Deterministic, sorted-key JSON canonicalization — the exact bytes digested.
 *  (Same algorithm as the flywheel's `canon`; duplicated locally so this package
 *  stays dependency-free and phase-1.) */
export function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

export function digest(v: unknown): string {
  return createHash('sha256').update(canon(v)).digest('hex');
}

export interface CreditReceiptInput {
  credit: TrajectoryCredit;
  /** Version of the verifier that produced the terminal outcome (and, in proxy
   *  mode, the with/without scores). Required — an unversioned verifier cannot
   *  be audited. */
  verifierVersion: string;
  /** The retrieved privileged context (skill / prior pattern) given to the
   *  teacher pass — digested, never embedded, so receipts stay small and the
   *  context itself can live in RuVector. */
  retrievedEvidence: unknown;
  /** The raw recorded trajectory that was scored — digested for tamper-evidence. */
  trajectory: unknown;
}

/** The audit record: belief revisions, pivotal turns, outcome alignment, bounded
 *  weights, verifier version, and content digests. Feed to `Signer.sign()`. */
export function buildCreditReceiptPayload(input: CreditReceiptInput): Record<string, unknown> {
  const { credit } = input;
  return {
    schema: 'turn-credit-receipt/v1',
    mode: credit.mode,
    proxy: credit.proxy,
    verifierVersion: input.verifierVersion,
    prior: credit.prior,
    advantage: credit.advantage,
    outcomeSign: credit.outcomeSign,
    boundPct: credit.boundPct,
    config: { ...credit.config },
    beliefRevisions: credit.steps.map((s) => ({ turn: s.turn, belief: s.belief, revision: s.revision })),
    boundedWeights: credit.credits.map((c) => ({ turn: c.turn, weight: c.weight, multiplier: c.multiplier })),
    pivotalTurns: [...credit.pivotalTurns],
    evidenceDigest: digest(input.retrievedEvidence),
    trajectoryDigest: digest(input.trajectory),
    creditDigest: digest(credit),
  };
}
