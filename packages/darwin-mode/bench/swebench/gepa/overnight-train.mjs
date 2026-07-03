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
// $0 SAFETY: the pure decision functions (job selection, budget gate, promotion application, registry
// mutation) are exported and unit-tested with a MOCKED learn runner in overnight-train.test.mjs.
// Nothing here calls an LLM by itself — spend happens only inside learn.mjs → run-gepa.mjs, which
// require OPENROUTER_API_KEY. `--dry-run` performs NO spend (prints the plan for each pending job).
//
// Usage:
//   OPENROUTER_API_KEY=... node gepa/overnight-train.mjs [--max-total-cost 100] [--max-cost 12]
//                                 [--max-jobs 1] [--sleep 0] [--state <file>] [--registry <file>]
//                                 [--dry-run] [--status] [--reset]
//   node gepa/overnight-train.mjs --status         # inspect the queue + spend, no spend, no mutation
//   node gepa/overnight-train.mjs --dry-run        # plan the next pending job(s), no spend

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, '..');
const rel = (p) => (isAbsolute(p) ? p : join(BENCH, p));

export const DEFAULT_MAX_TOTAL_COST = 100; // global cap for the whole overnight run ($)
export const DEFAULT_PER_JOB_MAX_COST = 12; // per-job cap ($) — also passed to learn.mjs --max-cost

// Statuses that are terminal / not-runnable and are always skipped on resume.
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
function makeRealRunLearn({ statePath }) {
  return async (job) => {
    const KEY = (process.env.OPENROUTER_API_KEY || '').trim();
    if (!KEY) throw new Error('no OPENROUTER_API_KEY — refusing to run a live job');
    const modelSlug = job.model.replace(/[^a-zA-Z0-9_-]/g, '_');
    const reportOut = rel(`gepa/runs/promotion-report-overnight-${modelSlug}.json`);
    const args = [
      '--no-warnings', join(HERE, 'learn.mjs'),
      '--model', job.model,
      '--slice', job.manifest,
      '--seed', rel(job.seed_genome),
      '--train-first', String(job.train_first ?? 12),
      '--max-cost', String(job.max_cost ?? DEFAULT_PER_JOB_MAX_COST),
      '--vertical', job.workflow || 'code-repair',
      '--report', reportOut,
      '--work-dir', rel(`gepa/runs/overnight-${modelSlug}`),
      '--run-id', `overnight_${job.id}`.replace(/[^a-zA-Z0-9_]/g, '_'),
    ];
    execFileSync('node', args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 8 * 3600 * 1000,
      env: { ...process.env, OPENROUTER_API_KEY: KEY },
    });
    const report = JSON.parse(readFileSync(reportOut, 'utf8'));
    const cost = report?.run?.budget?.totalCost ?? budgetReserve(job, DEFAULT_PER_JOB_MAX_COST);
    return { report, cost, reportPath: reportOut };
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
  const maxJobs = +argv('--max-jobs', 1);
  const sleepSec = +argv('--sleep', 0);
  const dryRun = args.includes('--dry-run');
  const reset = args.includes('--reset');

  if (reset) {
    const st = freshState({ maxTotalCost, perJobMaxCost });
    saveJson(statePath, st);
    saveJson(registryPath, freshRegistry());
    console.error(`[overnight] RESET state → ${statePath} (${st.queue.length} jobs, cap $${maxTotalCost})`);
    return;
  }

  const state = loadJson(statePath, () => freshState({ maxTotalCost, perJobMaxCost }));
  // allow CLI to raise/lower caps on an existing run (never silently — echo it)
  if (state.maxTotalCost !== maxTotalCost) { console.error(`[overnight] cap: $${state.maxTotalCost} → $${maxTotalCost}`); state.maxTotalCost = maxTotalCost; }
  if (state.perJobMaxCost !== perJobMaxCost) { console.error(`[overnight] per-job cap: $${state.perJobMaxCost} → $${perJobMaxCost}`); state.perJobMaxCost = perJobMaxCost; }
  const registry = loadJson(registryPath, freshRegistry);

  if (args.includes('--status')) {
    const byStatus = state.queue.reduce((m, j) => { m[j.status] = (m[j.status] || 0) + 1; return m; }, {});
    console.log(`[overnight] STATE ${statePath}`);
    console.log(`[overnight] spend $${state.cumulativeSpend}/$${state.maxTotalCost} · per-job cap $${state.perJobMaxCost} · jobs ${JSON.stringify(byStatus)}`);
    console.log(`[overnight] SHADOW winners: ${registry.shadows.length}`);
    for (const j of state.queue) {
      const v = j.result?.verdict ? ` [${j.result.verdict}]` : '';
      console.log(`  - ${j.status.padEnd(20)} ${j.id} (${j.model})${v}`);
    }
    return;
  }

  const runLearn = makeRealRunLearn({ statePath });
  let ran = 0;
  for (let i = 0; i < Math.max(1, maxJobs); i++) {
    const out = await iterateOnce({ state, registry, runLearn, dryRun });
    // persist after EVERY iteration so a crash mid-queue is still resumable
    saveJson(statePath, state);
    saveJson(registryPath, registry);
    console.log(out.message);
    if (out.status === 'ran' || out.status === 'planned') ran++;
    if (out.done) break;
    if (out.status === 'failed') break; // stop the batch on a hard failure; state is persisted
    if (sleepSec > 0 && i < maxJobs - 1) await new Promise((r) => setTimeout(r, sleepSec * 1000));
  }
  if (!ran) console.log('[overnight] nothing to do (no pending jobs or budget exhausted)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
