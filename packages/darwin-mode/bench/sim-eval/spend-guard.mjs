// SPDX-License-Identifier: MIT
//
// Hard real-money cap for the #523 sealed SIM evaluation. Pure apart from an
// append-only JSONL ledger, so smoke runs, crashes and restarts all count
// toward the same cap. Shared by every concurrent run in one process:
//
//   reserve(worst-case)  — refuses (throws SpendCapError) BEFORE the call if
//                          spent + outstanding reservations + this one > cap.
//   settle(r, actual)    — records the provider-reported cost; a missing or
//                          non-finite cost is charged at the reservation, never 0.
//   release(r)           — a call that never reached the provider (no request
//                          sent) frees its reservation and charges nothing.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export class SpendCapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpendCapError';
    this.code = 'SIM_EVAL_SPEND_CAP';
  }
}

/** Parse a cap; refuse NaN/negative/infinite so a malformed flag cannot disable it. */
export function parseCap(raw) {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`spend cap must be a finite positive USD amount, got ${JSON.stringify(raw)}`);
  return n;
}

/** Worst-case USD for one chat call: every input char a token (conservative) and max output. */
export function worstCaseUsd({ promptChars, maxTokens, inPerM, outPerM }) {
  for (const [k, v] of Object.entries({ promptChars, maxTokens, inPerM, outPerM })) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`worstCaseUsd: ${k} must be finite and >= 0`);
  }
  return (promptChars * inPerM + maxTokens * outPerM) / 1e6;
}

export class SpendGuard {
  /**
   * @param {{ capUsd: number, ledgerPath?: string|null, now?: () => string }} opts
   */
  constructor({ capUsd, ledgerPath = null, now = () => new Date().toISOString() }) {
    this.capUsd = parseCap(capUsd);
    this.ledgerPath = ledgerPath;
    this.now = now;
    this.spentUsd = 0;
    this.outstandingUsd = 0;
    this.calls = 0;
    this.unpricedCalls = 0;
    this.nextId = 1;
    this.open = new Map();
    if (ledgerPath && existsSync(ledgerPath)) {
      for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { throw new Error(`spend ledger corrupt: ${ledgerPath}`); }
        if (!Number.isFinite(row.chargedUsd) || row.chargedUsd < 0) throw new Error(`spend ledger row has invalid chargedUsd: ${line}`);
        this.spentUsd += row.chargedUsd;
        this.calls += 1;
      }
    }
  }

  remainingUsd() {
    return this.capUsd - this.spentUsd - this.outstandingUsd;
  }

  /** Reserve worst-case spend before a call; throws when it would exceed the cap. */
  reserve(usd, meta = {}) {
    if (!Number.isFinite(usd) || usd <= 0) throw new Error('reserve: worst-case USD must be finite and > 0');
    if (this.spentUsd + this.outstandingUsd + usd > this.capUsd) {
      throw new SpendCapError(
        `spend cap $${this.capUsd.toFixed(2)} would be exceeded: spent $${this.spentUsd.toFixed(4)}, ` +
        `outstanding $${this.outstandingUsd.toFixed(4)}, next call worst case $${usd.toFixed(4)}`,
      );
    }
    const id = this.nextId++;
    this.open.set(id, { usd, meta });
    this.outstandingUsd += usd;
    return id;
  }

  /** Settle with the provider-reported cost; non-finite/negative ⇒ charge the reservation. */
  settle(id, actualUsd, extra = {}) {
    const r = this.open.get(id);
    if (!r) throw new Error(`settle: unknown reservation ${id}`);
    this.open.delete(id);
    this.outstandingUsd -= r.usd;
    const priced = Number.isFinite(actualUsd) && actualUsd >= 0;
    const charged = priced ? actualUsd : r.usd;
    if (!priced) this.unpricedCalls += 1;
    this.spentUsd += charged;
    this.calls += 1;
    if (this.ledgerPath) {
      appendFileSync(this.ledgerPath, JSON.stringify({
        ts: this.now(), ...r.meta, ...extra, reservedUsd: r.usd, reportedUsd: priced ? actualUsd : null, chargedUsd: charged,
      }) + '\n');
    }
    return charged;
  }

  /** The request was never sent; free the reservation. */
  release(id) {
    const r = this.open.get(id);
    if (!r) return;
    this.open.delete(id);
    this.outstandingUsd -= r.usd;
  }

  snapshot() {
    return {
      capUsd: this.capUsd, spentUsd: Number(this.spentUsd.toFixed(6)),
      outstandingUsd: Number(this.outstandingUsd.toFixed(6)), calls: this.calls, unpricedCalls: this.unpricedCalls,
    };
  }
}
