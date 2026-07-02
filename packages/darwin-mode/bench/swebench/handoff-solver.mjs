// SPDX-License-Identifier: MIT
//
// ADR-205 — the HARNESS HANDOFF: darwin as router, claude -p as hard-tail actuator.
//
// The proven invariant (hard-25, gold-scored): darwin's bounded ReAct loop caps frontier models
// (~1/25 even with Sonnet-class models inside it), while the SAME model inside Claude Code's own
// agent loop (claude -p + Fable) lands 23/25. Model quality × wrong loop = capped outcome. The fix
// is NOT to embed a better model in darwin's loop — it is to hand the INSTANCE off to the loop that
// can express the solution. darwin stays the cheap classifier/executor; when its cheap attempt
// fails, the instance is escalated to a claude -p subprocess (OpenRouter-routed Fable) that owns
// its own tools, prompt protocol, and retry policy.
//
// This module is the subprocess-solver + routing-policy side of that handoff:
//   - solveViaClaudeP(task, deps)  — clone repo @ base_commit, run `claude -p`, capture `git diff`
//   - parseEscalateChain(value)    — `--escalate-to` accepts an ORDERED CHAIN of solvers
//     (e.g. `darwin:z-ai/glm,claude-p:anthropic/claude-sonnet-5,claude-p-fable`): try each in
//     order, stop at the first accepted result (acceptHop). Single target = chain of one.
//   - escalationSignals/shouldEscalate — the rule-based 2-of-N escalation trigger (pure, testable)
//   - diffStats/buildReceipt       — the per-instance/per-hop solver_receipt (the future router's training data)
//
// claude -p endpoint facts (measured, not guessed — see claude-p-solve.mjs):
//   - OpenRouter routing: ANTHROPIC_BASE_URL=https://openrouter.ai/api,
//     ANTHROPIC_AUTH_TOKEN=<OpenRouter key>, ANTHROPIC_MODEL=<exact OR model id>, and NO --model flag.
//   - The JSON `result` field is often empty (display quirk) — the patch MUST be captured via
//     `git diff` in the work tree, never from the JSON output.
//   - `total_cost_usd` in the JSON is claude's own (Anthropic-price-table) estimate; actual billing
//     is on the OpenRouter account. We track it as the OR-billed-equivalent estimate.
import { exec as _exec } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const OR_ANTHROPIC_BASE_URL = 'https://openrouter.ai/api';
export const DEFAULT_HANDOFF_MODEL = 'anthropic/claude-fable-5';

/** Default async exec: promise of stdout (string). Injectable for tests (deps.exec). */
function defaultExec(cmd, { cwd, env, timeout } = {}) {
  return new Promise((resolve, reject) => {
    _exec(cmd, { cwd, env, timeout, shell: '/bin/bash', maxBuffer: 1 << 28 }, (err, stdout) => {
      if (err) { err.stdout = String(stdout || ''); reject(err); } else resolve(String(stdout || ''));
    });
  });
}

/** OpenRouter auth token for the claude -p env: explicit > env > /tmp/.orkey. */
export function readAuthToken(explicit) {
  if (explicit) return explicit;
  if (process.env.ANTHROPIC_AUTH_TOKEN) return process.env.ANTHROPIC_AUTH_TOKEN.trim();
  try { return readFileSync('/tmp/.orkey', 'utf8').trim(); } catch { return ''; }
}

/** The child env for OpenRouter-routed claude -p. Pure (base env injectable) for tests. */
export function buildHandoffEnv(model, authToken, baseEnv = process.env) {
  return { ...baseEnv, ANTHROPIC_BASE_URL: OR_ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: authToken, ANTHROPIC_MODEL: model };
}

/** The handoff prompt: same contract as the 23/25 clean-comparator run, plus an honest, compact
 * note about the failed cheap attempt (priorAttempts) so the actuator doesn't repeat its mistakes. */
export function buildHandoffPrompt(problemStatement, priorAttempts = []) {
  let p = `You are fixing a bug in this repository. Edit the source code to resolve the issue below. Make the minimal change that fixes it. Do NOT edit test files. Do not run the test suite.\n\n--- ISSUE ---\n${problemStatement}`;
  if (priorAttempts.length) {
    const notes = priorAttempts.map((a) => `- ${a.solver || 'unknown'}: ${a.failureReasons?.length ? a.failureReasons.join(', ') : 'failed'}${a.steps ? ` (${a.steps} steps)` : ''}`).join('\n');
    p += `\n\n--- PRIOR ATTEMPTS (a cheaper agent already tried and failed) ---\n${notes}`;
  }
  return p;
}

/**
 * The claude -p subprocess solver. Clones `repo` at `baseCommit` into a temp work tree, runs
 * OpenRouter-routed `claude -p` there, captures the patch via `git diff`.
 *
 * Returns { status, patch, cost_usd, latency_ms, turns, solver, error }.
 * 'resolved' here means ONLY "produced a non-empty patch" — REAL resolve is gold-scored later by
 * the official SWE-bench harness. Do not treat this status as an oracle.
 *
 * `budgetUsd` is advisory: claude -p has no mid-run budget flag, so per-run spend is bounded by
 * maxTurns + timeoutMs; the CALLER enforces the cumulative budget (solve-agentic's --max-cost gate
 * checks before launching each handoff).
 *
 * `deps` (all optional, injectable for $0 tests): { exec, fetchRepo, cleanup, authToken, now }.
 */
export async function solveViaClaudeP({
  instanceId, repo, baseCommit, problemStatement,
  model = DEFAULT_HANDOFF_MODEL, maxTurns = 40, timeoutMs = 900_000, budgetUsd, priorAttempts = [],
} = {}, deps = {}) {
  const exec = deps.exec || defaultExec;
  const now = deps.now || Date.now;
  const t0 = now();
  let work, patch = '', cost = 0, turns = 0, error = '', timedOut = false;
  try {
    if (deps.fetchRepo) work = await deps.fetchRepo(repo, baseCommit);
    else {
      work = mkdtempSync(join(tmpdir(), 'handoff-'));
      await exec(`git init -q && git remote add origin https://github.com/${repo}.git`, { cwd: work, timeout: 60_000 });
      try { await exec(`git fetch --depth 1 -q origin ${baseCommit} && git checkout -q FETCH_HEAD`, { cwd: work, timeout: 300_000 }); }
      catch { await exec(`git fetch --depth 200 -q origin && git checkout -q ${baseCommit}`, { cwd: work, timeout: 600_000 }); }
    }
    const prompt = buildHandoffPrompt(problemStatement, priorAttempts);
    const env = buildHandoffEnv(model, readAuthToken(deps.authToken));
    // NO --model flag: ANTHROPIC_MODEL owns model selection on a custom endpoint (measured quirk).
    const cmd = `claude -p ${JSON.stringify(prompt)} --max-turns ${maxTurns} --dangerously-skip-permissions --output-format json`;
    const out = await exec(cmd, { cwd: work, env, timeout: timeoutMs });
    try { const res = JSON.parse(out); cost = res.total_cost_usd || 0; turns = res.num_turns || 0; } catch { /* patch still comes from git diff */ }
    patch = await exec('git diff', { cwd: work, timeout: 60_000 });
  } catch (e) {
    timedOut = !!(e && (e.killed || /ETIMEDOUT|timed?\s?out/i.test(String(e.message || e))));
    error = String(e?.message || e).slice(0, 300);
    // Salvage: a timeout/exit-code failure may still have left edits in the tree.
    if (work) { try { patch = await exec('git diff', { cwd: work, timeout: 60_000 }); } catch { /* keep '' */ } }
  } finally {
    if (work && !deps.fetchRepo) { try { rmSync(work, { recursive: true, force: true }); } catch { /**/ } }
    if (work && deps.cleanup) { try { deps.cleanup(work); } catch { /**/ } }
  }
  const status = patch.trim() ? 'resolved' : (timedOut ? 'timeout' : 'failed');
  return { status, patch, cost_usd: cost, latency_ms: now() - t0, turns, solver: 'claude-p-fable', error };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Solver registry + escalation chain (`--escalate-to a,b,c`).
//
// A solver SPEC is { name, kind: 'darwin-model' | 'claude-p-model', model, maxTurns?, maxSteps?,
// timeoutMs? }. 'darwin-model' reruns darwin's OWN loop with a different (usually cheaper) model —
// the cheap rungs of the ladder; 'claude-p-model' is the claude -p subprocess handoff — the Claude
// rungs. The chain executor lives in solve-agentic.mjs (it owns solveTier/mkLlm); this module owns
// the pure spec resolution + acceptance policy so both are unit-testable at $0.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Named aliases (proven configs only — generic `darwin:<model>` / `claude-p:<model>` forms cover
 * everything else without this file having to guess model ids). */
export const SOLVER_ALIASES = {
  'claude-p-fable': { name: 'claude-p-fable', kind: 'claude-p-model', model: DEFAULT_HANDOFF_MODEL, maxTurns: 40, timeoutMs: 900_000 },
};

/** Resolve ONE `--escalate-to` element to a solver spec, or null if unknown. */
export function resolveSolverSpec(name) {
  const n = String(name || '').trim();
  if (SOLVER_ALIASES[n]) return { ...SOLVER_ALIASES[n] };
  if (n.startsWith('claude-p:')) { const model = n.slice('claude-p:'.length); return model ? { name: n, kind: 'claude-p-model', model, maxTurns: 40, timeoutMs: 900_000 } : null; }
  if (n.startsWith('darwin:')) { const model = n.slice('darwin:'.length); return model ? { name: n, kind: 'darwin-model', model } : null; }
  return null;
}

/** Parse the full `--escalate-to` value (comma-separated, ordered). Throws on any unknown element
 * so a typo'd chain fails fast instead of silently skipping a rung. */
export function parseEscalateChain(value) {
  const parts = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('--escalate-to: empty chain');
  return parts.map((p) => {
    const spec = resolveSolverSpec(p);
    if (!spec) throw new Error(`--escalate-to: unknown solver "${p}" (use an alias like "claude-p-fable" or a generic form "darwin:<model>" / "claude-p:<model>")`);
    return spec;
  });
}

/** Cheap per-hop acceptance: non-empty patch AND, where the solver reports it, the in-loop signal.
 * darwin rungs report `resolvedInLoop`; claude -p rungs don't (undefined ⇒ patch alone decides).
 * REAL resolve is still gold-scored later — this is a routing heuristic, not an oracle. */
export function acceptHop(result) {
  if (!result || !String(result.patch || '').trim()) return false;
  if (result.resolvedInLoop === false) return false;
  return true;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Rule-based escalation (ADR-205 §rules) — a practical subset of the spec'd router: every signal is
// computable from what darwin's loop ALREADY tracks (no invented confidence/complexity scores —
// learned thresholds over the receipt stream are explicitly future work).
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Files touched + byte size of a unified diff. Pure. */
export function diffStats(patch) {
  const p = String(patch || '');
  const files = [...p.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
  return { files: [...new Set(files)], bytes: Buffer.byteLength(p, 'utf8') };
}

/**
 * The observable failure signals after darwin's cheap attempt.
 *   res: { resolvedInLoop, submitted, thrash } — the agentic-loop result (thrash = the existing
 *        anti-thrash repeat counter: same (action→observation) state seen again in the trajectory).
 *   patch: darwin's final work-tree diff.
 */
export function escalationSignals({ resolvedInLoop, submitted, thrash, patch }) {
  const { files } = diffStats(patch);
  return {
    tests_failed: !resolvedInLoop,                    // in-loop tests did not pass
    empty_patch: !String(patch || '').trim(),         // nothing was edited
    no_submit: !submitted,                            // never called submit (ran out of steps)
    thrash_repeat: (thrash || 0) >= 2,                // same state repeated ≥2 times (thrash signal)
    too_many_files: files.length > 3,                 // sprawling patch — low-confidence shape
  };
}

/** 2-of-N rule: escalate when ANY 2 signals are true. Returns { escalate, reasons }. */
export function shouldEscalate(signals) {
  const reasons = Object.keys(signals).filter((k) => signals[k] === true);
  return { escalate: reasons.length >= 2, reasons };
}

/**
 * The per-instance solver_receipt — one JSONL row per instance (escalated or not). This stream is
 * the future MetaHarness router's training data: keep it complete and honest (both classes, real
 * costs, real reasons). Extra fields beyond the base schema are allowed; missing ones are not.
 */
export function buildReceipt({ instanceId, initialSolver, darwinCostUsd, darwinSteps, signals, escalated, escalationReasons, handoff, finalPatch, now = Date.now }) {
  const { files, bytes } = diffStats(finalPatch);
  return {
    instance_id: instanceId,
    initial_solver: initialSolver,
    darwin_cost_usd: +(darwinCostUsd || 0).toFixed(6),
    darwin_steps: darwinSteps ?? null,
    failure_reasons: Object.keys(signals || {}).filter((k) => signals[k] === true),
    escalated: !!escalated,
    escalation_reasons: escalated ? (escalationReasons || []) : [],
    handoff_solver: handoff ? handoff.solver : null,
    handoff_status: handoff ? handoff.status : null,
    handoff_cost_usd: handoff ? +(handoff.cost_usd || 0).toFixed(6) : null,
    handoff_latency_ms: handoff ? handoff.latency_ms : null,
    handoff_turns: handoff ? handoff.turns : null,
    handoff_error: handoff?.error ? handoff.error : null,
    final_patch_nonempty: !!String(finalPatch || '').trim(),
    diff_files: files.length,
    diff_bytes: bytes,
    ts: new Date(now()).toISOString(),
  };
}
