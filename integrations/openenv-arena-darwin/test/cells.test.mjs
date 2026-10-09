import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { defaultGenome, mutateGenome } from '../../../packages/darwin-mode/dist/numeric-mutator.js';
import {
  FAMILIES, RUNNER_KNOBS, genomeSpec, baselineGenome, genomeToCells, cellKey, knobArgs, checkProvenance,
} from '../lib/cells.mjs';

const PROV = Object.freeze({
  envSourceSha: 'a'.repeat(64), runnerSha: 'b'.repeat(64), serverSha: 'e'.repeat(64), runnerArgsSha: 'f'.repeat(64), model: 'qwen38', modelRevision: '1d4bf0f2',
  contextTokens: 16384, seedBase: 700000, attempts: 4,
});
const CELL = Object.freeze({ family: 'math_route', difficulty: 2, budget: 8192, knobs: {} });
// Test-only knob table exercising the future-knob code path (RUNNER_KNOBS itself is empty today).
const FAKE_KNOBS = { distractors: { spec: { min: 0, max: 8, scale: 'linear', type: 'int', default: 2 }, flag: '--distractors' } };
const ENV_DIR = process.env.DARWIN_ARENA_ENV_DIR ?? '/home/ruvultra/projects/metaharness-arena-v2/integrations/openenv-arena';
const TASKS_PY = `${ENV_DIR}/arena_env/tasks.py`;

test('FAMILIES matches the environment TASK_IDS', { skip: !existsSync(TASKS_PY) && `missing ${TASKS_PY}` }, () => {
  const src = readFileSync(TASKS_PY, 'utf8');
  const ids = [...src.match(/TASK_IDS\s*=\s*\[([\s\S]*?)\]/)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, [...FAMILIES]);
});

test('genomeSpec: difficulty int 1..3 linear, budget int 6889..16384 log, defaults = baselineGenome', () => {
  const spec = genomeSpec();
  assert.equal(Object.keys(spec).length, 16);
  for (const f of FAMILIES) {
    assert.deepEqual(spec[`${f}.difficulty`], { min: 1, max: 3, scale: 'linear', type: 'int', default: 2 });
    assert.deepEqual(spec[`${f}.budget`], { min: 6889, max: 16384, scale: 'log', type: 'int', default: 8192 });
  }
  assert.deepEqual(defaultGenome(spec), baselineGenome(), 'Darwin baseline == hand-tuned v2 setting');
  assert.deepEqual(Object.keys(genomeSpec({ families: ['math_route'] })), ['math_route.difficulty', 'math_route.budget']);
  assert.throws(() => genomeSpec({ families: ['chess'] }), /unknown family/);
  assert.throws(() => genomeSpec({ families: [] }), /non-empty/);
});

test('baselineGenome: difficulty 2, budget 8192 for every family', () => {
  const g = baselineGenome();
  for (const f of FAMILIES) assert.deepEqual([g[`${f}.difficulty`], g[`${f}.budget`]], [2, 8192]);
});

test('genomeToCells splits per family in FAMILIES order regardless of key order', () => {
  const g = baselineGenome();
  const reversed = Object.fromEntries(Object.entries(g).reverse());
  const cells = genomeToCells(reversed);
  assert.deepEqual(cells.map((c) => c.family), [...FAMILIES]);
  assert.deepEqual(cells[0], { family: 'software_change', difficulty: 2, budget: 8192, knobs: {} });
  assert.deepEqual(genomeToCells({ 'math_route.budget': 7000, 'math_route.difficulty': 3 }),
    [{ family: 'math_route', difficulty: 3, budget: 7000, knobs: {} }]);
});

test('genomeToCells rejects malformed genomes loudly', () => {
  const g = baselineGenome();
  const cases = [
    [{ ...g, 'chess.budget': 8192 }, /unknown family "chess"/],
    [{ 'math_route.difficulty': 2 }, /missing "math_route.budget"/],
    [{ ...g, 'math_route.difficulty': 4 }, /outside \[1, 3\]/],
    [{ ...g, 'math_route.budget': 2048 }, /outside \[6889, 16384\]/],
    [{ ...g, 'math_route.budget': 6000 }, /outside \[6889, 16384\]/],
    [{ ...g, 'math_route.budget': 8192.5 }, /must be an integer/],
    [{ ...g, 'math_route.difficulty': Number.NaN }, /must be an integer/],
    [{ ...g, nodot: 1 }, /not "<family>.<param>"/],
    [{ ...g, 'math_route.Bad-Knob': 1 }, /invalid knob name/],
    [{}, /no parameters/],
    [[1, 2], /must be an object/],
  ];
  for (const [genome, re] of cases) assert.throws(() => genomeToCells(genome), re);
});

test('future knob params are rejected explicitly today, never silently dropped', () => {
  assert.deepEqual(RUNNER_KNOBS, {});
  const g = { ...baselineGenome(), 'math_route.distractors': 3 };
  assert.throws(() => genomeToCells(g), /unsupported knob "distractors".*RUNNER_KNOBS/);
  assert.throws(() => genomeSpec({ knobs: ['distractors'] }), /unsupported knob "distractors"/);
});

test('knob code path works once a knob is registered (injected test table)', () => {
  const spec = genomeSpec({ families: ['math_route'], knobs: ['distractors'], runnerKnobs: FAKE_KNOBS });
  assert.deepEqual(Object.keys(spec), ['math_route.difficulty', 'math_route.budget', 'math_route.distractors']);
  const [cell] = genomeToCells({ ...defaultGenome(spec), 'math_route.distractors': 5 }, { runnerKnobs: FAKE_KNOBS });
  assert.deepEqual(cell.knobs, { distractors: 5 });
  assert.deepEqual(knobArgs(cell, { runnerKnobs: FAKE_KNOBS }), ['--distractors', '5']);
  assert.throws(() => knobArgs(cell), /unsupported knob/, 'default table still refuses it');
  assert.throws(() => genomeToCells({ ...defaultGenome(spec), 'math_route.distractors': 9 }, { runnerKnobs: FAKE_KNOBS }), /outside/);
  assert.notEqual(cellKey(cell, PROV), cellKey({ ...cell, knobs: {} }, PROV));
  assert.deepEqual(knobArgs(CELL), []);
});

test('cellKey is a canonical sha256 of {cell, provenance}', () => {
  const key = cellKey(CELL, PROV);
  assert.match(key, /^[a-f0-9]{64}$/);
  const shuffledCell = { knobs: {}, budget: 8192, family: 'math_route', difficulty: 2 };
  const shuffledProv = Object.fromEntries(Object.entries(PROV).reverse());
  assert.equal(cellKey(shuffledCell, shuffledProv), key, 'key order never matters');
  assert.equal(cellKey({ ...CELL, extra: 'ignored' }, PROV), key, 'only family/difficulty/budget/knobs are addressed');
  assert.notEqual(cellKey({ ...CELL, budget: 8193 }, PROV), key);
  assert.notEqual(cellKey({ ...CELL, difficulty: 3 }, PROV), key);
  const changed = { envSourceSha: 'c'.repeat(64), runnerSha: 'd'.repeat(64), serverSha: '1'.repeat(64), runnerArgsSha: '2'.repeat(64),
    model: 'other', modelRevision: 'r2',
    contextTokens: 8192, seedBase: 1, attempts: 8 };
  for (const [field, value] of Object.entries(changed)) {
    assert.notEqual(cellKey(CELL, { ...PROV, [field]: value }), key, `provenance.${field} must change the key`);
  }
});

test('cellKey refuses incomplete or invalid provenance (would collide across env/runner versions)', () => {
  const { envSourceSha, ...missing } = PROV;
  void envSourceSha;
  const bad = [missing, { ...PROV, extra: 1 }, { ...PROV, runnerSha: 'xyz' }, { ...PROV, serverSha: 'nope' }, { ...PROV, runnerArgsSha: undefined }, { ...PROV, attempts: 5 },
    { ...PROV, attempts: 0 }, { ...PROV, contextTokens: 0 }, { ...PROV, seedBase: -1 }, { ...PROV, model: 'a b' }, null];
  for (const p of bad) assert.throws(() => cellKey(CELL, p));
  assert.throws(() => cellKey({ ...CELL, family: 'chess' }, PROV), /invalid cell/);
  assert.throws(() => cellKey({ ...CELL, budget: 99999 }, PROV), /outside/);
  assert.equal(checkProvenance(PROV), PROV);
});

test('the one-param budget lattice is 6 evenly spaced values with no near-duplicates', async () => {
  const { stepParam } = await import('../lib/one-param-mutator.mjs');
  const spec = genomeSpec()['math_route.budget'];
  const seen = new Set([8192]); let frontier = [8192];
  while (frontier.length) frontier = frontier.flatMap(v => [1, -1].map(d => stepParam(v, spec, d, 0.2))).filter(v => !seen.has(v) && seen.add(v));
  assert.deepEqual([...seen].sort((a, b) => a - b), [6889, 8192, 9742, 11585, 13777, 16384]);
});

test('every Darwin mutation of the spec maps back to valid cells', () => {
  const spec = genomeSpec();
  let parent = baselineGenome();
  for (let gen = 1; gen <= 30; gen++) {
    const { genome } = mutateGenome(parent, spec, 7, gen, 0, 0.3);
    const cells = genomeToCells(genome);
    assert.equal(cells.length, 8);
    for (const c of cells) assert.ok(Number.isInteger(c.budget) && c.budget >= 6889 && c.budget <= 16384);
    parent = genome;
  }
});
