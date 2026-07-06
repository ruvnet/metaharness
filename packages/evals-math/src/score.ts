// @metaharness/evals-math — the SCORE VECTOR and its projection onto the flywheel's four frozen axes.
//
// Math is not optimized on raw accuracy. We measure a vector (accuracy, cost/correct, calibration error,
// format-error rate, per-subtopic accuracy) and PROJECT it onto the flywheel's opaque `Score`:
//   primary     = accuracy  (exact-match after numeric normalization)
//   noopRate    = format-invalid + abstention rate  ("commit more" — the frozen gate needs this to strictly ↓)
//   costPerWin  = cost per CORRECT answer           (999 sentinel when 0 correct, so 0-win is never "cheap")
//   regressed   = a hard stop: leakage (fail-closed) OR total format collapse
// The richer axes (calibrationError, perSubjectAccuracy, formatErrorRate) ride ALONG on `MathScore` so the
// composite math gate can enforce its extra clauses — the base `Score` fields alone drive the frozen gate.
import type { Score } from '@metaharness/flywheel';
import type { Subject } from './genome.js';

export interface MathScore extends Score {
  accuracy: number;
  costPerCorrect: number;
  calibrationError: number;
  formatErrorRate: number;
  abstentionRate: number;
  perSubjectAccuracy: Partial<Record<Subject, number>>;
  n: number;
  correct: number;
}

export interface PerQuestionResult {
  subject: Subject;
  correct: boolean;
  abstained: boolean;
  formatInvalid: boolean;
  confidence: number;
  costUsd: number;
  leaked: boolean;
}

const COST_SENTINEL = 999;

/** Aggregate per-question results into a MathScore (which IS a valid flywheel Score). */
export function projectScore(results: PerQuestionResult[]): MathScore {
  const n = results.length || 1;
  const correct = results.filter((r) => r.correct).length;
  const abstained = results.filter((r) => r.abstained).length;
  const formatInvalid = results.filter((r) => r.formatInvalid && !r.abstained).length;
  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
  const anyLeak = results.some((r) => r.leaked);

  // per-subtopic accuracy
  const bySubject: Partial<Record<Subject, { c: number; n: number }>> = {};
  for (const r of results) {
    const b = (bySubject[r.subject] ??= { c: 0, n: 0 });
    b.n += 1; if (r.correct) b.c += 1;
  }
  const perSubjectAccuracy: Partial<Record<Subject, number>> = {};
  for (const [s, b] of Object.entries(bySubject)) perSubjectAccuracy[s as Subject] = b!.c / b!.n;

  const accuracy = correct / n;
  const noopRate = (abstained + formatInvalid) / n;
  const costPerCorrect = correct > 0 ? totalCost / correct : COST_SENTINEL;

  const committed = results.filter((r) => !r.abstained && !r.formatInvalid);
  const calErr = calibrationErrorOf(committed);

  // hard stop: leakage (fail-closed) or a total format collapse (nobody produced a valid answer)
  const regressed = anyLeak || (formatInvalid + abstained) === results.length;

  return {
    primary: accuracy,
    noopRate,
    costPerWin: costPerCorrect,
    regressed,
    accuracy,
    costPerCorrect,
    calibrationError: calErr,
    formatErrorRate: formatInvalid / n,
    abstentionRate: abstained / n,
    perSubjectAccuracy,
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
