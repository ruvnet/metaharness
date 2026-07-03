// SPDX-License-Identifier: MIT
//
// ADR-231 forward-contract — the Darwin SWE-bench SOLVER-TRAJECTORY serializer.
//
// This is the SWE-bench analog of ruflo #2550 (ADR-167 §4): the GAIA harness built `messages[]`
// but never persisted it, so the answer-leakage vector stayed `⚠️ not provable from the artifact`.
// Same shape here — `solve-agentic.mjs` ALREADY computes everything the ADR-231 integrity gate needs
// to PROVE the three attested-by-flag / skip vectors (`no_gold_in_loop`, `localization_no_gold`,
// `best_of_n_selector_conformant`), but discards it after the run. This module captures those exact
// signals into a redacted, size-bounded `solver-trajectory.jsonl` (one record per instance) that
// `scripts/sota-attest.mjs --trajectory` consumes to flip those vectors from skip → enforceable.
//
// DISCIPLINE (mirrors #2550):
//   - EVIDENCE, not fabrication: every field is read from what the real solve path computed
//     (`res.transcript`, the localizer seed, the `row` the harness already assembled, the run config).
//     Where a signal is genuinely absent (e.g. the agent never ran, no localizer on), it is recorded
//     honestly (empty / null) so sota-attest can still `skip` that sub-part rather than false-pass.
//   - REDACT secrets: OpenRouter/OpenAI keys, bearer tokens, and emails are scrubbed from every string.
//   - BOUND size: this is an audit trail, NOT a transcript dump. We keep tool NAMES and file PATHS
//     only (never file contents, never model output), each list capped.
//
// The core (`extractToolUse`, `redactSecrets`, `isGoldTestPath`, `deriveSelector`, `localizationSources`,
// `assembleTrajectoryRecord`) is PURE and unit-tested in solver-trajectory.test.mjs — no I/O, no Docker.

import { appendFileSync, writeFileSync } from 'node:fs';

// ─────────────────────────── redaction (secrets never reach the artifact) ───────────────────────────

/** Scrub obvious secrets from any string headed for the trajectory. Conservative — over-redacts. */
export function redactSecrets(s) {
  if (typeof s !== 'string' || !s) return s;
  return s
    // OpenRouter / OpenAI style keys: sk-or-v1-…, sk-…, and long api-key tails.
    .replace(/sk-or-v1-[A-Za-z0-9_-]{8,}/g, 'sk-or-v1-[REDACTED]')
    .replace(/sk-[A-Za-z0-9]{16,}/g, 'sk-[REDACTED]')
    // Authorization: Bearer <token>
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1[REDACTED]')
    // bare emails (PII)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED-EMAIL]');
}

// ─────────────────────────── gold-test-path heuristic (SAME convention as sota-attest) ───────────────
// A "gold test path" for SWE-bench is any test file by convention: test_*.py, *_test.py, conftest.py,
// or any path segment exactly `tests`/`test`. The conformant localizer (localize.mjs SKIP_DIRS) skips
// ALL test dirs by construction, so a test path appearing in localization_sources is a conformance
// violation — it could be the gold FAIL_TO_PASS suite. Kept byte-identical to sota-attest.isTestFile so
// the producer and the auditor agree on what "gold" means.
export function isGoldTestPath(p) {
  if (!p || p === '/dev/null') return false;
  const posix = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  const base = posix.split('/').pop() || '';
  if (/^test_.+\.py$/.test(base) || /.+_test\.py$/.test(base) || base === 'conftest.py') return true;
  return posix.split('/').slice(0, -1).some((seg) => seg === 'tests' || seg === 'test');
}

// ─────────────────────────── tool / files-read extraction from the ReAct transcript ─────────────────

/** Try to recover the structured action ({tool, path, pattern, dir}) from one transcript entry. */
function parseActionRaw(actionRaw) {
  if (!actionRaw || typeof actionRaw !== 'string') return null;
  // The text-JSON ReAct protocol echoes the action as a JSON object; the native-tools path echoes a
  // `tool_call`-shaped object. Try a direct JSON parse, then a first-brace/last-brace slice.
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  let obj = tryParse(actionRaw);
  if (!obj) {
    const b = actionRaw.indexOf('{'), e = actionRaw.lastIndexOf('}');
    if (b >= 0 && e > b) obj = tryParse(actionRaw.slice(b, e + 1));
  }
  if (!obj || typeof obj !== 'object') return null;
  // native tool_call shape: { function: { name, arguments } }
  if (obj.function && typeof obj.function === 'object') {
    const args = typeof obj.function.arguments === 'string' ? (tryParse(obj.function.arguments) || {}) : (obj.function.arguments || {});
    return { tool: obj.function.name, ...args };
  }
  return obj;
}

/**
 * Extract { tools_used, files_read } from a ReAct transcript ([{actionRaw, obs}]). PATHS ONLY — file
 * contents and model text are never captured. `read`/`edit`/`line_edit`/`ls` carry a path; `grep`
 * carries a pattern (not a path, so it is not a file read). Pure.
 */
export function extractToolUse(transcript, { maxFiles = 300, maxTools = 32 } = {}) {
  const tools = new Set();
  const files = new Set();
  for (const entry of Array.isArray(transcript) ? transcript : []) {
    const a = parseActionRaw(entry && entry.actionRaw);
    if (!a || !a.tool) continue;
    tools.add(String(a.tool));
    if (['read', 'edit', 'line_edit'].includes(a.tool) && typeof a.path === 'string' && a.path) {
      files.add(redactSecrets(String(a.path).replace(/^\.?\//, '')));
    }
    if (a.tool === 'ls' && typeof a.dir === 'string' && a.dir) {
      files.add(redactSecrets(String(a.dir).replace(/^\.?\//, '') + '/'));
    }
  }
  return {
    tools_used: [...tools].slice(0, maxTools),
    files_read: [...files].slice(0, maxFiles),
  };
}

// ─────────────────────────── localization sources (what the localizer surfaced) ─────────────────────

/**
 * The file paths a localizer seed surfaced into the agent's context. Accepts a localize.mjs /
 * trace-localize.mjs seed ({ files: [{file}], ... }), an array of {file}, or an array of strings.
 * Returns a de-duplicated, redacted, capped path list. Pure.
 */
export function localizationSources(...seeds) {
  const out = new Set();
  for (const seed of seeds) {
    if (!seed) continue;
    const list = Array.isArray(seed) ? seed : (Array.isArray(seed.files) ? seed.files : []);
    for (const f of list) {
      const p = typeof f === 'string' ? f : (f && f.file);
      if (p) out.add(redactSecrets(String(p).replace(/^\.?\//, '')));
    }
  }
  return [...out].slice(0, 200);
}

// ─────────────────────────── selector derivation (BoN / cascade / handoff / repro winner pick) ───────
// The winner-SELECTOR must rank on a NON-gold signal. `ranked_on` records the exact signal(s) the pick
// used, derived from what the harness already tracked in the per-instance `row` + the run config.
// CRITICAL honesty: when the run is NON-conformant (oracle in-loop, `noTestOracle=false`), the in-loop
// pass signal IS the gold oracle → ranked_on records `gold-oracle`, so sota-attest CORRECTLY fails the
// selector-conformance vector for a TDR/oracle run. A conformant run ranks on `conformant-repro-tests`.

/** The non-gold in-loop pass signal name, or the gold-oracle token when the run used the oracle. */
function inLoopSignal(noTestOracle) {
  return noTestOracle ? 'conformant-repro-tests' : 'gold-oracle';
}

/**
 * Derive the selector record from the finished per-instance `row` (row.tier, row.handoffHops, …) and
 * the run config. Pure — reads only what solve-agentic already assembled.
 */
export function deriveSelector(row = {}, { noTestOracle = false } = {}) {
  const tier = String(row.tier || 'T1');
  if (tier.startsWith('handoff')) {
    return { method: 'handoff-chain', candidates_n: (Array.isArray(row.handoffHops) ? row.handoffHops.length : 0) + 1,
      ranked_on: ['handoff-accept-heuristic'], winner: tier };
  }
  if (tier === 'repro') {
    return { method: 'repro-gate', candidates_n: (row.reproRounds | 0) || 1,
      ranked_on: ['self-written-repro-test'], winner: 'repro' };
  }
  if (tier === 'T2' || tier === 'judge') {
    // cascade: two candidate trajectories. T2 won on the in-loop test signal; judge = an LLM tie-break.
    return { method: 'cascade', candidates_n: 2,
      ranked_on: [tier === 'judge' ? 'judge-llm' : inLoopSignal(noTestOracle)], winner: tier };
  }
  // default single attempt — the "selector" is the agent's own in-loop pass signal (or bare submit).
  return { method: 'single', candidates_n: 1,
    ranked_on: [inLoopSignal(noTestOracle)], winner: 'T1' };
}

// ─────────────────────────── record assembly ─────────────────────────────────────────────────────────

/**
 * Assemble ONE redacted, size-bounded trajectory record from the signals the real solve path produced.
 * Input (all optional except instance_id):
 *   instance_id
 *   transcripts     [transcript]           one or more ReAct transcripts (base + cascade/handoff hops)
 *   localizeSeeds   [seed]                  localize.mjs / trace-localize.mjs seeds ({files:[{file}]})
 *   row             {tier, handoffHops, …}  the per-instance row solve-agentic assembled
 *   noTestOracle    bool                    the --no-test-oracle run flag (true = conformant, no gold in-loop)
 *   usedGoldOracle  bool                    did an in-loop test call hit the gold Docker oracle? (default = !noTestOracle)
 * Pure. Never touches the network / disk.
 */
export function assembleTrajectoryRecord(input = {}) {
  const {
    instance_id, transcripts = [], localizeSeeds = [], row = {},
    noTestOracle = false,
  } = input;
  const usedGoldOracle = input.usedGoldOracle != null ? !!input.usedGoldOracle : !noTestOracle;

  // tools + files-read, merged across all attempts (base solve, cascade tier-2, handoff hops).
  const tools = new Set();
  const files = new Set();
  for (const tr of transcripts) {
    const { tools_used, files_read } = extractToolUse(tr);
    tools_used.forEach((t) => tools.add(t));
    files_read.forEach((f) => files.add(f));
  }

  const localization_sources = localizationSources(...localizeSeeds);

  // gold_test_paths_accessed — the machine proof for no_gold_in_loop. The ONLY path in the darwin
  // harness that surfaces gold FAIL_TO_PASS/PASS_TO_PASS verdicts in-loop is the official Docker oracle
  // (evalOne), used ONLY when --no-test-oracle is absent (the non-conformant TDR mode). conformant-tests
  // NEVER stages the gold test_patch, so under conformance this is [] by construction. When the oracle
  // ran in-loop we record the marker (the exact gold file paths are not enumerated by the harness, but
  // the agent provably saw the gold verdict → honest non-empty evidence, not a false pass).
  const gold_test_paths_accessed = usedGoldOracle
    ? ['<official-docker-oracle:FAIL_TO_PASS+PASS_TO_PASS>']
    : [];

  const selector = deriveSelector(row, { noTestOracle });

  return {
    instance_id: redactSecrets(String(instance_id ?? 'unknown')),
    tools_used: [...tools].slice(0, 32),
    files_read: [...files].slice(0, 300),
    gold_test_paths_accessed,
    localization_sources,
    selector,
    no_test_oracle: !!noTestOracle,
  };
}

/** Serialize an array of records to a JSONL string (one record per line). Pure. */
export function serializeTrajectory(records) {
  return (records || []).map((r) => JSON.stringify(r)).join('\n') + (records && records.length ? '\n' : '');
}

// ─────────────────────────── stateful recorder (the solve-agentic wiring) ────────────────────────────

/**
 * A per-run recorder that appends one assembled record per instance to `path`. Concurrency-safe under
 * solve-agentic's worker pool (appendFileSync is atomic per line). Truncates `path` on construction so
 * a re-run starts clean. Returns { record(input), path }.
 */
export function createTrajectoryRecorder(path) {
  writeFileSync(path, ''); // truncate — one file per run
  return {
    path,
    record(input) {
      const rec = assembleTrajectoryRecord(input);
      appendFileSync(path, JSON.stringify(rec) + '\n');
      return rec;
    },
  };
}
