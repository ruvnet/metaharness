// SPDX-License-Identifier: MIT
//
// `overnight-train.mjs` — a RESUMABLE, queue-driven, budget-governed training loop over the GEPA
// learning system (ADR-228). It is designed to be re-invoked once per wake (ScheduleWakeup cadence)
// rather than run as a tight infinite loop: each invocation runs ONE pending job, records state, and
// exits. A new session picks up exactly where the last left off by reading the state file.
//
// WHAT ONE ITERATION DOES:
//   1. Load (or seed) the STATE FILE (queue + per-job status/result + cumulative spend).
//   2. Pick the next `pending` job (skips done / in_progress_elsewhere / deferred / placeholder).
//   3. BUDGET GATE — reserve the job's max_cost against the global cap. If it could exceed the cap,
//      mark this + all remaining pending jobs `deferred` and stop cleanly (never exceed the cap).
//   4. Run `metaharness learn` (learn.mjs) for the job — one GEPA optimization + holdout eval.
//   5. Apply the STRICT promote-on-holdout rule (learn.mjs already computes the verdict in its
//      promotion report: gold-no-regress ∧ holdout-empty-patch-improves ∧ cost/resolved-not-worse).
//   6. On PROMOTE → register the winner in the genome registry as a SHADOW entry + keep the report.
//   7. Mark the job `done` with its result, add its cost to cumulative spend, persist state + registry.
//   8. Emit ONE summary line (for a Monitor to consume) and exit.
//
// RESUME: on restart the loop reads overnight-train-state.json and skips every job whose status is
// not `pending`. So `done`, `in_progress_elsewhere` (the acceptance run's jobs), `deferred`, and
// `placeholder` are all left alone — a new session continues mid-queue with zero duplicate spend.
//
// CONCURRENCY (`--concurrency N`, default 4): instead of one job per wake, a BOUNDED POOL runs up to N
// queue jobs at once (each job's own rollouts are already concurrent inside evaluate-genome). A shared
// client-side budget RESERVATION (reservedSpend over in-flight jobs) guarantees the pool can never
// collectively overshoot the global cap: a job is only claimed if cumulativeSpend + reservedSpend +
// its reserve still fits. On a 429 / budget-reject (deferrable error) a job is marked `deferred`
// (not `failed`) so a later wake retries it.
//
// GATEWAY (`--via-gateway`): points every rollout + reflection at the cognitum meta-llm Completions API
// (host-normalization + shared genome-prefix response/prompt cache + central metering in usage_ledger).
// It flows `--base-url` + `--api-key-env` + `--model cognitum-low` down learn.mjs → run-gepa.mjs →
// evaluate-genome.mjs → solve-advisor.mjs. The gateway's SERVER-SIDE Reserve-and-Commit budget +
// rate-limits govern the AGGREGATE, so even many concurrent training jobs can't collectively overspend.
// The direct-OpenRouter path stays the DEFAULT fallback (no `--via-gateway` ⇒ unchanged behaviour).
// (API for bulk rollouts here; MCP tools are for interactive dev — see OVERNIGHT-TRAINING.md.)
//
// $0 SAFETY: the pure decision functions (job selection, budget gates, promotion application, registry
// mutation, the concurrency claim + defer logic) are exported and unit-tested with a MOCKED learn
// runner in overnight-train.test.mjs. Nothing here calls an LLM by itself — spend happens only inside
// learn.mjs → run-gepa.mjs (OPENROUTER_API_KEY) or, with --via-gateway, the cognitum key env.
// `--dry-run` performs NO spend (prints the plan for each pending job).
//
// Usage:
//   OPENROUTER_API_KEY=... node gepa/overnight-train.mjs [--max-total-cost 100] [--max-cost 12]
//                                 [--concurrency 4] [--max-jobs 0] [--state <file>] [--registry <file>]
//                                 [--dry-run] [--status] [--reset]
//   # gateway-governed, concurrent (key from env, NEVER logged):
//   COGNITUM_DEV_KEY=... node gepa/overnight-train.mjs --via-gateway --concurrency 4
//   node gepa/overnight-train.mjs --status         # inspect the queue + spend, no spend, no mutation
//   node gepa/overnight-train.mjs --dry-run        # plan the next pending job(s), no spend

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, '..');
const rel = (p) => (isAbsolute(p) ? p : join(BENCH, p));

export const DEFAULT_MAX_TOTAL_COST = 100; // global cap for the whole overnight run ($)
export const DEFAULT_PER_JOB_MAX_COST = 12; // per-job cap ($) — also passed to learn.mjs --max-cost
export const DEFAULT_CONCURRENCY = 4; // bounded pool size (queue jobs run at once)

// The cognitum meta-llm Completions API backing --via-gateway (ADR-203/204). The key lives ONLY in the
// COGNITUM_DEV_KEY env var (fetched from the COGNITUM_TEST_API_KEY secret by the caller) and is NEVER
// logged or persisted. cognitum-low routes server-side to the governed cheap tier (glm-5.2).
export const GATEWAY_BASE_URL = 'https://apicompletions-63rzcdswba-uc.a.run.app/v1';
export const GATEWAY_API_KEY_ENV = 'COGNITUM_DEV_KEY';
export const GATEWAY_MODEL = 'cognitum-low';

// Statuses that are terminal / not-runnable and are always skipped on resume. `in_progress` is NOT here
// (it is a live-pool status); a crash leaves in_progress jobs, which reclaimInProgress() flips back to
// pending on the next load so they are retried, not orphaned.
export const SKIP_STATUSES = new Set(['done', 'in_progress_elsewhere', 'deferred', 'placeholder', 'failed']);

// ── seed queue ────────────────────────────────────────────────────────────────────────────────────
// Each job: { id, model, workflow, seed_genome, manifest, train_first, max_cost, status, result }.
//   status: pending | in_progress_elsewhere | placeholder | done | deferred | failed
// The seed is intentionally conservative: exactly ONE runnable code-repair job (glm-5.2 seeded from
// the promoted cand-6 genome, to push past its 5/12 train ceiling); the deepseek + glm-seeded jobs
// the live ACCEPTANCE run is already doing are marked `in_progress_elsewhere` so we never dup-spend;
// business verticals are `placeholder` until their manifests + seed genomes are wired.
export function seedQueue() {
  return [
    {
      id: 'glm52-cand6-code-repair',
      model: 'z-ai/glm-5.2',
      workflow: 'code-repair',
      seed_genome: 'gepa/genome-promoted-cand6-edit-by-midpoint.json',
      manifest: 'advisor-medium-25.json',
      train_first: 12,
      max_cost: 12,
      status: 'pending',
      note: 'push the promoted cand-6 base past 5/12 train on the medium-25 slice',
      result: null,
    },
    {
      id: 'deepseek-v4-flash-code-repair',
      model: 'deepseek/deepseek-v4-flash',
      workflow: 'code-repair',
      seed_genome: 'gepa/seed-genome.json',
      manifest: 'advisor-medium-25.json',
      train_first: 12,
      max_cost: 12,
      status: 'in_progress_elsewhere',
      note: 'the live acceptance run (a636763 worktree) owns this — skip, do not dup-spend',
      result: null,
    },
    {
      id: 'glm52-seed-code-repair',
      model: 'z-ai/glm-5.2',
      workflow: 'code-repair',
      seed_genome: 'gepa/seed-genome.json',
      manifest: 'advisor-medium-25.json',
      train_first: 12,
      max_cost: 12,
      status: 'in_progress_elsewhere',
      note: 'the live acceptance run (a636763 worktree) owns this glm-from-seed run — skip',
      result: null,
    },
    {
      id: 'triage-vertical-placeholder',
      model: 'z-ai/glm-5.2',
      workflow: 'business-triage',
      seed_genome: null,
      manifest: null,
      train_first: 12,
      max_cost: 12,
      status: 'placeholder',
      note: 'business-vertical: support/issue triage — wire a manifest + seed genome to activate',
      result: null,
    },
    {
      id: 'rli-mini-vertical-placeholder',
      model: 'z-ai/glm-5.2',
      workflow: 'business-rli-mini',
      seed_genome: null,
      manifest: null,
      train_first: 12,
      max_cost: 12,
      status: 'placeholder',
      note: 'business-vertical: rli-mini — wire a manifest + seed genome to activate',
      result: null,
    },
  ];
}

export function freshState({ maxTotalCost = DEFAULT_MAX_TOTAL_COST, perJobMaxCost = DEFAULT_PER_JOB_MAX_COST } = {}) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    maxTotalCost,
    perJobMaxCost,
    cumulativeSpend: 0,
    queue: seedQueue(),
    log: [], // one entry per completed iteration (for Monitor / audit)
  };
}

export function freshRegistry() {
  return { version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), shadows: [] };
}

/**
 * Two TRIVIAL pending jobs for the ≤$0.20 gateway smoke (used with `--smoke --via-gateway --reset`).
 * They exercise the concurrency pool + the gateway backend resolution, but the smoke runner replaces
 * the GEPA rollout with a pair of cheap cognitum-low completions — see makeSmokeRunLearn.
 */
export function smokeSeedQueue() {
  return [
    { id: 'smoke-job-1', model: 'z-ai/glm-5.2', workflow: 'code-repair', seed_genome: 'gepa/seed-genome.json', manifest: 'advisor-medium-25.json', train_first: 1, max_cost: 0.1, status: 'pending', note: 'gateway smoke — cheap cognitum-low completions, no GEPA', result: null },
    { id: 'smoke-job-2', model: 'z-ai/glm-5.2', workflow: 'code-repair', seed_genome: 'gepa/seed-genome.json', manifest: 'advisor-medium-25.json', train_first: 1, max_cost: 0.1, status: 'pending', note: 'gateway smoke — shares the genome-prefix so the repeat is a cache-hit', result: null },
  ];
}

// ── pure decision helpers ($0-tested) ───────────────────────────────────────────────────────────

/** Next runnable job = the first `pending` one (all other statuses are skipped on resume). */
export function selectNextJob(queue = []) {
  return queue.find((j) => j.status === 'pending') || null;
}

/** Count of jobs still pending. */
export function pendingCount(queue = []) {
  return queue.filter((j) => j.status === 'pending').length;
}

/**
 * BUDGET GATE. A job is affordable only if reserving its per-job cap still fits under the global cap:
 *   cumulativeSpend + reserve <= maxTotalCost.
 * `reserve` = min(job.max_cost, perJobMaxCost) so neither cap is ever exceeded. Reserving BEFORE the
 * run (not reconciling after) is what guarantees we never blow the cap even on a worst-case job.
 */
export function budgetReserve(job, perJobMaxCost = DEFAULT_PER_JOB_MAX_COST) {
  const jobCap = typeof job.max_cost === 'number' ? job.max_cost : perJobMaxCost;
  return Math.min(jobCap, perJobMaxCost);
}
export function canAfford(state, job) {
  const reserve = budgetReserve(job, state.perJobMaxCost);
  return state.cumulativeSpend + reserve <= state.maxTotalCost + 1e-9;
}

/**
 * Mark the current job + every remaining `pending` job as `deferred` (budget exhausted). Mutates and
 * returns the queue. Idempotent: jobs already non-pending are untouched.
 */
export function deferRemaining(queue, reason = 'budget cap reached') {
  for (const j of queue) {
    if (j.status === 'pending') { j.status = 'deferred'; j.result = { deferred: true, reason }; }
  }
  return queue;
}

/**
 * Register a promoted winner as a SHADOW entry in the genome registry. Idempotent by composite key:
 * a second promote for the same key updates the existing SHADOW rather than stacking duplicates.
 */
export function registerShadow(registry, entry) {
  const now = new Date().toISOString();
  registry.shadows = registry.shadows || [];
  const i = registry.shadows.findIndex((s) => s.key === entry.key);
  const rec = { rank: 'SHADOW', promotedAt: now, ...entry };
  if (i >= 0) registry.shadows[i] = { ...registry.shadows[i], ...rec };
  else registry.shadows.push(rec);
  registry.updatedAt = now;
  return registry;
}

/**
 * Apply one learn() result to the state + registry. PURE except for mutating the passed objects.
 *   report  — the promotion report learn.mjs writes (has .verdict, .key, .reason, .checks, .holdout).
 *   cost    — actual $ this job spent (from report.run.budget.totalCost when present, else reserve).
 * On verdict==='promote' → registers a SHADOW. Marks the job `done`. Adds cost to cumulativeSpend.
 * Returns { job, promoted, summary }.
 */
export function applyLearnResult({ state, registry, job, report, cost, reportPath = null }) {
  const promoted = report && report.verdict === 'promote';
  const spend = Math.round((typeof cost === 'number' ? cost : 0) * 1e4) / 1e4;
  state.cumulativeSpend = Math.round((state.cumulativeSpend + spend) * 1e4) / 1e4;

  if (promoted) {
    registerShadow(registry, {
      key: report.key,
      genomeVersion: report.candidate,
      seed: report.seed,
      slice: report.slice,
      keyParts: report.keyParts,
      holdoutGold: report.holdout?.cand?.gold ?? null,
      seedHoldoutGold: report.holdout?.seed?.gold ?? null,
      gains: report.gains,
      reason: report.reason,
      reportPath,
      jobId: job.id,
    });
  }

  job.status = 'done';
  job.result = {
    verdict: report ? report.verdict : 'unknown',
    promoted,
    key: report ? report.key : null,
    reason: report ? report.reason : null,
    checks: report ? report.checks : null,
    holdout: report ? report.holdout : null,
    cost: spend,
    reportPath,
    ranAt: new Date().toISOString(),
  };

  const summary = summarizeJob({ state, job, promoted });
  state.log.push(summary);
  state.updatedAt = new Date().toISOString();
  return { job, promoted, summary };
}

/** One-line, Monitor-friendly summary object (also rendered as a string via summaryLine). */
export function summarizeJob({ state, job, promoted }) {
  return {
    ranAt: new Date().toISOString(),
    jobId: job.id,
    model: job.model,
    workflow: job.workflow,
    verdict: job.result?.verdict ?? 'unknown',
    promoted: !!promoted,
    holdoutGold: job.result?.holdout?.cand?.gold ?? null,
    seedHoldoutGold: job.result?.holdout?.seed?.gold ?? null,
    cost: job.result?.cost ?? 0,
    cumulativeSpend: state.cumulativeSpend,
    maxTotalCost: state.maxTotalCost,
    pendingLeft: pendingCount(state.queue),
  };
}

/** Render the one summary line a Monitor watches (prefixed `[overnight]` for easy grepping). */
export function summaryLine(s) {
  const gold = s.seedHoldoutGold != null && s.holdoutGold != null
    ? ` holdoutGold=${s.seedHoldoutGold}→${s.holdoutGold}` : '';
  const verb = s.promoted ? 'PROMOTE→SHADOW' : (s.verdict ? s.verdict.toUpperCase() : 'UNKNOWN');
  return `[overnight] JOB ${s.jobId} (${s.model}) verdict=${verb}${gold}`
    + ` cost=$${s.cost} spend=$${s.cumulativeSpend}/$${s.maxTotalCost} pending=${s.pendingLeft}`;
}

/**
 * The core, injectable iteration. `runLearn(job, ctx)` MUST return { report, cost, reportPath }.
 * In production it spawns learn.mjs; in $0 tests it's a mock. This function performs the budget gate,
 * runs the job (via runLearn), applies the result, and returns a structured outcome — NO I/O of its
 * own, so it is fully unit-testable.
 */
export async function iterateOnce({ state, registry, runLearn, dryRun = false }) {
  const job = selectNextJob(state.queue);
  if (!job) return { status: 'empty', message: 'no pending jobs', done: true };

  if (!canAfford(state, job)) {
    deferRemaining(state.queue, `would exceed cap $${state.maxTotalCost} (spend $${state.cumulativeSpend} + reserve $${budgetReserve(job, state.perJobMaxCost)})`);
    state.updatedAt = new Date().toISOString();
    return {
      status: 'budget_stop',
      message: `budget cap $${state.maxTotalCost} reached at $${state.cumulativeSpend}; deferred remaining`,
      done: true,
      job,
    };
  }

  if (dryRun) {
    return {
      status: 'planned',
      message: `[overnight] PLAN ${job.id} (${job.model}) seed=${job.seed_genome} slice=${job.manifest}`
        + ` cap=$${budgetReserve(job, state.perJobMaxCost)} spend=$${state.cumulativeSpend}/$${state.maxTotalCost}`,
      done: false,
      job,
    };
  }

  let report, cost, reportPath;
  try {
    ({ report, cost, reportPath } = await runLearn(job, { state }));
  } catch (err) {
    job.status = 'failed';
    job.result = { error: String(err && err.message ? err.message : err), ranAt: new Date().toISOString() };
    state.updatedAt = new Date().toISOString();
    return { status: 'failed', message: `[overnight] JOB ${job.id} FAILED: ${job.result.error}`, done: false, job };
  }

  const { promoted, summary } = applyLearnResult({ state, registry, job, report, cost, reportPath });
  return { status: 'ran', done: false, job, promoted, summary, message: summaryLine(summary) };
}

// ── gateway backend resolution ($0-tested) ────────────────────────────────────────────────────────

/**
 * Resolve the LLM backend for this wake. --via-gateway ⇒ the cognitum meta-llm Completions API
 * (base-url + COGNITUM_DEV_KEY env + cognitum-low), overridable per flag. Default ⇒ OpenRouter-direct
 * (baseUrl/apiKeyEnv null ⇒ learn.mjs uses its OPENROUTER_API_KEY default). PURE.
 */
export function resolveBackend({ viaGateway = false, baseUrl = null, apiKeyEnv = null, model = null } = {}) {
  if (viaGateway) {
    return {
      viaGateway: true,
      baseUrl: (baseUrl || GATEWAY_BASE_URL).replace(/\/$/, ''),
      apiKeyEnv: apiKeyEnv || GATEWAY_API_KEY_ENV,
      modelOverride: model || GATEWAY_MODEL,
    };
  }
  return { viaGateway: false, baseUrl: baseUrl || null, apiKeyEnv: apiKeyEnv || null, modelOverride: model || null };
}

// ── concurrency: bounded pool with shared budget reservation ($0-tested) ──────────────────────────

/** $ currently RESERVED by in-flight (`in_progress`) jobs — the pool's client-side over-spend guard. */
export function reservedSpend(queue = [], perJobMaxCost = DEFAULT_PER_JOB_MAX_COST) {
  return queue
    .filter((j) => j.status === 'in_progress')
    .reduce((s, j) => s + budgetReserve(j, perJobMaxCost), 0);
}

/**
 * Concurrent budget gate: a job is claimable only if committed spend + all in-flight reservations +
 * this job's reserve still fit under the cap. This is what stops N concurrent jobs from collectively
 * overshooting the client-side cap (the gateway enforces the same server-side when --via-gateway).
 */
export function canAffordConcurrent(state, job) {
  const reserve = budgetReserve(job, state.perJobMaxCost);
  return state.cumulativeSpend + reservedSpend(state.queue, state.perJobMaxCost) + reserve <= state.maxTotalCost + 1e-9;
}

/**
 * Claim the next runnable job for the pool. Returns:
 *   { kind:'claimed', job } — marked `in_progress` (reserved); caller must run it.
 *   { kind:'budget',  job } — a pending job exists but its reserve doesn't fit RIGHT NOW.
 *   { kind:'empty' }        — no pending jobs left.
 * Mutates the claimed job's status only. PURE otherwise.
 */
export function claimNextJob(state) {
  const job = selectNextJob(state.queue);
  if (!job) return { kind: 'empty' };
  if (!canAffordConcurrent(state, job)) return { kind: 'budget', job };
  job.status = 'in_progress';
  return { kind: 'claimed', job };
}

/** On resume, flip any `in_progress` jobs (left by a crashed pool) back to `pending` so they retry. */
export function reclaimInProgress(state) {
  let n = 0;
  for (const j of state.queue) {
    if (j.status === 'in_progress') { j.status = 'pending'; j.result = { ...(j.result || {}), reclaimed: true }; n++; }
  }
  return n;
}

/** A deferrable error is a 429 / rate-limit / budget-reject — retry it later, don't mark it `failed`. */
export function isDeferrableError(err) {
  const m = String((err && (err.message || err.stderrTail)) || err || '').toLowerCase();
  return /\b429\b|rate.?limit|too many requests|budget|reserve.?reject|quota|insufficient|over.?cap/.test(m);
}

/** Exponential backoff (ms) for a deferred-retry, capped at 60s. */
export function backoffMs(attempt) { return Math.min(60000, 1000 * 2 ** Math.max(0, attempt)); }

/**
 * The BOUNDED CONCURRENCY POOL. Drains the queue this wake, running up to `concurrency` jobs at once.
 * `runLearn(job, ctx)` MUST return { report, cost, reportPath } (spawns learn.mjs in prod; a mock in
 * tests). Budget is reserved on claim and reconciled to actual on commit (applyLearnResult). NO I/O of
 * its own beyond the injected runLearn + optional persist/sleep hooks, so it is fully unit-testable.
 *   - deferrable error (429/budget) → job `deferred` (+ backoff), pool keeps going.
 *   - hard error                    → job `failed`, pool keeps going (other jobs are independent).
 *   - next job unaffordable + nothing in flight → defer all remaining pending, stop.
 */
export async function runPool({
  state, registry, runLearn, concurrency = DEFAULT_CONCURRENCY, dryRun = false, maxJobs = 0,
  persist = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const results = [];
  const N = Math.max(1, concurrency);

  if (dryRun) {
    for (const job of state.queue.filter((j) => j.status === 'pending')) {
      results.push({
        status: 'planned', job,
        message: `[overnight] PLAN ${job.id} (${job.model}) seed=${job.seed_genome} slice=${job.manifest}`
          + ` cap=$${budgetReserve(job, state.perJobMaxCost)} spend=$${state.cumulativeSpend}/$${state.maxTotalCost}`,
      });
    }
    return { results, deferredBudget: false };
  }

  const active = new Map(); // tagged-promise -> itself (so we can delete the settled one)
  let launched = 0;
  let deferredBudget = false;

  const runOne = async (job) => {
    try {
      const { report, cost, reportPath } = await runLearn(job, { state });
      const { promoted, summary } = applyLearnResult({ state, registry, job, report, cost, reportPath });
      return { status: 'ran', job, promoted, summary, message: summaryLine(summary) };
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (isDeferrableError(err)) {
        const attempt = (job.result?.deferAttempts || 0) + 1;
        job.status = 'deferred';
        job.result = { deferred: true, reason: msg, deferAttempts: attempt, backoffMs: backoffMs(attempt), ranAt: new Date().toISOString() };
        await sleep(backoffMs(attempt));
        return { status: 'deferred', job, message: `[overnight] JOB ${job.id} DEFERRED (429/budget, retry later): ${msg}` };
      }
      job.status = 'failed';
      job.result = { error: msg, ranAt: new Date().toISOString() };
      return { status: 'failed', job, message: `[overnight] JOB ${job.id} FAILED: ${msg}` };
    } finally {
      state.updatedAt = new Date().toISOString();
    }
  };

  const launch = (job) => {
    const tagged = runOne(job).then((r) => ({ tagged, r }));
    active.set(tagged, tagged);
    launched++;
    return tagged;
  };

  while (true) {
    // fill the pool up to N (respecting maxJobs cap and the concurrent budget gate)
    while (active.size < N && (maxJobs <= 0 || launched < maxJobs)) {
      const c = claimNextJob(state);
      if (c.kind === 'empty') break;
      if (c.kind === 'budget') {
        // Can't fit the next job's reserve right now. If jobs are in flight, wait — their commit may
        // free budget (actual < reserve). If nothing is in flight, budget is truly exhausted: defer all.
        if (active.size === 0) { deferRemaining(state.queue, `budget cap $${state.maxTotalCost} reached (spend $${state.cumulativeSpend})`); deferredBudget = true; }
        break;
      }
      launch(c.job);
    }
    if (active.size === 0) break;
    const { tagged, r } = await Promise.race(active.values());
    active.delete(tagged);
    results.push(r);
    persist(); // persist after every commit so a mid-pool crash is resumable
  }
  return { results, deferredBudget };
}

// ── state / registry persistence ────────────────────────────────────────────────────────────────

export function loadJson(path, fallbackFactory) {
  if (existsSync(path)) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { /* fall through */ } }
  return fallbackFactory();
}
export function saveJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

// ── production learn runner (spawns learn.mjs; the ONLY place that can spend) ──────────────────────
// ASYNC spawn (not execFileSync): the concurrency pool needs non-blocking children, and async spawn
// lets us TEE the child's stderr live while capturing its tail so a 429/budget line surfaces as a
// deferrable error (isDeferrableError). `backend` selects OpenRouter-direct vs the cognitum gateway.
function makeRealRunLearn({ backend = { viaGateway: false } }) {
  return (job) => new Promise((resolve, reject) => {
    const keyEnvName = backend.apiKeyEnv || 'OPENROUTER_API_KEY';
    const KEY = (process.env[keyEnvName] || '').trim();
    if (!KEY) { reject(new Error(`no ${keyEnvName} — refusing to run a live job`)); return; }
    const effModel = backend.modelOverride || job.model;        // e.g. cognitum-low under --via-gateway
    const modelSlug = job.model.replace(/[^a-zA-Z0-9_-]/g, '_'); // slug from the LOGICAL model (stable paths)
    const reportOut = rel(`gepa/runs/promotion-report-overnight-${modelSlug}.json`);
    const args = [
      '--no-warnings', join(HERE, 'learn.mjs'),
      '--model', effModel,
      '--slice', job.manifest,
      '--seed', rel(job.seed_genome),
      '--train-first', String(job.train_first ?? 12),
      '--max-cost', String(job.max_cost ?? DEFAULT_PER_JOB_MAX_COST),
      '--vertical', job.workflow || 'code-repair',
      '--report', reportOut,
      '--work-dir', rel(`gepa/runs/overnight-${modelSlug}`),
      '--run-id', `overnight_${job.id}`.replace(/[^a-zA-Z0-9_]/g, '_'),
      ...(backend.baseUrl ? ['--base-url', backend.baseUrl] : []),
      ...(backend.apiKeyEnv ? ['--api-key-env', backend.apiKeyEnv] : []),
    ];
    const child = spawn('node', args, { env: { ...process.env, [keyEnvName]: KEY } });
    let tail = '';
    const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 8 * 3600 * 1000);
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => { process.stderr.write(d); tail = (tail + d.toString()).slice(-4000); });
    child.on('error', (e) => { clearTimeout(to); reject(e); });
    child.on('close', (code) => {
      clearTimeout(to);
      if (code !== 0) { const e = new Error(`learn.mjs exited ${code}: ${tail.slice(-500)}`); e.code = code; e.stderrTail = tail; reject(e); return; }
      try {
        const report = JSON.parse(readFileSync(reportOut, 'utf8'));
        const cost = report?.run?.budget?.totalCost ?? budgetReserve(job, DEFAULT_PER_JOB_MAX_COST);
        resolve({ report, cost, reportPath: reportOut });
      } catch (e) { reject(e); }
    });
  });
}

// ── smoke runner (proves --via-gateway WIRING cheaply; NO GEPA / Docker rollout) ──────────────────
// A real learn.mjs run needs Docker SWE-bench + dollars, so it can't fit a ≤$0.20 smoke. This instead
// fires two IDENTICAL cognitum-low completions per job over a shared genome-prefix system prompt: it
// proves (1) rollouts route via cognitum-low → the resolved tier/model, (2) each call is metered in the
// usage_ledger, and (3) the repeated genome-prefix hits the response/prompt cache (cheaper 2nd call).
// Returns a synthetic `reject` report (never promotes) with the tiny real token cost.
export const SMOKE_GENOME_PREFIX =
  'You are a SWE-bench code-repair executor operating under a fixed genome. GENOME-PREFIX v1 '
  + '(shared across rollouts so the gateway can cache it): '.repeat(48)
  + 'Always answer tersely.';
function makeSmokeRunLearn({ backend, fetchImpl = fetch }) {
  return async (job) => {
    const keyEnvName = backend.apiKeyEnv || GATEWAY_API_KEY_ENV;
    const KEY = (process.env[keyEnvName] || '').trim();
    if (!KEY) throw new Error(`no ${keyEnvName} — refusing to run the gateway smoke`);
    const base = (backend.baseUrl || GATEWAY_BASE_URL).replace(/\/$/, '');
    const model = backend.modelOverride || GATEWAY_MODEL;
    let cost = 0, tier = null, resolved = null;
    for (let i = 0; i < 2; i++) { // 1st warms the cache, 2nd (identical) should hit it
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: SMOKE_GENOME_PREFIX }, { role: 'user', content: `Reply with only: OK (${job.id})` }],
          max_tokens: 4, temperature: 0,
        }),
      });
      if (res.status === 429) throw new Error('429 rate-limited by gateway (Reserve-and-Commit backstop)');
      if (!res.ok) throw new Error(`gateway ${res.status} ${res.statusText || ''}`.trim());
      tier = res.headers.get('x-cognitum-resolved-tier') || tier;
      resolved = res.headers.get('x-cognitum-resolved-model') || resolved;
      const j = await res.json();
      cost += ((j.usage?.total_tokens || 0)) * 1e-7; // negligible synthetic $; real metering is server-side
    }
    const report = {
      verdict: 'reject', // smoke never promotes
      key: `smoke+${job.model}+${job.workflow}`,
      reason: `SMOKE ok: routed tier=${tier} resolved=${resolved} (2 metered calls, repeat cache-warm)`,
      checks: null, holdout: null,
      run: { budget: { totalCost: cost } },
    };
    return { report, cost, reportPath: null };
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  const statePath = rel(argv('--state', 'gepa/runs/overnight-train-state.json'));
  const registryPath = rel(argv('--registry', 'gepa/runs/genome-registry.json'));
  const maxTotalCost = +argv('--max-total-cost', DEFAULT_MAX_TOTAL_COST);
  const perJobMaxCost = +argv('--max-cost', DEFAULT_PER_JOB_MAX_COST);
  const concurrency = +argv('--concurrency', DEFAULT_CONCURRENCY);
  const maxJobs = +argv('--max-jobs', 0); // 0 ⇒ drain the queue this wake (bounded by budget)
  const dryRun = args.includes('--dry-run');
  const reset = args.includes('--reset');
  const smoke = args.includes('--smoke');

  // Backend: --via-gateway → cognitum meta-llm Completions API (key from env, NEVER logged). Default =
  // OpenRouter-direct. --base-url / --api-key-env / --model override the resolved backend.
  const backend = resolveBackend({
    viaGateway: args.includes('--via-gateway'),
    baseUrl: argv('--base-url', null),
    apiKeyEnv: argv('--api-key-env', null),
    model: argv('--model', null),
  });

  if (reset) {
    const st = freshState({ maxTotalCost, perJobMaxCost });
    if (smoke) st.queue = smokeSeedQueue(); // --smoke --reset seeds the 2 trivial gateway jobs
    saveJson(statePath, st);
    saveJson(registryPath, freshRegistry());
    console.error(`[overnight] RESET state → ${statePath} (${st.queue.length} jobs, cap $${maxTotalCost}${smoke ? ', SMOKE queue' : ''})`);
    return;
  }

  const state = loadJson(statePath, () => freshState({ maxTotalCost, perJobMaxCost }));
  // allow CLI to raise/lower caps on an existing run (never silently — echo it)
  if (state.maxTotalCost !== maxTotalCost) { console.error(`[overnight] cap: $${state.maxTotalCost} → $${maxTotalCost}`); state.maxTotalCost = maxTotalCost; }
  if (state.perJobMaxCost !== perJobMaxCost) { console.error(`[overnight] per-job cap: $${state.perJobMaxCost} → $${perJobMaxCost}`); state.perJobMaxCost = perJobMaxCost; }
  const registry = loadJson(registryPath, freshRegistry);

  // resume-safety: any job left `in_progress` by a crashed pool → back to pending (retried, not lost)
  const reclaimed = reclaimInProgress(state);
  if (reclaimed) console.error(`[overnight] reclaimed ${reclaimed} in_progress job(s) from a prior crash → pending`);

  if (args.includes('--status')) {
    const byStatus = state.queue.reduce((m, j) => { m[j.status] = (m[j.status] || 0) + 1; return m; }, {});
    console.log(`[overnight] STATE ${statePath}`);
    console.log(`[overnight] spend $${state.cumulativeSpend}/$${state.maxTotalCost} · per-job cap $${state.perJobMaxCost} · concurrency ${concurrency} · jobs ${JSON.stringify(byStatus)}`);
    console.log(`[overnight] SHADOW winners: ${registry.shadows.length}`);
    for (const j of state.queue) {
      const v = j.result?.verdict ? ` [${j.result.verdict}]` : '';
      console.log(`  - ${j.status.padEnd(20)} ${j.id} (${j.model})${v}`);
    }
    return;
  }

  if (backend.viaGateway) console.error(`[overnight] BACKEND gateway ${backend.baseUrl} model=${backend.modelOverride} (api key from configured env var, not logged)`);
  else console.error('[overnight] BACKEND OpenRouter-direct (default)');

  const runLearn = smoke ? makeSmokeRunLearn({ backend }) : makeRealRunLearn({ backend });
  const persist = () => { saveJson(statePath, state); saveJson(registryPath, registry); };

  const { results, deferredBudget } = await runPool({ state, registry, runLearn, concurrency, dryRun, maxJobs, persist });
  persist();
  for (const r of results) console.log(r.message);
  const ran = results.filter((r) => r.status === 'ran' || r.status === 'planned').length;
  if (deferredBudget) console.log(`[overnight] budget cap $${state.maxTotalCost} reached at $${state.cumulativeSpend}; remaining jobs deferred`);
  if (!ran && !results.length) console.log('[overnight] nothing to do (no pending jobs or budget exhausted)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
