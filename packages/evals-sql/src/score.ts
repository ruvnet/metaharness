// @metaharness/evals-sql — the SCORE VECTOR and its projection onto the flywheel's four frozen axes.
//
// Text-to-SQL is not optimized on raw execution-match. We measure a vector (execution accuracy, cost/correct,
// calibration error, invalid-SQL rate, per-type accuracy) and PROJECT it onto the flywheel's opaque `Score`:
//   primary     = execution-match accuracy
//   noopRate    = invalid-SQL + abstention rate   ("commit more" — the frozen gate needs this to strictly ↓)
//   costPerWin  = cost per CORRECT query           (999 sentinel when 0 correct, so 0-win is never "cheap")
//   regressed   = a hard stop: leakage (fail-closed) OR total invalid-SQL collapse
// The richer axes (calibrationError, perTypeAccuracy, invalidSqlRate) ride ALONG on `SqlScore` so the
// composite SQL gate can enforce its extra clauses — the base `Score` fields alone drive the frozen gate.
import type { Score } from '@metaharness/flywheel';
import type { QueryType } from './genome.js';

export interface SqlScore extends Score {
  accuracy: number;
  costPerCorrect: number;
  calibrationError: number;
  invalidSqlRate: number;
  abstentionRate: number;
  perTypeAccuracy: Partial<Record<QueryType, number>>;
  n: number;
  correct: number;
}

export interface PerQuestionResult {
  queryType: QueryType;
  correct: boolean;
  abstained: boolean;
  sqlInvalid: boolean;
  confidence: number;
  costUsd: number;
  leaked: boolean;
}

const COST_SENTINEL = 999;

/** Aggregate per-question results into a SqlScore (which IS a valid flywheel Score). */
export function projectScore(results: PerQuestionResult[]): SqlScore {
  const n = results.length || 1;
  const correct = results.filter((r) => r.correct).length;
  const abstained = results.filter((r) => r.abstained).length;
  const invalid = results.filter((r) => r.sqlInvalid && !r.abstained).length;
  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
  const anyLeak = results.some((r) => r.leaked);

  // per-type accuracy
  const byType: Partial<Record<QueryType, { c: number; n: number }>> = {};
  for (const r of results) {
    const b = (byType[r.queryType] ??= { c: 0, n: 0 });
    b.n += 1; if (r.correct) b.c += 1;
  }
  const perTypeAccuracy: Partial<Record<QueryType, number>> = {};
  for (const [t, b] of Object.entries(byType)) perTypeAccuracy[t as QueryType] = b!.c / b!.n;

  const accuracy = correct / n;
  const noopRate = (abstained + invalid) / n;
  const costPerCorrect = correct > 0 ? totalCost / correct : COST_SENTINEL;

  const committed = results.filter((r) => !r.abstained && !r.sqlInvalid);
  const calErr = calibrationErrorOf(committed);

  // hard stop: leakage (fail-closed) or a total invalid-SQL collapse (nobody produced a valid query)
  const regressed = anyLeak || (invalid + abstained) === results.length;

  return {
    primary: accuracy,
    noopRate,
    costPerWin: costPerCorrect,
    regressed,
    accuracy,
    costPerCorrect,
    calibrationError: calErr,
    invalidSqlRate: invalid / n,
    abstentionRate: abstained / n,
    perTypeAccuracy,
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
