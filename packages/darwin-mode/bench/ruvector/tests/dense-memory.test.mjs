// SPDX-License-Identifier: MIT
// Dense baseline memory-layer + embedder unit tests. Run: node --test tests/dense-memory.test.mjs
// (Dependency-free: tests ONLY DenseMemory + embedder, so CI needs no ruvector install.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DenseMemory } from '../memory-layer.mjs';
import { embedText, cosine, estimateTokens } from '../embedder.mjs';
import { makeSyntheticManifest, normalizeAnswer } from '../synthetic.mjs';

test('embedText is deterministic, L2-normalized, fixed-dim', () => {
  const a = embedText('hello world', 64);
  const b = embedText('hello world', 64);
  assert.equal(a.length, 64);
  assert.deepEqual([...a], [...b]);                       // deterministic
  let norm = 0; for (const x of a) norm += x * x;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-5);        // unit norm
});

test('cosine: identical=1, related>unrelated', () => {
  const q = embedText('the cat sat on the mat', 128);
  const same = embedText('the cat sat on the mat', 128);
  const related = embedText('a cat sat on a mat today', 128);
  const unrelated = embedText('quantum chromodynamics lattice gauge', 128);
  assert.ok(Math.abs(cosine(q, same) - 1) < 1e-5);
  assert.ok(cosine(q, related) > cosine(q, unrelated));
});

test('estimateTokens ~ chars/4', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens(''), 0);
});

test('DenseMemory: index + query returns most-similar doc first', async () => {
  const m = new DenseMemory({ dim: 256 });
  await m.index([
    { id: 'd1', text: 'photosynthesis converts sunlight into chemical energy in plants' },
    { id: 'd2', text: 'plate tectonics describes the movement of earth crustal plates' },
    { id: 'd3', text: 'monsoon seasonal wind brings heavy rainfall to south asia' },
  ]);
  const { hits, tokens } = await m.query('how do plants use sunlight for energy', { k: 2 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'd1');                         // photosynthesis doc ranks first
  assert.ok(tokens > 0);
  assert.ok(hits[0].score >= hits[1].score);             // sorted descending
});

test('DenseMemory: maxTokens budget trims context', async () => {
  const m = new DenseMemory({ dim: 128 });
  const big = 'word '.repeat(200);                         // ~250 tokens
  await m.index([{ id: 'a', text: big }, { id: 'b', text: big }, { id: 'c', text: big }]);
  const { hits, tokens } = await m.query('word', { k: 3, maxTokens: 300 });
  assert.ok(hits.length < 3);                              // budget stops before all 3
  assert.ok(tokens <= 300 + estimateTokens(big));         // at most one over-budget item kept
});

test('DenseMemory: feedback (solve-outcome) boosts retrieved docs, no gold param', async () => {
  const m = new DenseMemory({ dim: 128 });
  await m.index([{ id: 'g', text: 'alpha beta gamma' }, { id: 'x', text: 'alpha delta epsilon' }]);
  const before = (await m.query('alpha', { k: 2 })).hits.map((h) => h.id);
  // reinforce the runner-up on a "resolved" outcome
  const runnerUp = before[1];
  for (let i = 0; i < 20; i++) await m.feedback({ retrievedIds: [runnerUp], resolved: true, weight: 0.1 });
  const after = (await m.query('alpha', { k: 2 })).hits.map((h) => h.id);
  assert.equal(after[0], runnerUp);                       // reward bias lifted it to the top
  // feedback signature carries no gold field
  const f = await m.feedback({ retrievedIds: ['g'], resolved: false });
  assert.ok('applied' in f && 'delta' in f);
});

test('DenseMemory: mutate upsert + delete', async () => {
  const m = new DenseMemory({ dim: 64 });
  await m.index([{ id: 'a', text: 'first' }]);
  await m.mutate({ upsert: [{ id: 'b', text: 'second' }], delete: ['a'] });
  assert.ok(!m.docs.has('a'));
  assert.ok(m.docs.has('b'));
});

test('DenseMemory: branch is an independent COW clone', async () => {
  const m = new DenseMemory({ dim: 64 });
  await m.index([{ id: 'a', text: 'shared' }]);
  const child = await m.branch('c1');
  await child.mutate({ upsert: [{ id: 'b', text: 'child-only' }] });
  assert.ok(child.docs.has('b'));
  assert.ok(!m.docs.has('b'));                            // parent unchanged (COW isolation)
});

test('synthetic manifest is deterministic + leak-safe shape', () => {
  const a = makeSyntheticManifest(5, 42);
  const b = makeSyntheticManifest(5, 42);
  assert.equal(a.length, 5);
  assert.deepEqual(a.map((t) => t.answer), b.map((t) => t.answer)); // deterministic by seed
  for (const t of a) {
    assert.ok(t.question && t.answer && Array.isArray(t.corpus));
    // gold answer marker lives in the CORPUS (RAG-visible), exactly once
    const marked = t.corpus.filter((d) => d.text.includes(`ANSWER=${t.answer}`));
    assert.equal(marked.length, 1);
    // the question itself must NOT contain the answer (no leak into the prompt source)
    assert.ok(!normalizeAnswer(t.question).includes(normalizeAnswer(t.answer)));
  }
});
