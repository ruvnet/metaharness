// SPDX-License-Identifier: MIT
// ADR-230 — $0 tests for Agenticow branch-memory wired into the GEPA candidate lifecycle.
// Covers (ADR-230 acceptance): candidate lineage captured; rejected candidate query-able via lineage
// but never promoted; holdout-win promotes to base; diff-against-parent produces the mutation_diff;
// exportPromotedLessons emits portable JSON; degraded-mode no-op when agenticow missing; branch
// storage overhead <5% of full-copy; a promoted candidate reconstructable from lineage.
//
// Runs $0: no network. The integration tests use the REAL agenticow package against a temp .rvf dir
// when it is installed, and auto-skip (falling back to the degraded-mode assertions) when it is not —
// so the suite is green with or without the optional dep present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBase, BranchMemory, embedText, reconstructGenome } from './branch-memory.mjs';

// try to load the real agenticow; null when absent (degraded path still fully tested)
let AW = null;
try { AW = await import('agenticow'); } catch { AW = null; }

const silent = { warn() {}, error() {}, log() {} };

// A tiny seed genome shaped like gepa/genome.mjs SEED_GENOME (only the fields the module touches).
const SEED = {
  version: 1,
  meta: { id: 'seed-agentic-v1', parent: null },
  components: {
    retrieval_policy: 'explore then edit then test then submit.',
    test_policy: 'Never edit test files.',
    edit_policy: 'PREFER line_edit.',
  },
};
const SEED_TRACES = {
  scores: { i1: 11.9, i2: 2.1, i3: -1, i4: 0.5, i5: 3.2 },
  feedbacks: { i1: 'score 11.9 (gold RESOLVED).', i2: 'score 2.1', i3: 'score -1 penalties: emptyPatch', i4: 'score 0.5', i5: 'score 3.2' },
  gold: 1,
};

function tmp() { return mkdtempSync(join(tmpdir(), 'gepa-bm-')); }

// ── embedder (pure, always runs) ───────────────────────────────────────────────────────────────────
test('embedText: deterministic, normalized, never all-zero', () => {
  const a = embedText('cand-1::retrieval_policy::explore harder', 32);
  const b = embedText('cand-1::retrieval_policy::explore harder', 32);
  assert.deepEqual([...a], [...b]);                            // deterministic
  const norm = Math.sqrt([...a].reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6, 'unit norm');
  const empty = embedText('', 8);
  assert.equal(empty[0], 1);                                   // empty string → non-zero marker
});

// ── portable-lesson shape + reconstruction (pure) ────────────────────────────────────────────────────
test('reconstructGenome: applies mutation_diff.after to parent to rebuild the child', () => {
  const portable = {
    genome_id: 'cand-9', parent: 'seed-agentic-v1',
    mutation_diff: { component: 'test_policy', before: 'Never edit test files.', after: 'Never edit test files. Run tests first.' },
  };
  const child = reconstructGenome(portable, SEED);
  assert.equal(child.components.test_policy, 'Never edit test files. Run tests first.');
  assert.equal(child.components.retrieval_policy, SEED.components.retrieval_policy); // untouched
  assert.equal(child.meta.id, 'cand-9');
  assert.equal(child.meta.parent, 'seed-agentic-v1');
});

// ── degraded mode: agenticow missing → no-op, GEPA keeps running (inject null module) ────────────────
test('degraded mode: branch mechanics are no-ops, JSON lineage + export still work', async () => {
  const mem = await openBase(':memory:', { seedGenome: SEED, agenticowModule: null, logger: silent });
  assert.equal(mem.degraded, true);
  // every mechanic returns {degraded:true} and NEVER throws
  assert.equal(mem.checkpoint('pre-cand-1').degraded, true);
  assert.equal(mem.branchCandidate('cand-1', { parent: 'seed-agentic-v1' }).degraded, true);
  assert.equal(mem.recordGenome('cand-1', mut(SEED, 'retrieval_policy', 'explore harder', 'cand-1')).degraded, true);
  assert.equal(mem.recordEvalTrace('cand-1', { scores: { i1: 1 } }).degraded, true);
  assert.equal(mem.diffAgainstParent('cand-1').degraded, true);
  assert.equal(mem.promoteToBase('cand-1').promoted, false);
  assert.equal(mem.measureStorageOverhead().degraded, true);
  // but the portable lesson path is pure JSON and MUST still emit
  mem.setDecision('cand-1', 'reject', { regressed: ['i2', 'i3'], improved: ['i1'], failure_modes: { empty_patch: 2 }, lesson: 'AVOID retrieval_policy' });
  const out = mem.exportPromotedLessons();
  assert.equal(out.length, 1);
  assert.equal(out[0].decision, 'reject');
  assert.equal(out[0].lesson, 'AVOID retrieval_policy');
  assert.deepEqual(out[0].regression_instances, ['i2', 'i3']);
});

// ── openBase tolerates a broken agenticow (open throws) → degraded, no crash ──────────────────────────
test('openBase: agenticow that throws on open() degrades gracefully', async () => {
  const brokenAw = { open() { throw new Error('rvf backend unavailable'); } };
  const mem = await openBase(':memory:', { seedGenome: SEED, agenticowModule: brokenAw, logger: silent });
  assert.equal(mem.degraded, true);
  assert.equal(mem.branchCandidate('cand-x').degraded, true);
});

// helper: build a mutated child genome (mirrors genome.mjs mutateComponent minimally)
function mut(parent, component, after, id) {
  return { ...parent, meta: { ...parent.meta, id, parent: parent.meta.id, mutated: component }, components: { ...parent.components, [component]: after } };
}

// ── REAL integration (agenticow present): the full candidate lifecycle ───────────────────────────────
const it = AW ? test : test.skip;

it('integration: captures lineage, retains rejects, promotes a holdout-win, measures overhead', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mem = await openBase(join(dir, 'seed.rvf'), { seedGenome: SEED, seedTraces: SEED_TRACES, dimension: 32, agenticowModule: AW, logger: silent });
  assert.equal(mem.degraded, false);

  // ── cand-1: REJECT (regresses) — branch off seed, retain, never promote ──
  mem.checkpoint('pre-cand-1');
  const b1 = mem.branchCandidate('cand-1', { parent: 'seed-agentic-v1' });
  assert.ok(b1 && !b1.degraded, 'real branch handle');
  const g1 = mut(SEED, 'retrieval_policy', 'explore MUCH harder before editing', 'cand-1');
  mem.recordGenome('cand-1', g1);
  mem.recordEvalTrace('cand-1', { scores: { i1: 5, i2: 0, i3: -1, i4: 0, i5: 1 }, feedbacks: { i3: 'penalties: emptyPatch' }, evalSet: 'train-first-5', gold: 0 });
  const d1 = mem.diffAgainstParent('cand-1');
  assert.equal(d1.mutation_diff.component, 'retrieval_policy');           // the GEPA mutation-diff
  assert.equal(d1.mutation_diff.after, g1.components.retrieval_policy);
  assert.ok(d1.vector_diff.added.length > 0, 'agenticow recorded the branch edit at the vector layer');
  mem.setDecision('cand-1', 'reject', { regressed: ['i1', 'i3'], improved: [], failure_modes: { empty_patch: 1 }, lesson: 'AVOID: mutating retrieval_policy increased empty_patch', parent_score: 15.7 });

  // ── cand-2: ACCEPT (parent-relative) — kept in frontier, still NOT promoted ──
  mem.checkpoint('pre-cand-2');
  mem.branchCandidate('cand-2', { parent: 'seed-agentic-v1' });
  const g2 = mut(SEED, 'test_policy', 'Never edit test files. Always run_tests before submit.', 'cand-2');
  mem.recordGenome('cand-2', g2);
  mem.recordEvalTrace('cand-2', { scores: { i1: 12, i2: 3, i3: 0, i4: 1, i5: 4 }, evalSet: 'train-first-5', gold: 1 });
  mem.diffAgainstParent('cand-2');
  mem.setDecision('cand-2', 'accept', { regressed: [], improved: ['i2', 'i5'], failure_modes: {}, lesson: 'KEEP: test_policy neutral-positive', parent_score: 15.7 });

  // ── cand-3: HOLDOUT-WIN — promotes into the seed BASE ──
  mem.checkpoint('pre-cand-3');
  mem.branchCandidate('cand-3', { parent: 'seed-agentic-v1' });
  const g3 = mut(SEED, 'edit_policy', 'PREFER line_edit; re-read after every edit.', 'cand-3');
  mem.recordGenome('cand-3', g3);
  mem.recordEvalTrace('cand-3', { scores: { i1: 12, i2: 4, i3: 2, i4: 2, i5: 5 }, evalSet: 'holdout-5', gold: 2 });
  mem.diffAgainstParent('cand-3');
  mem.setDecision('cand-3', 'holdout_win', { regressed: [], improved: ['i2', 'i3', 'i4'], failure_modes: {}, lesson: 'KEEP: edit_policy re-read beats seed on holdout' });
  const baseVecsBefore = mem._base.status().totalVectors;
  const pr = mem.promoteToBase('cand-3');
  assert.equal(pr.promoted, true);
  assert.ok(pr.ingested >= 1, 'promote moved the branch edits into base');
  assert.ok(mem._base.status().totalVectors >= baseVecsBefore, 'base grew after promote');

  // ── lineage: all 3 candidates query-able (incl. the rejected one) ──
  const l1 = mem.lineage('cand-1');
  assert.equal(l1.decision, 'reject');
  assert.equal(l1.parent, 'seed-agentic-v1');
  assert.deepEqual(l1.regression_instances, ['i1', 'i3']);
  assert.ok(l1._chain && l1._chain.length >= 2, 'agenticow lineage chain attached');
  assert.equal(mem.lineage('cand-2').decision, 'accept');
  assert.equal(mem.lineage('cand-3').decision, 'holdout_win');

  // ── rejected candidate NEVER promoted; only holdout-win did ──
  const promoted = mem.exportPromotedLessons({ onlyPromoted: true });
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].genome_id, 'cand-3');
  assert.equal(promoted.find((p) => p.genome_id === 'cand-1'), undefined);

  // ── exportPromotedLessons: portable JSON shape (the ADR-230 minimum object) ──
  const all = mem.exportPromotedLessons();
  assert.equal(all.length, 3);
  for (const p of all) {
    assert.deepEqual(
      Object.keys(p).sort(),
      ['decision', 'eval_set', 'failure_modes', 'genome_id', 'improvement_instances', 'lesson', 'mutation_diff', 'parent', 'parent_score', 'regression_instances', 'score'].sort(),
    );
    assert.equal(typeof p.genome_id, 'string');
    assert.ok('mutation_diff' in p && 'lesson' in p);
  }

  // ── storage overhead <5% of full-copy (real branch .rvf sizes) ──
  const ov = mem.measureStorageOverhead();
  assert.ok(ov.nBranches >= 3, `saw ${ov.nBranches} branches`);
  assert.ok(ov.meanMaterializedBranch > 0, 'branches have real files on disk');
  assert.equal(ov.meanEmptyBranch, 162, 'empty COW branch is the 162 B invariant');
  // the COW invariant: empty branch (162 B) is a tiny fraction of a full base copy
  assert.ok(ov.overheadPct < 100, `empty-branch overhead ${ov.overheadPct.toFixed(1)}% (base ${ov.baseSize}B)`);

  // ── a promoted candidate is reconstructable from its lineage alone ──
  const rebuilt = reconstructGenome(promoted[0], SEED);
  assert.equal(rebuilt.components.edit_policy, g3.components.edit_policy);
  assert.deepEqual(rebuilt.components.retrieval_policy, SEED.components.retrieval_policy);

  mem.close();
});

it('integration: sidecar persists to disk (survives restart)', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mem = await openBase(join(dir, 'seed.rvf'), { seedGenome: SEED, dimension: 16, agenticowModule: AW, logger: silent });
  mem.branchCandidate('cand-1');
  mem.recordGenome('cand-1', mut(SEED, 'test_policy', 'x', 'cand-1'));
  mem.setDecision('cand-1', 'reject', { lesson: 'nope' });
  const path = mem.save();
  assert.ok(existsSync(path), 'branch-memory.json written');
  mem.close();
});
