// Run: node --experimental-strip-types --test integrations/openenv-arena-darwin/test/cluster-failures.test.mjs
// Network-free: synthetic vectors and an in-memory fake store. The live ruvector CLI round-trip runs
// only with RUVECTOR_IT=1 (it shells out to `npx -y ruvector@0.3.3`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkVector, clusterGraph, collectFailures, cosine, describeClusters, embedEpisode, episodeText,
  knnInProcess, knnRuvector } from '../cluster-failures.mjs';
import { parseSearchOutput, parseStatsCount, ruvectorStore } from '../lib/ruvector.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'darwin-cluster-test-'));
// Deterministic PRNG so the synthetic groups are reproducible.
const rng = (s => () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648))(7);
const around = (axis, dim, noise) => Array.from({ length: dim }, (_, i) => (i === axis ? 1 : 0) + (rng() - 0.5) * noise);
const groups = () => [0, 1, 2].flatMap(g => Array.from({ length: 4 }, (_, j) => ({ id: `g${g}m${j}`, group: g, vector: around(g, 8, 0.1) })));

// In-memory stand-in for ruvectorStore with ruvector's measured semantics (score = cosine distance).
function fakeStore({ countDelta = 0, distanceSkew = 0, dropSelf = false } = {}) {
  let rows = [];
  return { db: '/fake/failures.db', cmd: 'fake', reset() { rows = []; }, async create() {},
    async insert(entries) { rows = entries; }, async count() { return rows.length + countDelta; },
    async search(v, k) {
      return rows.map(r => ({ id: r.id, distance: 1 - cosine(v, r.vector) + (r.vector === v ? 0 : distanceSkew) }))
        .filter(r => !(dropSelf && r.distance < 1e-9)).sort((a, b) => a.distance - b.distance).slice(0, k)
        .map((r, i) => ({ rank: i + 1, ...r }));
    } };
}

test('parseSearchOutput reads ids and distances from ANSI-coloured CLI output and rejects other formats', () => {
  const out = '\n\x1b[36mSearch Results:\x1b[39m\n\n\x1b[37m1. ID: f0001\x1b[39m\n\x1b[33m   Score: 0.0000\x1b[39m\n'
    + '\x1b[90m   Metadata: {"family":"math_route"}\x1b[39m\n\n2. ID: f0007\n   Score: 0.0061\n';
  assert.deepEqual(parseSearchOutput(out), [{ rank: 1, id: 'f0001', distance: 0 }, { rank: 2, id: 'f0007', distance: 0.0061 }]);
  assert.deepEqual(parseSearchOutput('Search Results:\n'), []);
  assert.throws(() => parseSearchOutput('Failed to search'), /unrecognised/);
  assert.throws(() => parseSearchOutput('Search Results:\n\n2. ID: a\n   Score: 0.1\n'), /rank_gap/);
  assert.equal(parseStatsCount('Database Stats:\n  Vector Count: 42\n  Dimension: 384'), 42);
  assert.throws(() => parseStatsCount('nothing'), /unrecognised/);
  assert.throws(() => ruvectorStore({}), /db_dir_required/);
  assert.throws(() => ruvectorStore({ dbDir: '/tmp/x', name: '../evil' }), /name_invalid/);
});

test('in-process kNN + union-find recovers three synthetic groups; a high threshold isolates everything', () => {
  const items = groups(), nb = knnInProcess(items, 3);
  const { clusters } = clusterGraph(items.map(i => i.id), nb, { threshold: 0.9 });
  assert.equal(clusters.length, 3);
  for (const c of clusters) assert.equal(new Set(c.map(id => id[1])).size, 1, `mixed cluster ${c}`);
  assert.deepEqual(clusters.map(c => c.length), [4, 4, 4]);
  assert.equal(clusterGraph(items.map(i => i.id), nb, { threshold: 1.01 }).clusters.length, 12);
  const desc = describeClusters(clusters, items.map(i => ({ ...i, family: `fam${i.group}`, cls: 'reasoning', failure: null,
    finish: 'stop', difficulty: 2, reward: 0.5, text: `text ${i.id}` })));
  assert.equal(desc[0].exemplars.length, 2);
  assert.ok(desc.every(d => d.cohesion > 0.9 && Object.keys(d.families).length === 1));
});

test('union-find merges chains, mutual mode drops one-sided edges', () => {
  const nb = new Map([['a', [{ id: 'b', sim: 0.99 }]], ['b', [{ id: 'c', sim: 0.98 }]], ['c', [{ id: 'b', sim: 0.98 }]], ['d', [{ id: 'a', sim: 0.5 }]]]);
  assert.deepEqual(clusterGraph(['a', 'b', 'c', 'd'], nb, { threshold: 0.9 }).clusters, [['a', 'b', 'c'], ['d']]);
  assert.deepEqual(clusterGraph(['a', 'b', 'c', 'd'], nb, { threshold: 0.9, mutual: true }).clusters, [['b', 'c'], ['a'], ['d']]);
  assert.equal(clusterGraph(['a'], new Map([['a', [{ id: 'a', sim: NaN }]]]), { threshold: 0 }).edges, 0);
});

test('knnRuvector matches exact kNN on a faithful store and refuses a store whose receipts disagree', async () => {
  const items = groups();
  const { neighbors, receipt } = await knnRuvector(items, 3, fakeStore());
  const exact = knnInProcess(items, 3);
  for (const it of items) assert.deepEqual(neighbors.get(it.id).map(n => n.id).sort(), exact.get(it.id).map(n => n.id).sort());
  assert.equal(receipt.count, 12); assert.equal(receipt.selfHits, 12); assert.ok(receipt.maxAbsErr < 1e-9);
  await assert.rejects(knnRuvector(items, 3, fakeStore({ countDelta: -1 })), /count_mismatch/);
  await assert.rejects(knnRuvector(items, 3, fakeStore({ distanceSkew: 0.2 })), /disagrees_with_cosine/);
  await assert.rejects(knnRuvector(items, 3, fakeStore({ dropSelf: true })), /self_match_missing/);
});

const msg = (role, content) => ({ role, content });
const obs = o => JSON.stringify({ done: false, reward: 0, error: '', ...o });
function rows() {
  const sys = msg('system', 'schema'), first = msg('user', obs({})), read = msg('assistant', '{"op":"read","path":"*"}');
  const ep = (o) => ({ type: 'episode', task_id: 'finance_ledger', difficulty: 2, seed: 1, attempt: 0, calls: 2, ...o });
  return [
    { type: 'plan', plan: {} },
    ep({ reward: 1, solved: true, failure: null, trajectoryDigest: 'a'.repeat(64), trajectory: { messages: [sys, first] } }),
    ep({ reward: 0.5, failure: null, seed: 2, trajectoryDigest: 'b'.repeat(64), trajectory: { messages: [sys, first, read, msg('user', obs({})),
      msg('assistant', '{"op":"submit","answer":{"closing_cents":{"acct_0":1}}}'), msg('user', obs({ done: true, reward: 0.5 }))],
      provider_metrics: [{ finish_reason: 'stop' }] } }),
    ep({ reward: 0, failure: 'completion_truncated', seed: 3, trajectoryDigest: 'c'.repeat(64),
      trajectory: { messages: [sys, first, read, msg('user', obs({})), msg('assistant', '')], provider_metrics: [{ finish_reason: 'stop' }, { finish_reason: 'length' }] } }),
    ep({ reward: 0, failure: 'ValidationError', seed: 4, trajectoryDigest: 'd'.repeat(64), trajectory: { messages: [sys, first, read, msg('user', obs({}))] } }),
    ep({ reward: 0, failure: 'ValidationError', seed: 4, trajectoryDigest: 'd'.repeat(64), trajectory: { messages: [] } }),
    ep({ reward: 1.5, failure: null, seed: 5, trajectory: { messages: [] } }),
  ];
}

test('collectFailures keeps non-solved episodes, dedupes digests, counts malformed/invalid rows, labels texts', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'cell.jsonl'), `${rows().map(r => JSON.stringify(r)).join('\n')}\n{not json\n`);
    const { episodes, inputs, stats } = collectFailures([dir]);
    assert.equal(stats.episodes, 6); assert.equal(stats.solved, 1); assert.equal(stats.duplicates, 1);
    assert.equal(stats.malformed, 1); assert.equal(stats.invalid, 1);
    assert.equal(inputs.length, 1); assert.match(inputs[0].sha256, /^[a-f0-9]{64}$/);
    // Shared lib/fitness.mjs rules: a v1 ValidationError with no plan cap cannot rule out a length cut -> truncation.
    assert.deepEqual(episodes.map(e => e.cls), ['partial', 'truncation', 'truncation']);
    assert.deepEqual(episodes.map(e => e.reason), ['partial_credit', 'completion_truncated', 'ValidationError:legacy_length_cut_not_excluded']);
    assert.deepEqual(episodes.map(e => e.finish), ['stop', 'length', 'unrecorded']);
    assert.match(episodes[0].text, /^family=finance_ledger difficulty=2 class=partial failure=none finish=stop reward=0\.5 \| final_obs: done=true error=none reward=0\.5 \| last_assistant: \{"op":"submit"/);
    assert.match(episodes[1].text, /last_assistant: \(empty reply\)$/);
    assert.match(episodes[2].text, /last_assistant: \(failing reply not recorded\)$/);
    const throwing = collectFailures([dir], () => { throw new Error('boom'); });
    assert.equal(throwing.stats.invalid, 4, 'rejected rows are counted invalid, never reclassified by other rules');
    assert.equal(throwing.episodes.length, 0);
    const detailed = collectFailures([dir], (row, ctx) => ({ cls: 'truncation', reason: `cap:${ctx.cap}` }), rs => ({ cap: rs.length }));
    assert.deepEqual(detailed.episodes.map(e => [e.cls, e.reason]), Array(3).fill(['truncation', 'cap:7']));
    assert.equal(collectFailures([dir], () => 'bogus').stats.invalid, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('clustering labels episodes with the same rules the fitness scores them by', () => {
  const dir = tmp();
  try {
    const ep = (seed, o) => ({ type: 'episode', task_id: 'math_route', difficulty: 3, seed, attempt: 0, trajectory: { messages: [] }, ...o });
    const lines = [{ type: 'plan', plan: { max_tokens_per_request: 4096 } },
      ep(1, { reward: 0, failure: 'request_timeout' }),
      ep(2, { reward: 0, failure: 'episode_completion_budget_exhausted' }),
      ep(3, { reward: 0, failure: 'step_budget_exhausted' }), // fitness: truncation (the runner's 8-step cap is an artefact)
      ep(4, { reward: 0, failure: 'ValidationError', total_tokens_reported: 604 }), // v1, below the 4096 request cap: format
      ep(5, { reward: 0, failure: 'some_new_code' }), // unknown codes fail closed to infra
      ep(6, { reward: 0.75, failure: null })];
    writeFileSync(join(dir, 'cell.jsonl'), `${lines.map(r => JSON.stringify(r)).join('\n')}\n`);
    assert.deepEqual(collectFailures([dir]).episodes.map(e => e.cls),
      ['infra', 'truncation', 'truncation', 'format', 'infra', 'partial']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(episodeText({ task_id: 'x', difficulty: 1, reward: 0, failure: null, trajectory: {} }, 'reasoning').includes('(no assistant reply)'), true);
});

test('embedding guards: fail closed on bad vectors, trim the tail on context overflow', async () => {
  assert.throws(() => checkVector([1, NaN], 2), /invalid_embedding/);
  assert.throws(() => checkVector([1, 2, 3], 2), /invalid_embedding/);
  assert.throws(() => checkVector([0, 0], 2), /zero_embedding/);
  const overflow = async t => { if (t.length > 50) throw new Error('embed_context_overflow'); return [1, 0]; };
  const r = await embedEpisode('x'.repeat(80), overflow);
  assert.equal(r.trimmed, true); assert.ok(r.text.length <= 53);
  await assert.rejects(embedEpisode('x'.repeat(10_000), overflow), /overflow/);
  await assert.rejects(embedEpisode('x', async () => { throw new Error('embed_http_500'); }), /http_500/);
});

test('live ruvector CLI round-trip on synthetic vectors (RUVECTOR_IT=1)', { skip: process.env.RUVECTOR_IT !== '1' }, async () => {
  const dir = tmp();
  try {
    const items = groups();
    const { neighbors, receipt } = await knnRuvector(items, 3, ruvectorStore({ dbDir: dir }));
    assert.equal(receipt.count, 12); assert.equal(receipt.selfHits, 12); assert.ok(receipt.maxAbsErr < 1e-3);
    const { clusters } = clusterGraph(items.map(i => i.id), neighbors, { threshold: 0.9 });
    assert.deepEqual(clusters.map(c => c.length), [4, 4, 4]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
