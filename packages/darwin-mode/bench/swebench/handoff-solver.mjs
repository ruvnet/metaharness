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
// ADR-232 — cost-aware output-mode contract for the Fable rung. assertFableLoopMode makes it
// structurally impossible to request full_prose from Fable inside a loop turn (throws). Import is
// side-effect-free; when no outputMode is passed the handoff prompt is byte-identical to before.
import { assertFableLoopMode } from './output-modes.mjs';

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
 * note about the failed cheap attempt (priorAttempts) so the actuator doesn't repeat its mistakes.
 *
 * ADR-232: when `opts.outputMode` is set (a FableOutputMode), an OUTPUT CONTRACT is appended that
 * forbids a prose narration/explanation in the final message — the patch is captured from the code
 * changes (git diff), never from prose, so a final essay is pure billed-and-discarded output. This
 * is the prompt-side half of "make Fable write less"; the direct-API rungs add the hard max_tokens
 * cap. `outputMode` is asserted (full_prose throws) so prose can never be requested here. Absent ⇒
 * byte-identical to the pre-ADR-232 prompt. */
export function buildHandoffPrompt(problemStatement, priorAttempts = [], opts = {}) {
  let p = `You are fixing a bug in this repository. Edit the source code to resolve the issue below. Make the minimal change that fixes it. Do NOT edit test files. Do not run the test suite.\n\n--- ISSUE ---\n${problemStatement}`;
  if (priorAttempts.length) {
    const notes = priorAttempts.map((a) => `- ${a.solver || 'unknown'}: ${a.failureReasons?.length ? a.failureReasons.join(', ') : 'failed'}${a.steps ? ` (${a.steps} steps)` : ''}`).join('\n');
    p += `\n\n--- PRIOR ATTEMPTS (a cheaper agent already tried and failed) ---\n${notes}`;
  }
  if (opts.outputMode) {
    assertFableLoopMode(opts.outputMode); // full_prose is structurally forbidden here (throws)
    if (opts.outputMode === 'verdict_only') {
      p += '\n\n--- OUTPUT CONTRACT (verdict_only) ---\nWhen done, your FINAL message must be ONLY a JSON verdict {"verdict":"accept|revise|escalate","blocking_issues":[]}. No prose, no explanation, no summary.';
    } else {
      p += '\n\n--- OUTPUT CONTRACT (minimal_patch) ---\nApply the fix as source-code edits. Your FINAL message must be EMPTY or a single short line — do NOT narrate, explain, or summarize your reasoning. The patch is read from the code changes, not from your prose, so any explanatory text is wasted. Keep the diff minimal.';
    }
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
  outputMode = null, // ADR-232 — FableOutputMode contract (default null ⇒ pre-ADR-232 prompt)
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
    const prompt = buildHandoffPrompt(problemStatement, priorAttempts, { outputMode });
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
  return { status, patch, cost_usd: cost, latency_ms: now() - t0, turns, solver: 'claude-p-fable', error, output_mode: outputMode };
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

/**
 * Walk the escalation chain: try each rung in order, stop at the first ACCEPTED result. Pure
 * traversal — the actual rung execution is injected so this is unit-testable at $0:
 *   runDarwinHop(spec, priorAttempts)  — rerun darwin's own loop with spec.model (caller owns solveTier)
 *   runClaudeP(spec, priorAttempts)    — the claude -p subprocess handoff
 *   overBudget()                       — cumulative budget gate, checked BEFORE each rung launches
 * Returns hops[] = { spec, result | null, skipped? } for every rung attempted; a failed rung feeds
 * its failure into the next rung's priorAttempts so later rungs know the escalation history.
 */
export async function runEscalationChain(chain, { runDarwinHop, runClaudeP, overBudget = () => false, priorAttempts = [] }) {
  const hops = [];
  for (const spec of chain) {
    if (overBudget()) { hops.push({ spec, result: null, skipped: 'budget' }); break; }
    let result;
    try { result = await (spec.kind === 'darwin-model' ? runDarwinHop(spec, priorAttempts) : runClaudeP(spec, priorAttempts)); }
    catch (e) { result = { status: 'failed', patch: '', cost_usd: 0, latency_ms: 0, turns: 0, error: String(e?.message || e).slice(0, 300) }; }
    result = result || { status: 'failed', patch: '', cost_usd: 0, latency_ms: 0, turns: 0, error: 'rung returned no result' };
    if (!result.solver) result.solver = spec.name;
    hops.push({ spec, result });
    if (acceptHop(result)) break;
    priorAttempts = [...priorAttempts, { solver: spec.name, failureReasons: [result.status === 'timeout' ? 'timeout' : 'no accepted patch'], steps: result.turns }];
  }
  return hops;
}

/** Pick the chain's winning patch: first ACCEPTED hop; else (fallback) the LAST hop that produced a
 * non-empty patch — better than keeping darwin's empty/failed patch. Returns { hop, accepted } or null. */
export function pickChainPatch(hops) {
  const winner = hops.find((h) => h.result && acceptHop(h.result));
  if (winner) return { hop: winner, accepted: true };
  const best = [...hops].reverse().find((h) => h.result && String(h.result.patch || '').trim());
  return best ? { hop: best, accepted: false } : null;
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
 * The spec'd thrash signal: the SAME test-failure signature repeated ≥2 times in the trajectory.
 * Reads the loop transcript ({actionRaw, obs} rows), takes every run_tests observation that is NOT
 * a pass, normalizes it (whitespace + volatile /tmp run-id paths), and returns the max repeat
 * count of any one signature. Pure; transcript optional (absent ⇒ 0).
 */
export function testFailureRepeats(transcript) {
  const counts = new Map();
  let max = 0;
  for (const t of transcript || []) {
    if (!/"tool":"run_tests"/.test(String(t.actionRaw || ''))) continue;
    const obs = String(t.obs || '');
    if (/ALL TARGET TESTS PASS/.test(obs)) continue;
    const sig = obs.replace(/\/tmp\/\S+/g, '<tmp>').replace(/\s+/g, ' ').trim().slice(0, 2000);
    const c = (counts.get(sig) || 0) + 1;
    counts.set(sig, c);
    if (c > max) max = c;
  }
  return max;
}

/**
 * The observable failure signals after darwin's cheap attempt.
 *   res: { resolvedInLoop, submitted, thrash, transcript } — the agentic-loop result. `thrash` is
 *        the loop's existing anti-thrash repeat counter (same read/grep/ls (action→observation)
 *        state seen again); `transcript` feeds the spec'd repeated-test-failure-signature signal —
 *        the anti-thrash counter alone never sees run_tests repeats, so both are combined.
 *   patch: darwin's final work-tree diff.
 */
export function escalationSignals({ resolvedInLoop, submitted, thrash, transcript, patch }) {
  const { files } = diffStats(patch);
  return {
    tests_failed: !resolvedInLoop,                    // in-loop tests did not pass
    empty_patch: !String(patch || '').trim(),         // nothing was edited
    no_submit: !submitted,                            // never called submit (ran out of steps)
    // same test-failure signature repeated ≥2× in the trajectory (OR the loop's own anti-thrash
    // navigation-repeat counter ≥2 — both are "stuck in a loop" evidence)
    thrash_repeat: testFailureRepeats(transcript) >= 2 || (thrash || 0) >= 2,
    too_many_files: files.length > 3,                 // sprawling patch — low-confidence shape
  };
}

/** 2-of-N rule: escalate when ANY 2 signals are true. Returns { escalate, reasons }. */
export function shouldEscalate(signals) {
  const reasons = Object.keys(signals).filter((k) => signals[k] === true);
  return { escalate: reasons.length >= 2, reasons };
}

/**
 * Escalation POLICY selector. `reasons` is always the full set of firing signals (honest receipt),
 * independent of which policy made the decision.
 *   'two-of-n'   — the PRODUCTION default (cost-optimization for MIXED workloads where the cheap
 *                  base resolves the easy share): escalate only when ≥2 signals fire.
 *   'aggressive' — escalate EVERY darwin miss (tests_failed OR empty_patch). Correct for a PROOF
 *                  slice like hard-25 where the base resolves ~0, so the 2-of-N cost-saver would
 *                  under-escalate confident-but-wrong submits and measure darwin's ceiling instead
 *                  of the handoff's ability. Escalation rate → ~100% here (intended; the honest
 *                  hard-25 story is "no cost win on a slice the base can't touch — the win is on
 *                  mixed workloads only").
 */
export function evaluateEscalation(signals, policy = 'two-of-n') {
  const reasons = Object.keys(signals).filter((k) => signals[k] === true);
  if (policy === 'aggressive') return { escalate: !!(signals.tests_failed || signals.empty_patch), reasons };
  if (policy === 'two-of-n') return { escalate: reasons.length >= 2, reasons };
  throw new Error(`unknown escalate-policy "${policy}" (use "two-of-n" or "aggressive")`);
}

/**
 * The per-instance solver_receipt — one JSONL row per instance (escalated or not). This stream is
 * the future MetaHarness router's training data: keep it complete and honest (both classes, real
 * costs, real reasons). Extra fields beyond the base schema are allowed; missing ones are not.
 */
export function buildReceipt({ instanceId, initialSolver, darwinCostUsd, darwinSteps, signals, escalated, escalationReasons, handoff, finalPatch, escalatePolicy = null, now = Date.now }) {
  const { files, bytes } = diffStats(finalPatch);
  return {
    instance_id: instanceId,
    initial_solver: initialSolver,
    escalate_policy: escalatePolicy,          // which policy made the escalate/keep decision (two-of-n|aggressive)
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
