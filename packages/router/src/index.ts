// SPDX-License-Identifier: MIT
//
// @metaharness/router — cost-optimal model routing for agent harnesses.
//
// The productized form of the DRACO Phase-2 finding (ADR-040): structure does
// not beat a strong model on quality, but routing each query to the *cheapest
// model that is good enough* is a measured Pareto win. On the DRACO benchmark a
// learned embedding router beat the best fixed model and the gap to the per-
// query oracle shrinks monotonically with training data (the learning curve).
//
// This package is that router as a dependency-free primitive: give it candidate
// models with a price and a few labelled examples (query embedding → the quality
// that model achieved), and `route(queryEmbedding)` returns the cheapest
// candidate predicted to clear your quality bar — k-NN over the examples, no
// network, no model files. Bring any embedding model; the router only needs the
// vectors.

/** Cosine similarity over dense vectors. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** One labelled observation: on a query with this embedding, the candidate scored `quality`. */
export interface RouterExample {
  embedding: number[];
  /** Quality the candidate achieved on that query, 0..1. */
  quality: number;
}

export interface RouterCandidate {
  id: string;
  /** Blended price ($/1M tokens) — the cost axis the router minimises. */
  costPerMTok: number;
  /** Historical (query embedding → quality) observations for THIS candidate. */
  examples: RouterExample[];
}

export interface RouterOptions {
  candidates: RouterCandidate[];
  /** k-NN neighbours used to predict a candidate's quality on a new query (default 5). */
  k?: number;
  /**
   * Quality bar (0..1). If set, route() returns the CHEAPEST candidate whose
   * predicted quality clears the bar (cost-optimal). If no candidate clears it,
   * route() returns the highest-predicted-quality candidate (best effort). If
   * unset, route() always returns the highest-predicted-quality candidate.
   */
  qualityBar?: number;
}

export interface RouteResult {
  id: string;
  predictedQuality: number;
  costPerMTok: number;
  /** true if this pick cleared the quality bar (or no bar was set). */
  metBar: boolean;
}

/**
 * Cost-optimal model router. Predicts each candidate's quality on a query via
 * k-NN over that candidate's labelled examples, then picks the cheapest model
 * that clears the quality bar (or the best-predicted if none / no bar).
 */
export class Router {
  private readonly candidates: RouterCandidate[];
  private readonly k: number;
  private readonly qualityBar?: number;

  constructor(opts: RouterOptions) {
    if (!opts.candidates?.length) throw new Error('Router needs at least one candidate');
    this.candidates = opts.candidates;
    this.k = Math.max(1, opts.k ?? 5);
    this.qualityBar = opts.qualityBar;
  }

  /**
   * Build a Router from a flat routing dataset: rows of (query embedding → the
   * quality each model achieved on that query) + a per-model price table. This
   * is the shape the DRACO benchmark emits and the shape a tiny-dancer training
   * pipeline would consume — so the same dataset seeds this no-model router AND
   * trains the native one.
   */
  static fromExamples(
    rows: { embedding: number[]; scores: Record<string, number> }[],
    prices: Record<string, number>,
    opts: { k?: number; qualityBar?: number } = {},
  ): Router {
    const ids = new Set<string>();
    for (const r of rows) for (const id of Object.keys(r.scores)) ids.add(id);
    const candidates: RouterCandidate[] = [...ids].map((id) => ({
      id,
      costPerMTok: prices[id] ?? 0,
      examples: rows.filter((r) => id in r.scores).map((r) => ({ embedding: r.embedding, quality: r.scores[id] })),
    }));
    return new Router({ candidates, ...opts });
  }

  /** Predict a candidate's quality on `queryEmbedding` via k-NN over its examples. */
  predict(candidate: RouterCandidate, queryEmbedding: number[]): number {
    if (candidate.examples.length === 0) return 0;
    const nn = candidate.examples
      .map((e) => [e.quality, cosine(queryEmbedding, e.embedding)] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.min(this.k, candidate.examples.length));
    return nn.reduce((s, [q]) => s + q, 0) / nn.length;
  }

  /** Route a query to the cost-optimal candidate. */
  route(queryEmbedding: number[]): RouteResult {
    const scored = this.candidates.map((c) => ({
      id: c.id,
      costPerMTok: c.costPerMTok,
      predictedQuality: this.predict(c, queryEmbedding),
    }));
    if (this.qualityBar != null) {
      const clearing = scored.filter((s) => s.predictedQuality >= this.qualityBar!);
      if (clearing.length > 0) {
        // cheapest that clears the bar
        clearing.sort((a, b) => a.costPerMTok - b.costPerMTok);
        return { ...clearing[0], metBar: true };
      }
    }
    // no bar, or none cleared it → best predicted quality
    scored.sort((a, b) => b.predictedQuality - a.predictedQuality);
    return { ...scored[0], metBar: this.qualityBar == null };
  }
}

// Training pipeline (ADR-043) — kernel ridge regression router.
export * from './train.js';
