// SPDX-License-Identifier: MIT
// ADR-228 §9.1 — ported from bench/swebench/gepa/genome.test.mjs (assertions unchanged): the
// BYTE-EQUIVALENCE regression guard (seed genome must reassemble to exactly today's prompts —
// checked against the in-repo bench prompt builders) + validation + immutable mutation.
import { test } from 'vitest';
import assert from 'node:assert/strict';
// @ts-expect-error — untyped in-repo reference implementation (bench, not shipped)
import { buildAgenticSystem } from '../bench/swebench/agentic-loop.mjs';
// @ts-expect-error — untyped in-repo reference implementation (bench, not shipped)
import { buildAdvisedSystem, buildAdvisorSystem } from '../bench/swebench/advisor-loop.mjs';
import {
  SEED_GENOME, buildSystemFromGenome, buildAdvisorSystemFromGenome,
  validateGenome, mutateComponent, renderComponent, loadGenome,
} from '../src/gepa/genome.js';

const LANGS: Array<[string, string]> = [['py', '*.py'], ['go', '*.go'], ['js', '*.js'], ['rs', '*.rs']];

test('REGRESSION GUARD: seed genome renders byte-identical to buildAgenticSystem (solo/D0)', () => {
  for (const [ext, glob] of LANGS) {
    assert.equal(buildSystemFromGenome(SEED_GENOME, ext, glob), buildAgenticSystem(ext, glob), `solo ${ext}`);
  }
  // default args too (the exported AGENTIC_SYSTEM constant path)
  assert.equal(buildSystemFromGenome(SEED_GENOME), buildAgenticSystem());
});

test('REGRESSION GUARD: seed genome (advised) renders byte-identical to buildAdvisedSystem', () => {
  for (const [ext, glob] of LANGS) {
    assert.equal(buildSystemFromGenome(SEED_GENOME, ext, glob, { advised: true }), buildAdvisedSystem(ext, glob), `advised ${ext}`);
  }
});

test('REGRESSION GUARD: seed verifier_prompt renders byte-identical to buildAdvisorSystem', () => {
  for (const [ext] of LANGS) {
    assert.equal(buildAdvisorSystemFromGenome(SEED_GENOME, ext), buildAdvisorSystem(ext), `advisor ${ext}`);
  }
});

test('JSON round-trip preserves byte-equivalence (genome survives file persistence)', () => {
  const roundTripped = JSON.parse(JSON.stringify(SEED_GENOME));
  assert.equal(buildSystemFromGenome(roundTripped, 'py', '*.py'), buildAgenticSystem('py', '*.py'));
  assert.equal(buildSystemFromGenome(roundTripped, 'go', '*.go', { advised: true }), buildAdvisedSystem('go', '*.go'));
});

test('validateGenome: seed is valid; missing/non-string components are flagged', () => {
  assert.deepEqual(validateGenome(SEED_GENOME), []);
  assert.ok(validateGenome(null).length > 0);
  assert.ok(validateGenome({}).length > 0);
  const missing = { ...SEED_GENOME, components: { ...SEED_GENOME.components } };
  delete (missing.components as Record<string, string>).retrieval_policy;
  assert.ok(validateGenome(missing).some((p) => p.includes('retrieval_policy')));
  const nonString = { ...SEED_GENOME, components: { ...SEED_GENOME.components, edit_policy: 42 } };
  assert.ok(validateGenome(nonString).some((p) => p.includes('edit_policy')));
});

test('mutateComponent: fresh object, parent untouched, rendered output changes, lineage recorded', () => {
  const before = buildSystemFromGenome(SEED_GENOME, 'py', '*.py');
  const kid = mutateComponent(SEED_GENOME, 'retrieval_policy',
    'Strategy: read the traceback file FIRST, then at most 2 greps; edit within 5 steps.', { id: 'cand-1' });
  assert.notEqual(kid.components.retrieval_policy, SEED_GENOME.components.retrieval_policy);
  assert.equal(buildSystemFromGenome(SEED_GENOME, 'py', '*.py'), before, 'parent must be untouched (no in-place mutation)');
  assert.notEqual(buildSystemFromGenome(kid, 'py', '*.py'), before);
  assert.equal(kid.meta!.id, 'cand-1');
  assert.equal(kid.meta!.parent, SEED_GENOME.meta!.id);
  assert.equal(kid.meta!.mutated, 'retrieval_policy');
  assert.throws(() => mutateComponent(SEED_GENOME, 'no_such_component', 'x'), /unknown component/);
});

test('mutating a tool description changes only that line', () => {
  const kid = mutateComponent(SEED_GENOME, 'tool_grep',
    '{"tool":"grep","pattern":"reg","glob":"{{glob}}"}     search the repo — MAX 2 grep misses, then read a file');
  const a = buildSystemFromGenome(SEED_GENOME, 'py', '*.py').split('\n');
  const b = buildSystemFromGenome(kid, 'py', '*.py').split('\n');
  assert.equal(a.length, b.length);
  const diffLines = a.map((l, i) => l !== b[i] ? i : -1).filter((i) => i >= 0);
  assert.equal(diffLines.length, 1, 'exactly one line differs');
  assert.match(b[diffLines[0]], /MAX 2 grep misses/);
});

test('renderComponent substitutes all placeholder occurrences', () => {
  assert.equal(renderComponent('a {{ext}} b {{ext}} c {{glob}}', 'go', '*.go'), 'a go b go c *.go');
});

test('empty optional strategy components are skipped without double spaces', () => {
  const kid = mutateComponent(SEED_GENOME, 'test_policy', '');
  const sys = buildSystemFromGenome(kid, 'py', '*.py');
  assert.ok(!sys.includes('Never edit test files.'));
  const strategyLine = sys.split('\n').at(-1)!; // tool lines legitimately contain space runs; the join must not
  assert.ok(!strategyLine.includes('  '), 'no double space from the strategy join');
});

test('loadGenome validates and rejects broken files', () => {
  const files: Record<string, string> = { '/g/ok.json': JSON.stringify(SEED_GENOME), '/g/bad.json': JSON.stringify({ components: {} }) };
  const read = (p: string) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; };
  assert.deepEqual(loadGenome(read, '/g/ok.json').components, SEED_GENOME.components);
  assert.throws(() => loadGenome(read, '/g/bad.json'), /invalid genome/);
});
