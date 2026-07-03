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
  resolveBackend, reservedSpend, canAffordConcurrent, claimNextJob, reclaimInProgress,
  isDeferrableError, backoffMs, runPool, smokeSeedQueue,
  GATEWAY_BASE_URL, GATEWAY_API_KEY_ENV, GATEWAY_MODEL, DEFAULT_CONCURRENCY,
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

// ── gateway backend resolution ────────────────────────────────────────────────────────────────────

test('resolveBackend: default is OpenRouter-direct (no base-url/key-env/model override)', () => {
  const b = resolveBackend({});
  assert.equal(b.viaGateway, false);
  assert.equal(b.baseUrl, null);
  assert.equal(b.apiKeyEnv, null);
  assert.equal(b.modelOverride, null);
});

test('resolveBackend: --via-gateway points at the cognitum meta-llm API + cognitum-low', () => {
  const b = resolveBackend({ viaGateway: true });
  assert.equal(b.viaGateway, true);
  assert.equal(b.baseUrl, GATEWAY_BASE_URL);
  assert.equal(b.apiKeyEnv, GATEWAY_API_KEY_ENV);
  assert.equal(b.modelOverride, GATEWAY_MODEL);
  assert.equal(b.modelOverride, 'cognitum-low');
});

test('resolveBackend: explicit overrides win + trailing slash stripped from base-url', () => {
  const b = resolveBackend({ viaGateway: true, baseUrl: 'https://x/v1/', apiKeyEnv: 'MY_KEY', model: 'cognitum-mid' });
  assert.equal(b.baseUrl, 'https://x/v1');
  assert.equal(b.apiKeyEnv, 'MY_KEY');
  assert.equal(b.modelOverride, 'cognitum-mid');
});

// ── concurrency: shared reservation budget gate ─────────────────────────────────────────────────────

test('reservedSpend sums only in_progress jobs; canAffordConcurrent respects the reservation', () => {
  const state = freshState({ maxTotalCost: 30, perJobMaxCost: 12 });
  state.queue = [
    { id: 'a', max_cost: 12, status: 'in_progress' },
    { id: 'b', max_cost: 12, status: 'in_progress' },
    { id: 'c', max_cost: 12, status: 'pending' },
  ];
  assert.equal(reservedSpend(state.queue, 12), 24); // two in-flight × 12
  // 0 spend + 24 reserved + 12 = 36 > 30 → the 3rd cannot be claimed concurrently
  assert.equal(canAffordConcurrent(state, state.queue[2]), false);
  state.queue[1].status = 'done'; // free one reservation
  assert.equal(reservedSpend(state.queue, 12), 12);
  assert.equal(canAffordConcurrent(state, state.queue[2]), true); // 0 + 12 + 12 = 24 <= 30
});

test('claimNextJob: claimed marks in_progress; budget when unaffordable; empty when none pending', () => {
  const state = freshState({ maxTotalCost: 12, perJobMaxCost: 12 });
  state.queue = [{ id: 'a', max_cost: 12, status: 'pending' }, { id: 'b', max_cost: 12, status: 'pending' }];
  const c1 = claimNextJob(state);
  assert.equal(c1.kind, 'claimed');
  assert.equal(c1.job.status, 'in_progress');
  const c2 = claimNextJob(state); // a reserves 12, cap is 12 → b cannot fit
  assert.equal(c2.kind, 'budget');
  assert.equal(c2.job.id, 'b');
  state.queue.forEach((j) => { j.status = 'done'; });
  assert.equal(claimNextJob(state).kind, 'empty');
});

test('reclaimInProgress flips crashed in_progress jobs back to pending (resume-safety)', () => {
  const state = freshState();
  state.queue[0].status = 'in_progress';
  const n = reclaimInProgress(state);
  assert.equal(n, 1);
  assert.equal(state.queue[0].status, 'pending');
  assert.equal(state.queue[0].result.reclaimed, true);
});

// ── 429 / deferrable classification ─────────────────────────────────────────────────────────────────

test('isDeferrableError catches 429/rate-limit/budget; a plain crash is NOT deferrable', () => {
  assert.equal(isDeferrableError(new Error('429 rate-limited by gateway')), true);
  assert.equal(isDeferrableError(new Error('Reserve-and-Commit budget reject')), true);
  assert.equal(isDeferrableError(new Error('too many requests')), true);
  assert.equal(isDeferrableError(new Error('segfault in solver')), false);
  assert.equal(isDeferrableError({ stderrTail: 'HTTP 429 Too Many Requests' }), true);
});

test('backoffMs is exponential and capped at 60s', () => {
  assert.equal(backoffMs(0), 1000);
  assert.equal(backoffMs(1), 2000);
  assert.equal(backoffMs(3), 8000);
  assert.equal(backoffMs(20), 60000); // capped
});

// ── the bounded concurrency pool ────────────────────────────────────────────────────────────────────

// A pool-friendly mock: resolves after a tick, records max concurrent in-flight, can throw 429.
function poolMock({ verdict = 'reject', cost = 5, throwOn = new Set(), rate429On = new Set(), track } = {}) {
  return async (job) => {
    if (track) { track.inFlight++; track.max = Math.max(track.max, track.inFlight); }
    await new Promise((r) => setTimeout(r, 5));
    if (track) track.inFlight--;
    if (rate429On.has(job.id)) throw new Error('429 rate-limited by gateway');
    if (throwOn.has(job.id)) throw new Error('hard subprocess crash');
    return {
      reportPath: null, cost,
      report: { verdict, key: `k+${job.id}`, candidate: 'cand-X', gains: [], reason: verdict, checks: {}, holdout: { seed: { gold: 1 }, cand: { gold: verdict === 'promote' ? 2 : 1 } }, run: { budget: { totalCost: cost } } },
    };
  };
}

test('runPool: advances MULTIPLE jobs concurrently (up to the concurrency bound)', async () => {
  const state = freshState({ maxTotalCost: 100, perJobMaxCost: 12 });
  state.queue = Array.from({ length: 5 }, (_, i) => ({ id: `j${i}`, model: 'm', workflow: 'code-repair', seed_genome: 's', manifest: 'x.json', train_first: 1, max_cost: 2, status: 'pending', result: null }));
  const registry = freshRegistry();
  const track = { inFlight: 0, max: 0 };
  const { results } = await runPool({ state, registry, runLearn: poolMock({ cost: 2, track }), concurrency: 3, sleep: async () => {} });
  assert.equal(results.filter((r) => r.status === 'ran').length, 5); // all ran
  assert.ok(track.max >= 2, `expected concurrent in-flight >= 2, got ${track.max}`); // proves parallelism
  assert.ok(track.max <= 3, `must not exceed the concurrency bound of 3, got ${track.max}`);
  assert.equal(pendingCount(state.queue), 0);
  assert.equal(state.cumulativeSpend, 10); // 5 × 2
});

test('runPool: shared reservation never lets concurrent jobs collectively overspend the cap', async () => {
  const state = freshState({ maxTotalCost: 20, perJobMaxCost: 12 });
  // 4 jobs × reserve 12 would be 48; cap 20 → at most one runs, then defer (0+12=12<=20, but 12+12=24>20)
  state.queue = Array.from({ length: 4 }, (_, i) => ({ id: `j${i}`, model: 'm', workflow: 'code-repair', seed_genome: 's', manifest: 'x.json', train_first: 1, max_cost: 12, status: 'pending', result: null }));
  const registry = freshRegistry();
  const { results, deferredBudget } = await runPool({ state, registry, runLearn: poolMock({ cost: 12 }), concurrency: 4, sleep: async () => {} });
  assert.equal(deferredBudget, true);
  assert.ok(state.cumulativeSpend <= state.maxTotalCost, `spend ${state.cumulativeSpend} must be <= cap ${state.maxTotalCost}`);
  assert.equal(results.filter((r) => r.status === 'ran').length, 1); // only one fit under the cap
  assert.ok(state.queue.some((j) => j.status === 'deferred'));
});

test('runPool: a 429 marks the job DEFERRED (not failed) and the pool keeps going', async () => {
  const state = freshState({ maxTotalCost: 100, perJobMaxCost: 12 });
  state.queue = [
    { id: 'ok1', model: 'm', workflow: 'code-repair', seed_genome: 's', manifest: 'x.json', train_first: 1, max_cost: 2, status: 'pending', result: null },
    { id: 'rl', model: 'm', workflow: 'code-repair', seed_genome: 's', manifest: 'x.json', train_first: 1, max_cost: 2, status: 'pending', result: null },
    { id: 'ok2', model: 'm', workflow: 'code-repair', seed_genome: 's', manifest: 'x.json', train_first: 1, max_cost: 2, status: 'pending', result: null },
  ];
  const registry = freshRegistry();
  let slept = 0;
  const { results } = await runPool({ state, registry, runLearn: poolMock({ cost: 2, rate429On: new Set(['rl']) }), concurrency: 2, sleep: async (ms) => { slept += ms; } });
  assert.equal(state.queue.find((j) => j.id === 'rl').status, 'deferred');
  assert.equal(state.queue.find((j) => j.id === 'ok1').status, 'done');
  assert.equal(state.queue.find((j) => j.id === 'ok2').status, 'done');
  assert.ok(slept > 0, 'a deferred 429 must trigger a backoff sleep');
  assert.ok(results.some((r) => r.status === 'deferred'));
});

test('runPool: a hard error marks the job FAILED (not deferred); other jobs still complete', async () => {
  const state = freshState({ maxTotalCost: 100, perJobMaxCost: 12 });
  state.queue = [
    { id: 'boom', model: 'm', workflow: 'code-repair', seed_genome: 's', manifest: 'x.json', train_first: 1, max_cost: 2, status: 'pending', result: null },
    { id: 'fine', model: 'm', workflow: 'code-repair', seed_genome: 's', manifest: 'x.json', train_first: 1, max_cost: 2, status: 'pending', result: null },
  ];
  const registry = freshRegistry();
  await runPool({ state, registry, runLearn: poolMock({ throwOn: new Set(['boom']) }), concurrency: 2, sleep: async () => {} });
  assert.equal(state.queue.find((j) => j.id === 'boom').status, 'failed');
  assert.equal(state.queue.find((j) => j.id === 'fine').status, 'done');
});

test('runPool: resume skips done jobs and only advances remaining pending', async () => {
  const state = freshState({ maxTotalCost: 100, perJobMaxCost: 12 });
  state.queue = [
    { id: 'already', model: 'm', workflow: 'code-repair', seed_genome: 's', manifest: 'x.json', train_first: 1, max_cost: 2, status: 'done', result: { cost: 2 } },
    { id: 'todo', model: 'm', workflow: 'code-repair', seed_genome: 's', manifest: 'x.json', train_first: 1, max_cost: 2, status: 'pending', result: null },
  ];
  const registry = freshRegistry();
  const { results } = await runPool({ state, registry, runLearn: poolMock({ cost: 3 }), concurrency: 4, sleep: async () => {} });
  assert.equal(results.length, 1); // only the pending one ran
  assert.equal(results[0].job.id, 'todo');
  assert.equal(state.cumulativeSpend, 3); // the done job was NOT re-spent
});

test('runPool: a promote registers a SHADOW; persist hook is called after each commit', async () => {
  const state = freshState({ maxTotalCost: 100, perJobMaxCost: 12 });
  state.queue = [{ id: 'p', model: 'z-ai/glm-5.2', workflow: 'code-repair', seed_genome: 's', manifest: 'x.json', train_first: 1, max_cost: 5, status: 'pending', result: null }];
  const registry = freshRegistry();
  let persists = 0;
  const { results } = await runPool({ state, registry, runLearn: poolMock({ verdict: 'promote', cost: 4 }), concurrency: 2, persist: () => { persists++; }, sleep: async () => {} });
  assert.equal(results[0].promoted, true);
  assert.equal(registry.shadows.length, 1);
  assert.equal(registry.shadows[0].rank, 'SHADOW');
  assert.ok(persists >= 1, 'persist must be called after a commit');
});

test('runPool: dry-run plans all pending jobs without spending or mutating status', async () => {
  const state = freshState({ maxTotalCost: 100, perJobMaxCost: 12 });
  const registry = freshRegistry();
  const { results } = await runPool({ state, registry, runLearn: async () => { throw new Error('must not run'); }, dryRun: true, concurrency: 2 });
  assert.equal(results.every((r) => r.status === 'planned'), true);
  assert.equal(state.cumulativeSpend, 0);
  assert.equal(pendingCount(state.queue), 1); // seedQueue has exactly one pending, untouched
});

test('runPool: maxJobs caps how many jobs launch this wake', async () => {
  const state = freshState({ maxTotalCost: 100, perJobMaxCost: 12 });
  state.queue = Array.from({ length: 5 }, (_, i) => ({ id: `j${i}`, model: 'm', workflow: 'code-repair', seed_genome: 's', manifest: 'x.json', train_first: 1, max_cost: 2, status: 'pending', result: null }));
  const registry = freshRegistry();
  const { results } = await runPool({ state, registry, runLearn: poolMock({ cost: 2 }), concurrency: 4, maxJobs: 2, sleep: async () => {} });
  assert.equal(results.filter((r) => r.status === 'ran').length, 2);
  assert.equal(pendingCount(state.queue), 3); // the other 3 remain pending for the next wake
});

test('smokeSeedQueue: exactly two cheap trivial pending jobs sharing the genome prefix', () => {
  const q = smokeSeedQueue();
  assert.equal(q.length, 2);
  assert.equal(pendingCount(q), 2);
  assert.ok(q.every((j) => j.max_cost <= 0.1));
  assert.equal(DEFAULT_CONCURRENCY, 4);
});
