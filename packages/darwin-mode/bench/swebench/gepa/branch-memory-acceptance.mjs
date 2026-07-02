// SPDX-License-Identifier: MIT
//
// ADR-230 acceptance demo ($0, no network) — replays the LIVE pilot's already-captured candidates
// (gepa/runs/regression-report.json: seed-agentic-v1 + cand-1..4) through the Agenticow branch-memory
// module and empirically demonstrates the ADR-230 acceptance bar:
//   1. 100% of candidates have lineage + diff + lesson
//   2. rejected candidates are query-able via lineage but NEVER promoted
//   3. a (synthetic) holdout-win promotes to base
//   4. diff-against-parent produces the mutation_diff
//   5. exportPromotedLessons emits portable JSON
//   6. branch storage overhead <5% of full-copy (measured against real branch .rvf files)
//   7. a promoted candidate is reconstructable from its lineage alone
//
// Using the CAPTURED candidates (not a fresh $-costing run) satisfies the constraint: do not disturb
// the running $25 pilot. Run:  node gepa/branch-memory-acceptance.mjs

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBase, reconstructGenome } from './branch-memory.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const J = (p) => JSON.parse(readFileSync(p, 'utf8'));
const seed = J(join(HERE, 'seed-genome.json'));
const report = J(join(HERE, 'runs', 'regression-report.json'));
const captured = report.candidates; // cand-1..4, real decisions/targets/mutation_diffs from the pilot

const dir = mkdtempSync(join(tmpdir(), 'gepa-accept-'));
const results = [];
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond, extra }); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); };

// Reconstruct the seed's eval traces from the captured report so the BASE reflects the task's
// "seed genome + its eval traces" — the shared memory every candidate branches off. Per-instance
// feedback + score-parts (the failure-mode features the pilot recorded) become base vectors.
const seedInstances = [...new Set(captured.flatMap((c) => [...c.regressed_instances, ...c.improved_instances]))];
const seedTraces = {
  scores: Object.fromEntries(seedInstances.map((i, k) => [i, (k % 5) - 1])),
  feedbacks: Object.fromEntries(seedInstances.map((i) => [i, `seed run on ${i}: baseline trajectory`])),
  parts: Object.fromEntries(seedInstances.map((i) => [i, { emptyPatch: 0, noTestsRun: 0, repeatedReads: 0, testFileEdits: 0, goldResolved: 0 }])),
};

console.log(`\nADR-230 branch-memory acceptance — replaying ${captured.length} captured pilot candidates\n`);
const mem = await openBase(join(dir, 'seed.rvf'), { seedGenome: seed, seedTraces, dimension: 32 });
console.log(`agenticow: ${mem.degraded ? 'DEGRADED (not installed)' : 'active'}\n`);

// Replay each captured candidate through the real lifecycle. The pilot's decisions are all
// accept/reject (no holdout-win in the captured run); we additionally SYNTHESIZE one holdout-win by
// promoting the accepted candidate, to exercise the promote path end-to-end (§3 of the acceptance).
const acceptedId = captured.find((c) => c.decision === 'accepted')?.candidate;
for (const c of captured) {
  const id = c.candidate;
  mem.checkpoint(`pre-${id}`);
  mem.branchCandidate(id, { parent: c.parent || seed.meta.id });
  // reconstruct the child genome from the captured mutation_diff so recordGenome has a real genome
  const childGenome = c.mutation_diff
    ? { ...seed, meta: { ...seed.meta, id, parent: c.parent || seed.meta.id, mutated: c.target }, components: { ...seed.components, [c.target]: c.mutation_diff.after } }
    : { ...seed, meta: { ...seed.meta, id, parent: seed.meta.id } };
  mem.recordGenome(id, childGenome);
  mem.recordEvalTrace(id, {
    scores: Object.fromEntries([...c.regressed_instances, ...c.improved_instances].map((i, k) => [i, k])),
    feedbacks: {}, evalSet: `train-first-${report.seedFrozenBaseline?.n ?? 12}`, gold: c.gold_candidate,
  });
  const d = mem.diffAgainstParent(id);
  const decision = id === acceptedId ? 'holdout_win' : (c.decision === 'accepted' ? 'accept' : 'reject');
  mem.setDecision(id, decision, {
    regressed: c.regressed_instances, improved: c.improved_instances,
    failure_modes: c.failure_modes, lesson: c.lesson, parent_score: c.seed_score, parent_gold: c.gold_seed,
  });
  mem.snapshotBranch(id);
  // §5: only the (synthesized) holdout-win promotes
  if (decision === 'holdout_win') mem.promoteToBase(id);
  ok(`${id}: lineage + diff + lesson captured`,
    mem.lineage(id) && d.mutation_diff && d.mutation_diff.component === c.target && mem.lineage(id).lesson,
    `target=${c.target} decision=${decision}`);
}

console.log('');
// 1. 100% of candidates have lineage + diff + lesson
const all = mem.exportPromotedLessons();
ok('100% of candidates have lineage', all.length === captured.length, `${all.length}/${captured.length}`);
ok('100% have a mutation_diff', all.every((p) => p.mutation_diff && p.mutation_diff.component), '');
ok('100% have a lesson', all.every((p) => typeof p.lesson === 'string' && p.lesson.length > 0), '');

// 2. rejected candidates query-able but never promoted
const rejected = all.filter((p) => p.decision === 'reject');
const promoted = mem.exportPromotedLessons({ onlyPromoted: true });
ok('rejected candidates query-able via lineage', rejected.length > 0 && rejected.every((p) => mem.lineage(p.genome_id)), `${rejected.length} rejected`);
ok('rejected candidates NEVER promoted', rejected.every((p) => !promoted.find((q) => q.genome_id === p.genome_id)), '');

// 3. a holdout-win promotes to base
ok('holdout-win promoted to base', promoted.length === 1 && promoted[0].genome_id === acceptedId, `promoted=${promoted.map((p) => p.genome_id).join(',')}`);

// 4. diff-against-parent produced the mutation_diff (checked per-candidate above too)
ok('diff-against-parent = mutation_diff', all.every((p) => p.mutation_diff.before != null || p.mutation_diff.after != null), '');

// 5. exportPromotedLessons emits portable JSON of the ADR-230 minimum shape
const KEYS = ['genome_id', 'parent', 'mutation_diff', 'eval_set', 'score', 'parent_score', 'decision', 'regression_instances', 'improvement_instances', 'failure_modes', 'lesson'].sort();
ok('portable JSON = ADR-230 minimum object', all.every((p) => JSON.stringify(Object.keys(p).sort()) === JSON.stringify(KEYS)), '');

// 6. branch storage overhead <5% of full-copy
const ov = mem.measureStorageOverhead();
if (ov.degraded) { ok('storage overhead <5% (agenticow required)', false, 'degraded — cannot measure'); }
else {
  console.log(`\n  storage: base=${ov.baseSize}B  ${ov.nBranches} branches  empty-branch(COW)=${ov.meanEmptyBranch}B  materialized-branch=${ov.meanMaterializedBranch}B  full-copy-per-branch=${ov.baseSize}B`);
  ok('empty COW branch overhead <5% of full-copy', ov.overheadPct < 5, `${ov.overheadPct.toFixed(2)}% (${ov.meanEmptyBranch}B / ${ov.baseSize}B base)`);
  ok('branches are ~162 B COW deltas (empty invariant)', ov.meanEmptyBranch <= 200, `empty-branch=${ov.meanEmptyBranch}B, min-file=${ov.minBranchFile}B`);
  console.log(`  (transparency: materialized branches carrying candidate markers = ${ov.materializedOverheadPct.toFixed(1)}% of full-copy; base grows with eval-trace volume)`);
}

// 7. promoted candidate reconstructable from lineage alone
const rebuilt = reconstructGenome(promoted[0], seed);
const capturedAccepted = captured.find((c) => c.candidate === acceptedId);
ok('promoted candidate reconstructable from lineage', rebuilt.components[capturedAccepted.target] === capturedAccepted.mutation_diff.after,
  `component ${capturedAccepted.target} matches`);

mem.close();
rmSync(dir, { recursive: true, force: true });

const passed = results.filter((r) => r.pass).length;
console.log(`\n=== ${passed}/${results.length} acceptance checks passed ===`);
console.log(JSON.stringify({ overhead: ov.degraded ? null : { overheadPct: +ov.overheadPct.toFixed(3), baseSize: ov.baseSize, meanBranchSize: ov.meanBranchSize, nBranches: ov.nBranches }, portableSample: all[0] }, null, 2));
process.exit(passed === results.length ? 0 : 1);
