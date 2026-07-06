// @metaharness/evals-extract — the SCORE VECTOR and its projection onto the flywheel's four frozen axes.
//
// Extraction is not optimized on raw field-accuracy. We measure a vector (accuracy, cost/correct, calibration
// error, schema-error rate, per-doc-type accuracy) and PROJECT it onto the flywheel's opaque `Score`:
//   primary     = accuracy (schema-valid AND field-correct)
//   noopRate    = schema-invalid + abstention rate  ("commit a valid object" — the frozen gate needs this ↓)
//   costPerWin  = cost per CORRECT extraction        (999 sentinel when 0 correct, so 0-win is never "cheap")
//   regressed   = a hard stop: leakage (fail-closed) OR total schema collapse
// The richer axes (calibrationError, perDocTypeAccuracy, schemaErrorRate) ride ALONG on `ExtractScore` so the
// composite extract gate can enforce its extra clauses — the base `Score` fields alone drive the frozen gate.
import type { Score } from '@metaharness/flywheel';
import type { DocType } from './genome.js';

export interface ExtractScore extends Score {
  accuracy: number;
  costPerCorrect: number;
  calibrationError: number;
  schemaErrorRate: number;
  abstentionRate: number;
  perDocTypeAccuracy: Partial<Record<DocType, number>>;
  n: number;
  correct: number;
}

export interface PerDocResult {
  docType: DocType;
  correct: boolean;
  abstained: boolean;
  schemaInvalid: boolean;
  confidence: number;
  costUsd: number;
  leaked: boolean;
}

const COST_SENTINEL = 999;

/** Aggregate per-document results into an ExtractScore (which IS a valid flywheel Score). */
export function projectScore(results: PerDocResult[]): ExtractScore {
  const n = results.length || 1;
  const correct = results.filter((r) => r.correct).length;
  const abstained = results.filter((r) => r.abstained).length;
  const schemaInvalid = results.filter((r) => r.schemaInvalid && !r.abstained).length;
  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
  const anyLeak = results.some((r) => r.leaked);

  // per-doc-type accuracy
  const byType: Partial<Record<DocType, { c: number; n: number }>> = {};
  for (const r of results) {
    const b = (byType[r.docType] ??= { c: 0, n: 0 });
    b.n += 1; if (r.correct) b.c += 1;
  }
  const perDocTypeAccuracy: Partial<Record<DocType, number>> = {};
  for (const [t, b] of Object.entries(byType)) perDocTypeAccuracy[t as DocType] = b!.c / b!.n;

  const accuracy = correct / n;
  const noopRate = (abstained + schemaInvalid) / n;
  const costPerCorrect = correct > 0 ? totalCost / correct : COST_SENTINEL;

  const committed = results.filter((r) => !r.abstained && !r.schemaInvalid);
  const calErr = calibrationErrorOf(committed);

  // hard stop: leakage (fail-closed) or a total schema collapse (nobody produced a valid object)
  const regressed = anyLeak || (schemaInvalid + abstained) === results.length;

  return {
    primary: accuracy,
    noopRate,
    costPerWin: costPerCorrect,
    regressed,
    accuracy,
    costPerCorrect,
    calibrationError: calErr,
    schemaErrorRate: schemaInvalid / n,
    abstentionRate: abstained / n,
    perDocTypeAccuracy,
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
