// SPDX-License-Identifier: MIT
//
// ADR-169 (research E3) — persistent patch memory so runs COMPOUND. A new
// instance retrieves the most-similar PRIOR resolved (issue → patch) pairs and
// injects them as few-shot exemplars, so every solved instance makes the next
// one likelier/cheaper. This is the deterministic, dependency-free, $0 core:
// BM25 lexical retrieval over the issue text. It runs anywhere (incl. the WASM
// kernel) with no model and no network. A dense reranker (ONNX MiniLM / HNSW)
// can be layered behind `rerank` later (research E3 hybrid) — the seam is here.
//
// Pure + injection-free: no fetch/fs/Docker. `solve-repair.mjs --patch-memory
// <corpus.json>` wires it to the real solver; this module is unit-tested offline
// against a fixture corpus.

const STOP = new Set(('a an the is are was were be been being to of in on for and or not with as at by '
  + 'this that it its from if then else when while do does did has have had can could should would will '
  + 'i we you they he she but so no yes which who whom whose what where why how').split(' '));

/** Tokenize to lowercased alnum/underscore terms, drop stopwords + 1-char noise. */
export function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9_]+/g)?.filter((t) => t.length > 1 && !STOP.has(t)) ?? [];
}

/**
 * Build a BM25 index over corpus entries' `problem_statement`. Returns an index
 * object consumed by `retrieve`. Deterministic; O(total tokens).
 *   corpus: [{ instance_id, repo, problem_statement, model_patch }]
 */
export function buildIndex(corpus, { k1 = 1.5, b = 0.75, embedder = null } = {}) {
  const docs = corpus.map((e) => ({ entry: e, terms: tokenize(e.problem_statement) }));
  // Optional dense vectors for hybrid rerank (research E3). `embedder` is
  // injectable (text => number[]) so this stays $0 + offline-testable; in
  // production it's an ONNX MiniLM running in the WASM kernel. Stored aligned
  // to `docs` order; absent → retrieveHybrid degrades to normalized BM25.
  let vectors = null;
  if (typeof embedder === 'function') vectors = corpus.map((e) => embedder(e.problem_statement));
  const N = docs.length || 1;
  const df = new Map();
  let totalLen = 0;
  for (const d of docs) {
    totalLen += d.terms.length;
    for (const t of new Set(d.terms)) df.set(t, (df.get(t) || 0) + 1);
  }
  const avgdl = totalLen / N;
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  // per-doc term frequencies
  const tf = docs.map((d) => { const m = new Map(); for (const t of d.terms) m.set(t, (m.get(t) || 0) + 1); return m; });
  return { docs, tf, idf, avgdl, k1, b, N, vectors };
}

/**
 * Retrieve the top-`k` prior resolved patches most relevant to `query` (an issue
 * / problem statement), by BM25. Excludes `excludeId` (don't retrieve the
 * instance you're solving). Returns [{ instance_id, repo, model_patch, score }].
 */
export function retrieve(index, query, k = 3, excludeId = null) {
  const { docs, tf, idf, avgdl, k1, b } = index;
  const qTerms = new Set(tokenize(query));
  const scored = [];
  for (let i = 0; i < docs.length; i++) {
    if (excludeId && docs[i].entry.instance_id === excludeId) continue;
    const dl = docs[i].terms.length;
    let s = 0;
    for (const t of qTerms) {
      const f = tf[i].get(t); if (!f) continue;
      const w = idf.get(t) || 0;
      s += w * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgdl)));
    }
    if (s > 0) scored.push({ ...docs[i].entry, score: Math.round(s * 1000) / 1000 });
  }
  scored.sort((a, b2) => b2.score - a.score || (a.instance_id < b2.instance_id ? -1 : 1)); // deterministic tie-break
  return scored.slice(0, k);
}

/** Cosine similarity of two equal-length numeric vectors (0 if either empty). */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Hybrid retrieval (research E3 + peer review): combine min-max-normalized BM25
 * with dense cosine similarity, then GATE on a hard minimum. The gate is the
 * key mitigation: dense embeddings (MiniLM) cluster by NL topic, not code
 * structure, so an irrelevant exemplar causes negative transfer. If the best
 * combined score is below `minScore` — or, when a dense embedder is supplied,
 * the best cosine is below `minCosine` — we return [] so the caller injects
 * NOTHING rather than a misleading few-shot.
 *
 *   index      from buildIndex (with optional `vectors` if an embedder was given)
 *   query      the issue / problem statement
 *   opts: { k=3, excludeId, queryVec, alpha=0.6 (cosine weight), minScore=0.30,
 *           minCosine=0.25 }
 * `alpha` blends: score = alpha*cosineNorm + (1-alpha)*bm25Norm (peer review:
 * 0.6 cosine / 0.4 BM25). With no vectors, falls back to pure normalized BM25.
 */
export function retrieveHybrid(index, query, opts = {}) {
  const { k = 3, excludeId = null, queryVec = null, alpha = 0.6, minScore = 0.30, minCosine = 0.25 } = opts;
  // BM25 candidates (wider net before re-ranking)
  const bm25 = retrieve(index, query, Math.max(k * 5, 15), excludeId);
  if (!bm25.length) return [];
  const maxB = Math.max(...bm25.map((h) => h.score)) || 1;
  const haveDense = Array.isArray(index.vectors) && queryVec && queryVec.length;
  const idOf = new Map(index.docs.map((d, i) => [d.entry.instance_id, i]));
  let scored = bm25.map((h) => {
    const bm25Norm = h.score / maxB;
    let cos = 0;
    if (haveDense) { const vi = idOf.get(h.instance_id); cos = vi != null ? cosine(queryVec, index.vectors[vi]) : 0; }
    const combined = haveDense ? alpha * cos + (1 - alpha) * bm25Norm : bm25Norm;
    return { ...h, bm25Norm: Math.round(bm25Norm * 1000) / 1000, cosine: Math.round(cos * 1000) / 1000, score: Math.round(combined * 1000) / 1000 };
  });
  // Hard gates — avoid negative transfer.
  if (haveDense) scored = scored.filter((h) => h.cosine >= minCosine);
  scored = scored.filter((h) => h.score >= minScore);
  scored.sort((a, b) => b.score - a.score || (a.instance_id < b.instance_id ? -1 : 1));
  return scored.slice(0, k);
}

/**
 * One-call retrieval→exemplar block with the gate applied: returns '' (inject
 * NOTHING) when nothing clears the threshold. The safe entry point for solvers.
 */
export function injectExemplars(index, query, opts = {}) {
  const hits = retrieveHybrid(index, query, opts);
  return formatExemplars(hits, opts);
}

/**
 * Format retrieved exemplars as a compact few-shot block for the repair prompt.
 * Each: the issue gist + the patch that resolved it. Bounded so it fits context.
 */
export function formatExemplars(hits, { maxPatchChars = 1200 } = {}) {
  if (!hits || !hits.length) return '';
  const blocks = hits.map((h, i) =>
    `--- prior resolved example ${i + 1} (${h.instance_id}) ---\n`
    + `issue: ${String(h.problem_statement || '').slice(0, 600)}\n`
    + `patch that resolved it:\n${String(h.model_patch).slice(0, maxPatchChars)}`);
  return `\n--- retrieved patch memory (similar issues we have already fixed; adapt, don't copy) ---\n${blocks.join('\n\n')}\n`;
}
