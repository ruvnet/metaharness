// @metaharness/flywheel — the ONE fail-closed runtime boundary for untrusted `ReplayBundle` JSON.
//
// `loadBundle()` in cli.ts (shared by the `graph`, `analyze`, and `replay` verbs) parses caller-supplied
// JSON as `ReplayBundle` with a bare type assertion — TypeScript's type system does not run at runtime,
// so nothing previously stopped a bundle whose numeric fields are `NaN`/`Infinity`/`null`/a string/an
// object from reaching `graph`'s bar-rendering, `analyzeBundle`'s arithmetic, or `verifyReplayBundle`'s
// gate re-execution. `graph`'s 2026-09-21 RangeError fix closed the ONE reachable crash from a legitimate
// negative-but-finite `primary`; it did not close the wider gap a hostile or corrupted bundle exposes:
// `NaN`/`Infinity` propagate silently through arithmetic (no crash, no error — just wrong, unflagged
// numbers), and `analyzeBundle` can report "promoted" evidence built from exactly that nonfinite data
// with no indication anything was wrong. This module is the single validation choke point: reject before
// any of the three verbs touch the bundle, with a clear message and a non-zero exit (via bin.ts's
// existing catch-and-exit-1 convention for a thrown Error), rather than degrade or coerce.
import type { LineageCommit, LiftPoint, ReplayBundle, Score } from './types.js';

/** Numeric fields are domain values (a score, a generation index, a delta) — not IDs or opaque data, so a
 *  sane upper bound also rejects "technically finite but not a plausible ReplayBundle" numbers (e.g. a
 *  corrupted field that decoded to 1e300). 1e12 is comfortably above any real generation count, score, or
 *  cost this package produces while still catching corruption/overflow. */
const MAX_MAGNITUDE = 1e12;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function isFiniteBoundedNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= MAX_MAGNITUDE;
}
function isFiniteBoundedOrNull(x: unknown): x is number | null {
  return x === null || isFiniteBoundedNumber(x);
}
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function validateScore(s: unknown, path: string, errors: string[]): void {
  if (s === undefined) return; // optional (LineageCommit.baselineScore/candidateScore)
  if (!isPlainObject(s)) { errors.push(`${path}: expected an object, got ${s === null ? 'null' : typeof s}`); return; }
  const o = s as Partial<Record<keyof Score, unknown>>;
  if (!isFiniteBoundedNumber(o.primary)) errors.push(`${path}.primary: expected a finite, bounded number`);
  if (!isFiniteBoundedNumber(o.noopRate)) errors.push(`${path}.noopRate: expected a finite, bounded number`);
  if (!isFiniteBoundedNumber(o.costPerWin)) errors.push(`${path}.costPerWin: expected a finite, bounded number`);
  if (typeof o.regressed !== 'boolean') errors.push(`${path}.regressed: expected a boolean`);
}

function validateReceipt(r: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(r)) { errors.push(`${path}: expected an object`); return; }
  if (!isPlainObject(r.payload)) errors.push(`${path}.payload: expected an object`);
  if (typeof r.signature !== 'string') errors.push(`${path}.signature: expected a string`);
  if (typeof r.publicKey !== 'string') errors.push(`${path}.publicKey: expected a string`);
  if (r.alg !== 'ed25519') errors.push(`${path}.alg: expected "ed25519"`);
}

function validateLineageCommit(c: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(c)) { errors.push(`${path}: expected an object`); return; }
  const o = c as Partial<Record<keyof LineageCommit, unknown>>;
  if (typeof o.id !== 'string') errors.push(`${path}.id: expected a string`);
  if (!isFiniteBoundedNumber(o.generation)) errors.push(`${path}.generation: expected a finite, bounded number`);
  if (!(Array.isArray(o.parents) && o.parents.every((p) => typeof p === 'string'))) {
    errors.push(`${path}.parents: expected an array of strings`);
  }
  if (o.mutation !== null) {
    if (!isPlainObject(o.mutation)) errors.push(`${path}.mutation: expected an object or null`);
    else if (typeof o.mutation.target !== 'string' || typeof o.mutation.summary !== 'string') {
      errors.push(`${path}.mutation: expected { target: string, summary: string }`);
    }
  }
  if (!isFiniteBoundedNumber(o.primaryDelta)) errors.push(`${path}.primaryDelta: expected a finite, bounded number`);
  if (!isFiniteBoundedOrNull(o.anchorScore)) errors.push(`${path}.anchorScore: expected a finite, bounded number or null`);
  if (o.verdict !== 'ROOT' && o.verdict !== 'PROMOTED' && o.verdict !== 'REJECTED') {
    errors.push(`${path}.verdict: expected one of ROOT | PROMOTED | REJECTED`);
  }
  if (!(Array.isArray(o.failureReasons) && o.failureReasons.every((f) => typeof f === 'string'))) {
    errors.push(`${path}.failureReasons: expected an array of strings`);
  }
  validateReceipt(o.receipt, `${path}.receipt`, errors);
  if (typeof o.createdAt !== 'string') errors.push(`${path}.createdAt: expected a string`);
  validateScore(o.baselineScore, `${path}.baselineScore`, errors);
  validateScore(o.candidateScore, `${path}.candidateScore`, errors);
}

function validateLiftPoint(p: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(p)) { errors.push(`${path}: expected an object`); return; }
  const o = p as Partial<Record<keyof LiftPoint, unknown>>;
  if (!isFiniteBoundedNumber(o.generation)) errors.push(`${path}.generation: expected a finite, bounded number`);
  if (!isFiniteBoundedNumber(o.primary)) errors.push(`${path}.primary: expected a finite, bounded number`);
  if (!isFiniteBoundedNumber(o.delta)) errors.push(`${path}.delta: expected a finite, bounded number`);
  if (!isFiniteBoundedOrNull(o.anchor)) errors.push(`${path}.anchor: expected a finite, bounded number or null`);
}

/** Validates a parsed JSON value as a well-typed, finite, bounded `ReplayBundle` — fail-closed: any
 *  structural or numeric-domain violation is collected (not just the first) so the caller can report
 *  everything wrong with a bad bundle in one pass. */
export function validateReplayBundle(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(data)) {
    return { valid: false, errors: ['bundle: expected a JSON object'] };
  }
  const o = data as Partial<Record<keyof ReplayBundle, unknown>>;
  if (typeof o.data_source !== 'string') errors.push('data_source: expected a string');
  if (typeof o.root_id !== 'string') errors.push('root_id: expected a string');
  if (!Array.isArray(o.chain)) errors.push('chain: expected an array');
  else o.chain.forEach((c, i) => validateLineageCommit(c, `chain[${i}]`, errors));
  if (!Array.isArray(o.all_commits)) errors.push('all_commits: expected an array');
  else o.all_commits.forEach((c, i) => validateLineageCommit(c, `all_commits[${i}]`, errors));
  if (!Array.isArray(o.lift_curve)) errors.push('lift_curve: expected an array');
  else o.lift_curve.forEach((p, i) => validateLiftPoint(p, `lift_curve[${i}]`, errors));
  if (o.gate_fingerprint !== null && typeof o.gate_fingerprint !== 'string') {
    errors.push('gate_fingerprint: expected a string or null');
  }
  if (!isFiniteBoundedNumber(o.verified_improvements)) errors.push('verified_improvements: expected a finite, bounded number');
  if (!isFiniteBoundedNumber(o.anchor_surviving_improvements)) {
    errors.push('anchor_surviving_improvements: expected a finite, bounded number');
  }
  if (typeof o.milestone_reached !== 'boolean') errors.push('milestone_reached: expected a boolean');
  if (typeof o.created_at !== 'string') errors.push('created_at: expected a string');
  return { valid: errors.length === 0, errors };
}
