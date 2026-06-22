// SPDX-License-Identifier: MIT
// ADR-169 (research E3) — offline tests for the $0 BM25 patch-memory retrieval.
// No network, no model: deterministic lexical retrieval over a fixture corpus.
import { describe, it, expect } from 'vitest';
import { tokenize, buildIndex, retrieve, retrieveHybrid, injectExemplars, cosine, formatExemplars } from '../bench/swebench/patch-memory.mjs';

// A deterministic stub embedder: bag-of-words over a tiny fixed vocab → a vector.
// Stands in for ONNX MiniLM so the hybrid path is testable $0/offline.
const VOCAB = ['annotate', 'fielderror', 'aggregate', 'cos', 'sin', 'trig', 'cookies', 'redirect', 'migration', 'window'];
const stubEmbed = (text: string): number[] => {
  const toks = new Set(tokenize(text));
  return VOCAB.map((w) => (toks.has(w) ? 1 : 0));
};

const corpus = [
  { instance_id: 'django__django-1', repo: 'django', problem_statement: 'QuerySet.annotate raises FieldError when combining aggregate with window function', model_patch: 'diff --git a/q.py\n+    return self.annotate(window=...)' },
  { instance_id: 'sympy__sympy-2', repo: 'sympy', problem_statement: 'simplify() returns wrong result for trigonometric identity with cos and sin', model_patch: 'diff --git a/trig.py\n+    return cos(x)**2 + sin(x)**2' },
  { instance_id: 'requests__requests-3', repo: 'requests', problem_statement: 'Session cookies not persisted across redirect when domain changes', model_patch: 'diff --git a/sessions.py\n+    self.cookies.update(...)' },
  { instance_id: 'django__django-4', repo: 'django', problem_statement: 'Migration crashes with FieldError on annotate over a related field aggregate', model_patch: 'diff --git a/migrations.py\n+    fix annotate' },
];

describe('tokenize', () => {
  it('lowercases, splits, drops stopwords + 1-char noise', () => {
    const t = tokenize('The QuerySet.annotate raises a FieldError');
    expect(t).toContain('queryset');
    expect(t).toContain('annotate');
    expect(t).toContain('fielderror');
    expect(t).not.toContain('the'); // stopword
    expect(t).not.toContain('a');   // stopword + 1-char
  });
});

describe('BM25 retrieve', () => {
  const index = buildIndex(corpus);

  it('ranks the lexically-closest prior issue first', () => {
    const hits = retrieve(index, 'annotate raises FieldError aggregate', 2);
    expect(hits.length).toBeGreaterThan(0);
    // both django entries are about annotate+FieldError; one of them ranks #1
    expect(hits[0].instance_id).toMatch(/django__django-(1|4)/);
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('retrieves a different domain for a different query', () => {
    const hits = retrieve(index, 'trigonometric simplify cos sin identity', 1);
    expect(hits[0].instance_id).toBe('sympy__sympy-2');
  });

  it('excludes the instance being solved (no self-retrieval)', () => {
    const hits = retrieve(index, corpus[0].problem_statement, 5, 'django__django-1');
    expect(hits.every((h) => h.instance_id !== 'django__django-1')).toBe(true);
  });

  it('is deterministic across calls (stable tie-break)', () => {
    const a = retrieve(index, 'annotate FieldError', 4).map((h) => h.instance_id);
    const b = retrieve(index, 'annotate FieldError', 4).map((h) => h.instance_id);
    expect(a).toEqual(b);
  });

  it('returns [] when nothing matches', () => {
    expect(retrieve(index, 'zzz nonexistent qqqterm', 3)).toEqual([]);
  });
});

describe('cosine', () => {
  it('is 1 for identical, 0 for orthogonal, 0 for mismatched/empty', () => {
    expect(cosine([1, 0, 1], [1, 0, 1])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 1], [1, 1, 1])).toBe(0); // length mismatch
    expect(cosine([], [])).toBe(0);
  });
});

describe('retrieveHybrid + gate (E3 mitigation: inject nothing rather than negative transfer)', () => {
  it('falls back to normalized BM25 when no dense vectors', () => {
    const index = buildIndex(corpus); // no embedder
    const hits = retrieveHybrid(index, 'annotate FieldError aggregate', { k: 2, minScore: 0.1 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].instance_id).toMatch(/django/);
    expect(hits[0].cosine).toBe(0); // no dense
  });

  it('blends cosine + BM25 when an embedder is supplied', () => {
    const index = buildIndex(corpus, { embedder: stubEmbed });
    expect(index.vectors).toBeTruthy();
    const qv = stubEmbed('annotate fielderror aggregate');
    const hits = retrieveHybrid(index, 'annotate FieldError aggregate', { k: 2, queryVec: qv, alpha: 0.6, minCosine: 0.1, minScore: 0.1 });
    expect(hits[0].instance_id).toMatch(/django/);
    expect(hits[0].cosine).toBeGreaterThan(0); // dense contributed
  });

  it('GATES OUT low-similarity matches (cosine below minCosine) — the anti-negative-transfer mitigation', () => {
    const index = buildIndex(corpus, { embedder: stubEmbed });
    // a query whose terms overlap lexically but NOT in the dense vocab → low cosine
    const qv = stubEmbed('unrelated database connection pooling timeout');
    const hits = retrieveHybrid(index, 'annotate', { k: 3, queryVec: qv, minCosine: 0.5, minScore: 0.1 });
    expect(hits.length).toBe(0); // gated → caller injects nothing
  });

  it('injectExemplars returns empty string when nothing clears the gate', () => {
    const index = buildIndex(corpus, { embedder: stubEmbed });
    const qv = stubEmbed('totally unrelated payload');
    expect(injectExemplars(index, 'totally unrelated', { queryVec: qv, minCosine: 0.9, minScore: 0.9 })).toBe('');
  });
});

describe('formatExemplars', () => {
  it('builds a bounded few-shot block from hits', () => {
    const hits = retrieve(buildIndex(corpus), 'annotate FieldError', 2);
    const block = formatExemplars(hits, { maxPatchChars: 50 });
    expect(block).toMatch(/retrieved patch memory/i);
    expect(block).toMatch(/prior resolved example 1/);
    expect(block).toContain('patch that resolved it');
  });
  it('returns empty string for no hits', () => {
    expect(formatExemplars([])).toBe('');
  });
});
