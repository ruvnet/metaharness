// SPDX-License-Identifier: MIT
//
// Router training pipeline (ADR-043) — kernel ridge regression with a cosine
// kernel. The regularised, learned generalisation of the k-NN router: predict
// each candidate model's quality on a query from its cosine similarities to the
// training queries, with λ controlling the bias–variance trade-off that sank raw
// k-NN on small data. λ is fit by leave-one-out cross-validation on routing
// quality. Pure TS, no native deps — runs anywhere @metaharness/router does.

import { cosine, type RouteResult } from './index.js';

/** Solve A x = b for x via Gaussian elimination with partial pivoting. A is n×n. */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  // augmented copy
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // partial pivot
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

function gram(X: number[][]): number[][] {
  const n = X.length;
  const K: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) { const c = cosine(X[i], X[j]); K[i][j] = c; K[j][i] = c; }
  return K;
}

/** Fit KRR dual coefficients α = (K + λI)⁻¹ y for one candidate. */
export function fitKRR(X: number[][], y: number[], lambda: number): number[] {
  const K = gram(X);
  for (let i = 0; i < K.length; i++) K[i][i] += lambda;
  return solve(K, y);
}

/** Predict ŷ(x*) = Σ α_i cos(x*, X_i). */
function predictKRR(xStar: number[], X: number[][], alpha: number[]): number {
  let s = 0;
  for (let i = 0; i < X.length; i++) s += alpha[i] * cosine(xStar, X[i]);
  return s;
}

export interface TrainedCandidate {
  id: string;
  costPerMTok: number;
  refEmbeddings: number[][];
  alpha: number[];
}

/** A trained cost-optimal router (KRR predictors per candidate). Serialisable. */
export class TrainedRouter {
  constructor(
    private readonly candidates: TrainedCandidate[],
    private readonly qualityBar?: number,
  ) {
    if (!candidates.length) throw new Error('TrainedRouter needs at least one candidate');
  }

  predict(id: string, queryEmbedding: number[]): number {
    const c = this.candidates.find((x) => x.id === id);
    if (!c) throw new Error(`unknown candidate ${id}`);
    return predictKRR(queryEmbedding, c.refEmbeddings, c.alpha);
  }

  route(queryEmbedding: number[]): RouteResult {
    const scored = this.candidates.map((c) => ({
      id: c.id,
      costPerMTok: c.costPerMTok,
      predictedQuality: predictKRR(queryEmbedding, c.refEmbeddings, c.alpha),
    }));
    if (this.qualityBar != null) {
      const clearing = scored.filter((s) => s.predictedQuality >= this.qualityBar!);
      if (clearing.length) { clearing.sort((a, b) => a.costPerMTok - b.costPerMTok); return { ...clearing[0], metBar: true }; }
    }
    scored.sort((a, b) => b.predictedQuality - a.predictedQuality);
    return { ...scored[0], metBar: this.qualityBar == null };
  }

  toJSON(): { candidates: TrainedCandidate[]; qualityBar?: number } {
    return { candidates: this.candidates, ...(this.qualityBar != null ? { qualityBar: this.qualityBar } : {}) };
  }
  static fromJSON(o: { candidates: TrainedCandidate[]; qualityBar?: number }): TrainedRouter {
    return new TrainedRouter(o.candidates, o.qualityBar);
  }
}

export interface TrainResult {
  router: TrainedRouter;
  lambda: number;
  /** Leave-one-out routing quality at the chosen λ (mean achieved quality). */
  looQuality: number;
}

/**
 * Train a cost-optimal router from a routing dataset via KRR, choosing λ by
 * leave-one-out cross-validation on ROUTING quality (not regression error). The
 * objective is exactly what the router optimises in production: route each
 * held-out query, measure the quality the picked model actually achieved.
 */
export function trainRouter(
  rows: { embedding: number[]; scores: Record<string, number> }[],
  prices: Record<string, number>,
  opts: { lambdas?: number[]; qualityBar?: number } = {},
): TrainResult {
  const lambdas = opts.lambdas ?? [0.01, 0.1, 0.3, 1, 3, 10];
  const ids = [...new Set(rows.flatMap((r) => Object.keys(r.scores)))];
  const n = rows.length;

  // LOO routing quality for a given λ.
  const looFor = (lambda: number): number => {
    let total = 0;
    for (let h = 0; h < n; h++) {
      const train = rows.filter((_, i) => i !== h);
      const X = train.map((r) => r.embedding);
      const q = rows[h];
      // predict each candidate's quality for the held-out query
      let pickId = ids[0], pickPred = -Infinity, pickCost = Infinity;
      const preds = ids.map((id) => {
        const y = train.map((r) => r.scores[id]);
        const alpha = fitKRR(X, y, lambda);
        return { id, pred: predictKRR(q.embedding, X, alpha), cost: prices[id] ?? 0 };
      });
      if (opts.qualityBar != null) {
        const clearing = preds.filter((p) => p.pred >= opts.qualityBar!);
        if (clearing.length) { const c = clearing.sort((a, b) => a.cost - b.cost)[0]; pickId = c.id; }
        else { const c = preds.sort((a, b) => b.pred - a.pred)[0]; pickId = c.id; }
      } else {
        const c = preds.sort((a, b) => b.pred - a.pred)[0]; pickId = c.id;
      }
      void pickPred; void pickCost;
      total += rows[h].scores[pickId]; // ACTUAL quality of the routed model
    }
    return total / n;
  };

  let bestLambda = lambdas[0], bestLoo = -Infinity;
  for (const lambda of lambdas) { const loo = looFor(lambda); if (loo > bestLoo) { bestLoo = loo; bestLambda = lambda; } }

  // final fit on ALL data at the chosen λ
  const X = rows.map((r) => r.embedding);
  const candidates: TrainedCandidate[] = ids.map((id) => ({
    id,
    costPerMTok: prices[id] ?? 0,
    refEmbeddings: X,
    alpha: fitKRR(X, rows.map((r) => r.scores[id]), bestLambda),
  }));
  return { router: new TrainedRouter(candidates, opts.qualityBar), lambda: bestLambda, looQuality: bestLoo };
}
