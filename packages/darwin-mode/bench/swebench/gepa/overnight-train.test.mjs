// SPDX-License-Identifier: MIT
// $0 tests for overnight-train.mjs — the resumable, budget-governed GEPA training loop. The learn.mjs
// subprocess is MOCKED (an injected `runLearn`) so NO GEPA/LLM call ever happens. Covers: queue
// advancement, resume-from-state (skip non-pending), budget-cap stop (records deferred), the
// promote-rule gating (promote registers SHADOW; reject does not), and idempotency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seedQueue, freshState, freshRegistry, selectNextJob, pendingCount,
  budgetReserve, canAfford, deferRemaining, registerShadow, applyLearnResult,
  iterateOnce, summaryLine, SKIP_STATUSES,
} from './overnight-train.mjs';

// A mock learn runner: returns a promotion report of the requested verdict + a cost. NEVER spends.
const mockLearn = ({ verdict, cost, candidate = 'cand-X', key, holdout }) => async (job) => ({
  reportPath: `/mock/report-${job.id}.json`,
  cost,
  report: {
    verdict,
    key: key ?? `ruvultra+${job.model}+code-repair+python+bug-fix+${candidate}`,
    keyParts: { host: 'ruvultra', model: job.model, vertical: 'code-repair', language: 'python', task_class: 'bug-fix', genome_version: candidate },
    slice: job.manifest,
    seed: 'cand-6',
    candidate,
    gains: verdict === 'promote' ? ['inst-8'] : [],
    reason: verdict === 'promote' ? 'PROMOTE: ...' : 'REJECT: ...',
    checks: { goldNoRegress: true, emptyPatchImproves: verdict === 'promote', costPerResolvedNotWorse: true },
    holdout: holdout ?? { seed: { gold: 2 }, cand: { gold: verdict === 'promote' ? 3 : 2 } },
    run: { best: candidate, budget: { totalCost: cost } },
  },
});

test('seedQueue: one runnable pending, two in_progress_elsewhere, two placeholders', () => {
  const q = seedQueue();
  assert.equal(pendingCount(q), 1);
  assert.equal(q.filter((j) => j.status === 'in_progress_elsewhere').length, 2);
  assert.equal(q.filter((j) => j.status === 'placeholder').length, 2);
  // the runnable one is the glm-5.2 seeded-from-cand6 code-repair job
  const next = selectNextJob(q);
  assert.equal(next.id, 'glm52-cand6-code-repair');
  assert.equal(next.model, 'z-ai/glm-5.2');
  assert.match(next.seed_genome, /cand6/);
});

test('selectNextJob skips every non-pending status (resume semantics)', () => {
  const q = seedQueue();
  // simulate the acceptance-run jobs + placeholders already covered; only pending should be picked
  for (const j of q) if (j.status === 'pending') { j.status = 'done'; }
  assert.equal(selectNextJob(q), null); // nothing pending left
  for (const s of ['done', 'in_progress_elsewhere', 'deferred', 'placeholder', 'failed']) {
    assert.ok(SKIP_STATUSES.has(s), `${s} must be a skip status`);
  }
});

test('budget gate: reserve is min(job cap, per-job cap); canAfford blocks over-cap', () => {
  const state = freshState({ maxTotalCost: 20, perJobMaxCost: 12 });
  const job = { max_cost: 12 };
  assert.equal(budgetReserve(job, 12), 12);
  assert.equal(budgetReserve({ max_cost: 5 }, 12), 5); // job cap tighter
  assert.equal(budgetReserve({ max_cost: 50 }, 12), 12); // per-job cap tighter
  state.cumulativeSpend = 8; // 8 + 12 = 20 <= 20 → affordable
  assert.equal(canAfford(state, job), true);
  state.cumulativeSpend = 9; // 9 + 12 = 21 > 20 → NOT affordable
  assert.equal(canAfford(state, job), false);
});

test('iterateOnce: a promote runs the job, registers a SHADOW, marks done, advances spend', async () => {
  const state = freshState({ maxTotalCost: 100, perJobMaxCost: 12 });
  const registry = freshRegistry();
  const out = await iterateOnce({ state, registry, runLearn: mockLearn({ verdict: 'promote', cost: 7.5, candidate: 'cand-9' }) });
  assert.equal(out.status, 'ran');
  assert.equal(out.promoted, true);
  assert.equal(state.queue.find((j) => j.id === 'glm52-cand6-code-repair').status, 'done');
  assert.equal(state.cumulativeSpend, 7.5);
  assert.equal(registry.shadows.length, 1);
  assert.equal(registry.shadows[0].rank, 'SHADOW');
  assert.equal(registry.shadows[0].genomeVersion, 'cand-9');
  assert.equal(registry.shadows[0].holdoutGold, 3);
  assert.match(out.message, /PROMOTE→SHADOW/);
});

test('iterateOnce: a reject runs + spends but does NOT register a SHADOW', async () => {
  const state = freshState({ maxTotalCost: 100, perJobMaxCost: 12 });
  const registry = freshRegistry();
  const out = await iterateOnce({ state, registry, runLearn: mockLearn({ verdict: 'reject', cost: 6.0 }) });
  assert.equal(out.status, 'ran');
  assert.equal(out.promoted, false);
  assert.equal(registry.shadows.length, 0); // reject → no registry mutation
  assert.equal(state.cumulativeSpend, 6.0);
  assert.equal(state.queue.find((j) => j.id === 'glm52-cand6-code-repair').result.verdict, 'reject');
});

test('resume-from-state: a done job is skipped; the loop reports empty when nothing pending', async () => {
  const state = freshState();
  const registry = freshRegistry();
  await iterateOnce({ state, registry, runLearn: mockLearn({ verdict: 'promote', cost: 5 }) });
  // now only in_progress_elsewhere + placeholders remain — nothing pending
  const out2 = await iterateOnce({ state, registry, runLearn: mockLearn({ verdict: 'promote', cost: 5 }) });
  assert.equal(out2.status, 'empty');
  assert.equal(out2.done, true);
  assert.equal(state.cumulativeSpend, 5); // second call did NOT spend again
});

test('budget-cap stop: an unaffordable job + all remaining pending become deferred', async () => {
  const state = freshState({ maxTotalCost: 10, perJobMaxCost: 12 });
  // add a second pending job so we can prove BOTH get deferred
  state.queue.push({ id: 'extra-pending', model: 'm', workflow: 'code-repair', seed_genome: 's', manifest: 'x.json', train_first: 12, max_cost: 12, status: 'pending', result: null });
  const registry = freshRegistry();
  const out = await iterateOnce({ state, registry, runLearn: mockLearn({ verdict: 'promote', cost: 5 }) });
  assert.equal(out.status, 'budget_stop'); // 0 + 12 > 10 → cannot even start
  assert.equal(out.done, true);
  assert.equal(state.cumulativeSpend, 0); // never spent
  assert.equal(pendingCount(state.queue), 0); // all pending → deferred
  assert.equal(state.queue.filter((j) => j.status === 'deferred').length, 2);
});

test('never exceed the cap: a mid-queue job that would overshoot defers instead of running', async () => {
  const state = freshState({ maxTotalCost: 12, perJobMaxCost: 12 });
  state.queue.push({ id: 'second', model: 'm', workflow: 'code-repair', seed_genome: 's', manifest: 'x.json', train_first: 12, max_cost: 12, status: 'pending', result: null });
  const registry = freshRegistry();
  // first job spends 8 → cumulative 8
  const a = await iterateOnce({ state, registry, runLearn: mockLearn({ verdict: 'reject', cost: 8 }) });
  assert.equal(a.status, 'ran');
  assert.equal(state.cumulativeSpend, 8);
  // second job would reserve 12 → 8+12=20 > 12 cap → deferred, spend unchanged
  const b = await iterateOnce({ state, registry, runLearn: mockLearn({ verdict: 'promote', cost: 8 }) });
  assert.equal(b.status, 'budget_stop');
  assert.equal(state.cumulativeSpend, 8);
  assert.ok(state.cumulativeSpend <= state.maxTotalCost);
});

test('registerShadow idempotency: same composite key updates in place, never stacks', () => {
  const reg = freshRegistry();
  registerShadow(reg, { key: 'K1', genomeVersion: 'cand-9', holdoutGold: 3 });
  registerShadow(reg, { key: 'K1', genomeVersion: 'cand-9', holdoutGold: 4 }); // re-run, better number
  registerShadow(reg, { key: 'K2', genomeVersion: 'cand-12', holdoutGold: 5 });
  assert.equal(reg.shadows.length, 2); // K1 updated in place, K2 added
  assert.equal(reg.shadows.find((s) => s.key === 'K1').holdoutGold, 4);
});

test('iterateOnce idempotency: re-running after done neither re-spends nor re-registers', async () => {
  const state = freshState();
  const registry = freshRegistry();
  await iterateOnce({ state, registry, runLearn: mockLearn({ verdict: 'promote', cost: 5, key: 'K' }) });
  const spendAfter1 = state.cumulativeSpend;
  const shadowsAfter1 = registry.shadows.length;
  // repeated invocation — no pending left → empty, no mutation
  await iterateOnce({ state, registry, runLearn: mockLearn({ verdict: 'promote', cost: 5, key: 'K' }) });
  assert.equal(state.cumulativeSpend, spendAfter1);
  assert.equal(registry.shadows.length, shadowsAfter1);
});

test('dry-run plans without spending or mutating the queue', async () => {
  const state = freshState();
  const registry = freshRegistry();
  const out = await iterateOnce({ state, registry, dryRun: true, runLearn: async () => { throw new Error('must not run'); } });
  assert.equal(out.status, 'planned');
  assert.equal(state.cumulativeSpend, 0);
  assert.equal(selectNextJob(state.queue).status, 'pending'); // still pending
  assert.match(out.message, /PLAN glm52-cand6-code-repair/);
});

test('a failed job is marked failed (not done) and does not register a SHADOW', async () => {
  const state = freshState();
  const registry = freshRegistry();
  const boom = async () => { throw new Error('subprocess died'); };
  const out = await iterateOnce({ state, registry, runLearn: boom });
  assert.equal(out.status, 'failed');
  assert.equal(state.queue.find((j) => j.id === 'glm52-cand6-code-repair').status, 'failed');
  assert.equal(registry.shadows.length, 0);
  assert.equal(state.cumulativeSpend, 0);
});

test('deferRemaining is idempotent and leaves non-pending statuses untouched', () => {
  const q = seedQueue();
  deferRemaining(q);
  const afterFirst = q.map((j) => j.status);
  deferRemaining(q); // second call — no change
  assert.deepEqual(q.map((j) => j.status), afterFirst);
  // in_progress_elsewhere + placeholder preserved
  assert.equal(q.filter((j) => j.status === 'in_progress_elsewhere').length, 2);
  assert.equal(q.filter((j) => j.status === 'placeholder').length, 2);
});

test('summaryLine renders a single grep-able Monitor line', () => {
  const s = { jobId: 'j', model: 'z-ai/glm-5.2', promoted: true, verdict: 'promote', seedHoldoutGold: 2, holdoutGold: 3, cost: 7.5, cumulativeSpend: 7.5, maxTotalCost: 100, pendingLeft: 0 };
  const line = summaryLine(s);
  assert.match(line, /^\[overnight\] JOB j/);
  assert.match(line, /PROMOTE→SHADOW/);
  assert.match(line, /holdoutGold=2→3/);
  assert.match(line, /spend=\$7\.5\/\$100/);
});
