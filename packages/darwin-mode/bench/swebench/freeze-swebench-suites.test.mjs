// D1-S2 verifier ($0, node:test): the frozen SWE-bench holdout + anchor are immutable, disjoint,
// reproducible, and drawn from the source manifest. This is what makes the D1-S4 lift curve honest —
// the anchor can never be optimized against, and the fixtures can't silently drift.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { selectSuites, suiteHash, HOLDOUT_SIZE, ANCHOR_SIZE } from './freeze-swebench-suites.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(HERE, f), 'utf-8'));
const holdout = load('swebench-holdout-frozen.json');
const anchor = load('swebench-anchor-frozen.json');
const source = load('full-300.json');
const sourceInstances = source.instances ?? source;

test('sizes + schema', () => {
  assert.strictEqual(holdout.n, HOLDOUT_SIZE);
  assert.strictEqual(anchor.n, ANCHOR_SIZE);
  assert.strictEqual(holdout.instances.length, HOLDOUT_SIZE);
  assert.strictEqual(anchor.instances.length, ANCHOR_SIZE);
  assert.strictEqual(holdout.role, 'holdout');
  assert.strictEqual(anchor.role, 'anchor');
});

test('holdout and anchor are DISJOINT (the anchor is never optimized against)', () => {
  const h = new Set(holdout.instances.map((i) => i.instance_id));
  const overlap = anchor.instances.filter((i) => h.has(i.instance_id));
  assert.deepStrictEqual(overlap, []);
});

test('every frozen instance is drawn from the source manifest + carries the solver fields', () => {
  const src = new Set(sourceInstances.map((i) => i.instance_id));
  for (const i of [...holdout.instances, ...anchor.instances]) {
    assert.ok(src.has(i.instance_id), `${i.instance_id} not in source`);
    for (const f of ['instance_id', 'repo', 'base_commit', 'problem_statement']) {
      assert.ok(typeof i[f] === 'string' && i[f].length > 0, `${i.instance_id} missing ${f}`);
    }
  }
});

test('committed sha256 matches contents (IMMUTABLE — no silent drift)', () => {
  assert.strictEqual(holdout.sha256, suiteHash(holdout.instances));
  assert.strictEqual(anchor.sha256, suiteHash(anchor.instances));
});

test('selection is DETERMINISTIC — re-slicing the source reproduces the frozen fixtures byte-for-byte', () => {
  const { holdout: h2, anchor: a2 } = selectSuites(sourceInstances);
  assert.strictEqual(suiteHash(h2), holdout.sha256);
  assert.strictEqual(suiteHash(a2), anchor.sha256);
});
