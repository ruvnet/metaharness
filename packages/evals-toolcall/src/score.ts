// @metaharness/evals-toolcall — the SCORE VECTOR and its projection onto the flywheel's four frozen axes.
//
// Tool-calling is not optimized on raw accuracy. We measure a vector (accuracy, cost/correct, calibration
// error, arg-error rate, per-category accuracy) and PROJECT it onto the flywheel's opaque `Score`:
//   primary     = call accuracy (function name + args match)
//   noopRate    = malformed-call + abstention rate  ("commit a valid call" — the frozen gate needs this ↓)
//   costPerWin  = cost per CORRECT call             (999 sentinel when 0 correct, so 0-win is never "cheap")
//   regressed   = a hard stop: leakage (fail-closed) OR total malformed-call collapse
// The richer axes (calibrationError, perCategoryAccuracy, argErrorRate) ride ALONG on `ToolcallScore` so the
// composite toolcall gate can enforce its extra clauses — the base `Score` fields alone drive the frozen gate.
import type { Score } from '@metaharness/flywheel';
import type { Category } from './genome.js';

export interface ToolcallScore extends Score {
  accuracy: number;
  costPerCorrect: number;
  calibrationError: number;
  /** Fraction of queries whose committed output was a malformed/unparseable call. */
  argErrorRate: number;
  abstentionRate: number;
  perCategoryAccuracy: Partial<Record<Category, number>>;
  n: number;
  correct: number;
}

export interface PerCallResult {
  category: Category;
  correct: boolean;
  abstained: boolean;
  /** The committed output was not a structurally-valid call (malformed → no-op). */
  callInvalid: boolean;
  confidence: number;
  costUsd: number;
  leaked: boolean;
}

const COST_SENTINEL = 999;

/** Aggregate per-call results into a ToolcallScore (which IS a valid flywheel Score). */
export function projectScore(results: PerCallResult[]): ToolcallScore {
  const n = results.length || 1;
  const correct = results.filter((r) => r.correct).length;
  const abstained = results.filter((r) => r.abstained).length;
  const callInvalid = results.filter((r) => r.callInvalid && !r.abstained).length;
  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
  const anyLeak = results.some((r) => r.leaked);

  // per-category accuracy
  const byCat: Partial<Record<Category, { c: number; n: number }>> = {};
  for (const r of results) {
    const b = (byCat[r.category] ??= { c: 0, n: 0 });
    b.n += 1; if (r.correct) b.c += 1;
  }
  const perCategoryAccuracy: Partial<Record<Category, number>> = {};
  for (const [c, b] of Object.entries(byCat)) perCategoryAccuracy[c as Category] = b!.c / b!.n;

  const accuracy = correct / n;
  const noopRate = (abstained + callInvalid) / n;
  const costPerCorrect = correct > 0 ? totalCost / correct : COST_SENTINEL;

  const committed = results.filter((r) => !r.abstained && !r.callInvalid);
  const calErr = calibrationErrorOf(committed);

  // hard stop: leakage (fail-closed) or a total malformed collapse (nobody produced a valid call)
  const regressed = anyLeak || (callInvalid + abstained) === results.length;

  return {
    primary: accuracy,
    noopRate,
    costPerWin: costPerCorrect,
    regressed,
    accuracy,
    costPerCorrect,
    calibrationError: calErr,
    argErrorRate: callInvalid / n,
    abstentionRate: abstained / n,
    perCategoryAccuracy,
    n: results.length,
    correct,
  };
}

function calibrationErrorOf(committed: Array<{ confidence: number; correct: boolean }>, bins = 10): number {
  if (committed.length === 0) return 0;
  const buckets = Array.from({ length: bins }, () => ({ conf: 0, acc: 0, n: 0 }));
  for (const c of committed) {
    const i = Math.min(bins - 1, Math.floor(Math.min(1, Math.max(0, c.confidence)) * bins));
    buckets[i].conf += c.confidence; buckets[i].acc += c.correct ? 1 : 0; buckets[i].n += 1;
  }
  let ece = 0;
  for (const b of buckets) if (b.n) ece += (b.n / committed.length) * Math.abs(b.conf / b.n - b.acc / b.n);
  return ece;
}
