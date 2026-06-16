// SPDX-License-Identifier: MIT
//
// Hash-chained receipts (ADR-047 audit layer; the ADR-011 witness substrate made
// first-class in the harness). Every step emits a receipt whose `thisHash` chains
// over the previous receipt's hash, so any tampering or reordering is detectable
// by replaying the chain — `verify()` recomputes every link.

import { createHash } from 'node:crypto';

/** SHA-256 hex of a value's canonical JSON form (stable key order). */
export function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** Deterministic JSON: object keys sorted recursively so hashes are stable. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** A single receipt — the ADR-047 receipt format plus the chaining hashes. */
export interface Receipt {
  runId: string;
  step: string;
  inputHash: string;
  outputHash: string;
  agent: string;
  model: string;
  costUsd: number;
  latencyMs: number;
  verdict: 'pass' | 'fail' | 'gated';
  /** Hash of the previous receipt (genesis = 64 zeros). */
  prevHash: string;
  /** Hash over all of the above; the next receipt chains on this. */
  thisHash: string;
}

const GENESIS = '0'.repeat(64);

/** Fields a caller supplies; the log fills in the hashes. */
export type ReceiptDraft = Omit<Receipt, 'inputHash' | 'outputHash' | 'prevHash' | 'thisHash'> & {
  input: unknown;
  output: unknown;
};

/**
 * An append-only, hash-chained receipt log. Tamper-evident: mutate any field of
 * any receipt and `verify()` reports the first broken link.
 */
export class ReceiptLog {
  private readonly receipts: Receipt[] = [];

  /** Append a receipt, chaining it onto the tail. Returns the stored receipt. */
  append(draft: ReceiptDraft): Receipt {
    const prevHash = this.receipts.length ? this.receipts[this.receipts.length - 1].thisHash : GENESIS;
    const body = {
      runId: draft.runId,
      step: draft.step,
      inputHash: hash(draft.input),
      outputHash: hash(draft.output),
      agent: draft.agent,
      model: draft.model,
      costUsd: draft.costUsd,
      latencyMs: draft.latencyMs,
      verdict: draft.verdict,
      prevHash,
    };
    const receipt: Receipt = { ...body, thisHash: hash(body) };
    this.receipts.push(receipt);
    return receipt;
  }

  /** Every receipt, in order. */
  entries(): readonly Receipt[] {
    return this.receipts;
  }

  /** Total recorded spend. */
  totalCostUsd(): number {
    return this.receipts.reduce((s, r) => s + r.costUsd, 0);
  }

  /**
   * Replay the chain. Returns `{ ok: true }` if every link recomputes and the
   * genesis links to zeros; otherwise the 0-based index of the first bad receipt.
   */
  verify(): { ok: true } | { ok: false; brokenAt: number; reason: string } {
    let prevHash = GENESIS;
    for (let i = 0; i < this.receipts.length; i++) {
      const r = this.receipts[i];
      if (r.prevHash !== prevHash) {
        return { ok: false, brokenAt: i, reason: 'prevHash does not chain' };
      }
      const { thisHash, ...body } = r;
      if (hash(body) !== thisHash) {
        return { ok: false, brokenAt: i, reason: 'thisHash does not match body' };
      }
      prevHash = thisHash;
    }
    return { ok: true };
  }
}
