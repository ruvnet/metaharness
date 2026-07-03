// SPDX-License-Identifier: MIT
// NEW in 0.8.0 — the shipped cand-6 promoted genome: path resolves, loads, validates, renders,
// and stays byte-identical to the in-repo promotion artifact.
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CAND6_GENOME_PATH, loadCand6Genome, validateGenome, buildSystemFromGenome } from '../src/gepa/index.js';

test('CAND6_GENOME_PATH points at the shipped genomes/ artifact', () => {
  assert.ok(existsSync(CAND6_GENOME_PATH), CAND6_GENOME_PATH);
  assert.match(CAND6_GENOME_PATH, /genomes[\\/]genome-promoted-cand6-edit-by-midpoint\.json$/);
});

test('loadCand6Genome: validates, carries cand-6 lineage, renders a system prompt', () => {
  const g = loadCand6Genome();
  assert.deepEqual(validateGenome(g), []);
  assert.equal(g.meta!.id, 'cand-6');
  assert.equal(g.meta!.parent, 'cand-5');
  assert.equal(g.meta!.mutated, 'test_policy');
  const sys = buildSystemFromGenome(g, 'py', '*.py');
  assert.match(sys, /an imperfect edit beats an empty patch/i); // the edit-by-midpoint mechanism
  assert.ok(!sys.includes('{{ext}}') && !sys.includes('{{glob}}'), 'placeholders rendered');
});

test('shipped cand-6 is byte-identical to the in-repo promotion artifact', () => {
  const shipped = readFileSync(CAND6_GENOME_PATH, 'utf8');
  const reference = readFileSync(new URL('../bench/swebench/gepa/genome-promoted-cand6-edit-by-midpoint.json', import.meta.url), 'utf8');
  assert.equal(shipped, reference);
});
