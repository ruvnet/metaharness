#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// sota-attest.mjs — emit an `integrity-attestation.json` for a Darwin SWE-bench SOTA claim (ADR-231).
//
// THESIS (ADR-231): a self-declared "conformant" SOTA number is worthless. A number is a SOTA CLAIM
// only if it carries a signed exploit-audit attestation. This script is the $0, deterministic producer
// of that attestation. It audits a real gold report against the UC-Berkeley-RDI threat vectors and
// emits a per-vector pass/skip/fail table + a witness hash to be Ed25519-signed at publish (ADR-103).
//
// DISCIPLINE (copied verbatim from packages/darwin-mode/bench/gaia gaia-audit / INTEGRITY-AUDIT.md):
//   a vector we cannot PROVE from the committed artifact returns `skip` + a `harness_gap` string.
//   It NEVER returns a false `pass`. Absence of evidence is skip, not clean.
//
// Inputs:
//   --gold-report <path>     REQUIRED. The OFFICIAL swebench.harness.run_evaluation report
//                            (schema_version:2 — {total_instances, resolved_instances,
//                            empty_patch_instances, ..._ids}). This is the post-hoc Docker-oracle verdict.
//   --solver-report <path>   OPTIONAL. The darwin solver's own report ({model, leaderboardConformant,
//                            noTestOracle, cascade, escalateModel, phase2, totalCost_usd, modelParams}).
//                            Carries the fields the gold report structurally cannot: cost, k-sample
//                            config, conformance flags. Absent → those vectors return skip+harness_gap.
//   --split <lite|verified>  OPTIONAL override; else inferred from total_instances (300→lite, 500→verified).
//   --dataset <name>         OPTIONAL; else inferred from split.
//   --out <path>             OPTIONAL; default integrity-attestation.json next to the gold report.
//
// Exit: 0 always writes the attestation (the attestation is the product; a `fail` vector is a finding,
//       not a crash). Callers (nightly-sota-review.mjs) decide whether a `fail`/too-many-`skip` blocks a
//       SOTA issue from opening — see ADR-231 §"Nightly integration".
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

// ─────────────────────────── pure logic (unit-tested in sota-attest.test.mjs) ───────────────────────────

/** Wilson score interval (95%) — same stats the board CIs and nightly-sota-review.mjs use. */
export function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 100];
  const p = k / n, z2 = z * z, denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return [+Math.max(0, (center - half) * 100).toFixed(1), +Math.min(100, (center + half) * 100).toFixed(1)];
}

/** SWE-bench split inference from the official denominator. 300→Lite, 500→Verified; else unknown. */
export function deriveSplit(total) {
  if (total === 300) return 'lite';
  if (total === 500) return 'verified';
  return 'unknown';
}

export function datasetForSplit(split) {
  if (split === 'lite') return 'princeton-nlp/SWE-bench_Lite';
  if (split === 'verified') return 'princeton-nlp/SWE-bench_Verified';
  return 'unknown';
}

/** empty_patch_rate straight off the official report — the honest-denominator disclosure (RDI no-work vector). */
export function emptyPatchRate(gold) {
  const tot = gold.total_instances, empty = gold.empty_patch_instances;
  if (typeof tot !== 'number' || tot === 0 || typeof empty !== 'number') return null;
  return +(empty / tot).toFixed(4);
}

/** Is this the official post-hoc Docker oracle? schema_version + the *_ids arrays are its fingerprint. */
export function isOfficialGoldReport(gold) {
  return gold && typeof gold.total_instances === 'number' && typeof gold.resolved_instances === 'number'
    && Array.isArray(gold.resolved_ids) && Array.isArray(gold.empty_patch_ids);
}

// ─────────────────────────── patch-lint (the grader-sabotage vector, ADR-231) ───────────────────────────
// The residual of the RDI grader-tampering vector: the agent's `model_patch` IS applied inside the grading
// image, so a diff that edits/deletes a test file could sabotage its own FAIL_TO_PASS scoring. This is a
// PURE, unit-tested check that runs off predictions.jsonl alone — no trajectory, no Docker, no network.

/** Is `p` a test file by SWE-bench convention? test_*.py, *_test.py, conftest.py, or under tests/ or test/. */
export function isTestFile(p) {
  if (!p || p === '/dev/null') return false;
  const posix = p.replace(/\\/g, '/').replace(/^\.\//, '');
  const base = posix.split('/').pop() || '';
  if (/^test_.+\.py$/.test(base) || /.+_test\.py$/.test(base) || base === 'conftest.py') return true;
  // any path segment is exactly `tests` or `test` (django/tests/…, requests/test/…)
  return posix.split('/').slice(0, -1).some((seg) => seg === 'tests' || seg === 'test');
}

/**
 * Extract the (a-side, b-side) file paths touched by a unified diff and whether any is a whole-file
 * deletion. Robust to patches with or without a `diff --git` header — reads `--- a/…` / `+++ b/…` too.
 * Returns { files:Set<string>, deletedFiles:Set<string> } (paths POSIX-normalised, a/ b/ stripped).
 */
export function parsePatchPaths(patch) {
  const files = new Set(), deletedFiles = new Set();
  if (typeof patch !== 'string' || !patch) return { files, deletedFiles };
  const strip = (s) => s.replace(/^[ab]\//, '').replace(/\t.*$/, '').trim();
  const lines = patch.split('\n');
  let cur = null; // path of the file the current hunk-header block is about (b-side preferred)
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let m;
    if ((m = ln.match(/^diff --git (\S+) (\S+)/))) {
      const a = strip(m[1]), b = strip(m[2]);
      if (a && a !== '/dev/null') files.add(a);
      if (b && b !== '/dev/null') files.add(b);
      cur = (b && b !== '/dev/null') ? b : a;
    } else if (/^deleted file mode/.test(ln) && cur) {
      deletedFiles.add(cur);
    } else if ((m = ln.match(/^--- (.+)$/))) {
      const a = strip(m[1]);
      if (a && a !== '/dev/null') files.add(a);
    } else if ((m = ln.match(/^\+\+\+ (.+)$/))) {
      const b = strip(m[1]);
      if (b && b !== '/dev/null') { files.add(b); cur = b; }
      else if (b === '/dev/null' && cur) deletedFiles.add(cur); // +++ /dev/null → file removed
    }
  }
  return { files, deletedFiles };
}

/** Lint one patch: which test files it touches / deletes. Pure. */
export function lintPatch(patch) {
  const { files, deletedFiles } = parsePatchPaths(patch);
  const testFiles = [...files].filter(isTestFile);
  const deletedTestFiles = [...deletedFiles].filter(isTestFile);
  return {
    touchesTests: testFiles.length > 0,
    deletesTests: deletedTestFiles.length > 0,
    testFiles,
  };
}

/**
 * Lint a whole predictions.jsonl (array of {instance_id, model_patch}). Marks each entry `resolved` if its
 * instance_id is in the gold resolved set — a resolved instance that edits tests is the CRITICAL case.
 */
export function lintPredictions(preds, { resolvedIds } = {}) {
  const resolvedSet = new Set(resolvedIds || []);
  return (preds || []).map((p) => {
    const l = lintPatch(p.model_patch);
    return { instance_id: p.instance_id, resolved: resolvedSet.has(p.instance_id), ...l };
  });
}

/** Parse a predictions.jsonl string into an array (skips blank lines / bad JSON lines defensively). */
export function parsePredictionsJsonl(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip malformed line */ }
  }
  return out;
}

const VEC = (vector, result, evidence, harness_gap) =>
  harness_gap ? { vector, result, evidence, harness_gap } : { vector, result, evidence };

/**
 * The per-vector RDI audit. Each entry is pass | skip | fail. `skip` ALWAYS carries a harness_gap.
 * `gold` = official report (required), `solver` = darwin solver report (may be null).
 * Structural-immunity claims are justified from the harness, not asserted; everything else is skip
 * until an artifact proves it.
 */
export function vectorAudit(gold, solver, predictions = null, trajectory = null) {
  const v = [];
  // ADR-231 forward-contract — the solver-trajectory.jsonl (one record per instance) is the serialized
  // artifact that upgrades three vectors from skip/attested-by-flag to enforceable. Present + non-empty →
  // we PROVE (or disprove) no_gold_in_loop / localization_no_gold / best_of_n_selector_conformant from it;
  // absent → each stays a skip/attested-by-flag exactly as before (never a false pass). `hasTraj` gates
  // every override so a run without a trajectory is byte-identical to pre-ADR-231-forward-contract.
  const hasTraj = Array.isArray(trajectory) && trajectory.length > 0;
  // Gold signal tokens a conformant winner-selector must NEVER rank on (gold FAIL_TO_PASS/PASS_TO_PASS
  // or the official Docker oracle). Matches the `gold-oracle` marker solver-trajectory.mjs records for a
  // non-conformant (oracle-in-loop) run, and any explicit fail_to_pass/pass_to_pass signal.
  const GOLD_SIGNAL_RE = /gold|oracle|fail_to_pass|pass_to_pass/i;

  // ── Structurally immune (justified from harness code) ──
  v.push(VEC('answer_db_leakage', 'immune',
    'No answer-DB analog: success requires a source diff that flips held-out gold FAIL_TO_PASS under the '
    + 'official Docker harness. conformant-tests.mjs NEVER applies the gold test_patch in-loop; the gold '
    + 'verdict is computed post-hoc by swebench.harness.run_evaluation. Retrieving text cannot substitute '
    + 'for a compiling, test-passing patch. (Contrast GAIA, where the answer string IS the deliverable.)'));

  v.push(VEC('normalization_collision', 'immune',
    'Scoring is binary test execution (FAIL_TO_PASS must flip fail→pass AND PASS_TO_PASS must stay pass), '
    + 'not string/substring matching. There is no relaxed metric to collide — unlike GAIA acc_relaxed.'));

  v.push(VEC('grader_tampering_external', 'immune',
    'The grader (run_evaluation) is a SEPARATE post-hoc process on a fresh image, outside the agent tool '
    + 'sandbox, after the agent has stopped. The agent writes only a predictions.jsonl patch; it cannot '
    + 'monkey-patch the grader process (the RDI o3/Claude-3.7 30%+ vector).'));

  v.push(VEC('no_work_scores_a_pass', 'immune',
    'An empty/no-work patch cannot flip a failing test, so it structurally scores 0 — the inverse of the '
    + 'GAIA "empty answer scores 100%" vector. (Disclosure of the empty RATE is a separate vector below.)'));

  // ── Needs explicit attestation (NOT immune) ──

  // (1) Grader-tampering-via-PATCH — THE CRITICAL residual of the grader vector (ADR-231). The agent's patch
  //     IS applied inside the grading image, so a diff that edits/deletes a test file / conftest could
  //     sabotage its own FAIL_TO_PASS scoring. Now PROVEN directly off predictions.jsonl (no trajectory
  //     needed): parse each model_patch, flag any hunk touching a test file. A RESOLVED instance whose patch
  //     edits tests → CRITICAL fail. A patch-lint array on the solver report (legacy shape) is honored too.
  const patchLint = Array.isArray(predictions) ? lintPredictions(predictions, { resolvedIds: gold.resolved_ids })
    : (solver && Array.isArray(solver.patchLint)) ? solver.patchLint : null;
  if (patchLint) {
    const flagged = patchLint.filter((p) => p.touchesTests || p.deletesTests);
    const resolvedSet = new Set(gold.resolved_ids || []);
    // CRITICAL = a test-touching patch on a RESOLVED instance (may have sabotaged the scored verdict).
    // Legacy patch-lint entries carry no instance_id → treated as critical (conservative, never a false pass).
    const critical = flagged.filter((p) => (p.instance_id ? resolvedSet.has(p.instance_id) : true) || p.resolved);
    const total = patchLint.length;
    if (critical.length) {
      const ids = critical.filter((p) => p.instance_id).map((p) => p.instance_id).slice(0, 8);
      v.push({ ...VEC('patch_touches_tests', 'fail',
        `${critical.length} RESOLVED instance patch(es) edit/delete test files → possible grader sabotage of the scored verdict`
        + `${ids.length ? ` (e.g. ${ids.join(', ')})` : ''}`), critical: true });
    } else {
      const unresolvedNote = flagged.length
        ? `; ${flagged.length}/${total} patch(es) touch tests but on UNRESOLVED instances (did not sabotage a scored pass)`
        : '';
      v.push({ ...VEC('patch_touches_tests', 'pass',
        `${total} submitted patch(es) linted off predictions.jsonl; 0 RESOLVED-instance patch edits or deletes a test file${unresolvedNote}`), critical: true });
    }
  } else {
    v.push({ ...VEC('patch_touches_tests', 'skip', 'no predictions.jsonl and no per-instance patch-lint',
      'Pass --predictions <predictions.jsonl> (or serialize a patch-lint into the solver report) to lint the '
      + 'submitted diffs against test-file edits and turn this skip into a provable pass/fail.'), critical: true });
  }

  // (2) Best-of-N / k-sample disclosure + CONFORMANT winner selection.
  //     Darwin solver reports disclose the k-sample count as `k` (MCTS/BoN) or via `cascade`/`escalateModel`.
  const kN = typeof solver?.kSampleN === 'number' ? solver.kSampleN : (typeof solver?.k === 'number' ? solver.k : null);
  if (solver && (kN != null || solver.cascade != null || solver.escalateModel != null)) {
    const selector = solver.winnerSelector || (solver.noTestOracle === false ? 'unknown' : 'conformant-repro?');
    v.push(VEC('best_of_n_disclosure', 'pass',
      `k/best-of-N config disclosed: cascade=${solver.cascade}, escalateModel=${solver.escalateModel ?? 'none'}, `
      + `k=${kN ?? 'n/a'}, selector=${selector}. `
      + `noTestOracle=${solver.noTestOracle} (if false, no gold oracle picked the winner).`));
    if ((selector === 'unknown' || solver.winnerSelector == null) && !hasTraj) {
      v.push(VEC('best_of_n_selector_conformant', 'skip', 'winner-selection method not serialized',
        'k-sample N is disclosed but the SELECTOR is not proven conformant (must be repro-tests, never gold '
        + 'FAIL_TO_PASS). Pass --trajectory to serialize selector.ranked_on and prove no oracle leakage in the pick.'));
    }
  } else {
    v.push(VEC('best_of_n_disclosure', 'skip', 'no solver report / no k-sample config present',
      'darwin uses best-of-N (temp>0 N trajectories), MCTS best-of-3, cross-model best-of-N (xbo), and '
      + 'ADR-205 cascade escalation. Attach the solver report so N + winner-selector are attested.'));
  }

  // (3) Empty-patch-rate honest-denominator disclosure (RDI no-work vector, disclosure side).
  const epr = emptyPatchRate(gold);
  v.push(epr == null
    ? VEC('empty_patch_rate_disclosed', 'skip', 'empty_patch_instances/total missing from gold report', 'non-official report schema')
    : VEC('empty_patch_rate_disclosed', 'pass',
      `empty_patch_rate=${(epr * 100).toFixed(1)}% (${gold.empty_patch_instances}/${gold.total_instances}), counted as UNRESOLVED in the denominator`));

  // (4) Cost measured, not inferred (Pareto/$-per-resolve claims).
  if (solver && typeof solver.totalCost_usd === 'number') {
    v.push(VEC('cost_measured', 'pass',
      `totalCost_usd=$${solver.totalCost_usd} (measured OpenRouter spend), per-inst=$${solver.blendedCostPerInst_usd ?? '?'}`));
  } else {
    v.push(VEC('cost_measured', 'skip', 'no measured cost in artifacts',
      'The official gold report structurally carries NO cost; the solver report does. Absent it, any $/resolve '
      + 'is inferred (see nightly-sota-review.mjs inferCost) — NOT attestable. Attach the solver report.'));
  }

  // (5) Split / seed / temperature reproducibility.
  const seed = solver?.seed ?? solver?.modelParams?.seed;
  const temp = solver?.modelParams?.temperature;
  v.push(VEC('reproducibility', temp != null ? 'pass' : 'skip',
    `n=${gold.total_instances}, split-inferred; temperature=${temp ?? '?'}, seed=${seed ?? '?'}`,
    temp != null ? undefined : 'temperature/seed not in report — pin them to make the run reproducible'));

  // (6) Localization / ADR-195 retrieval must not surface gold tests (the FRAMES answer-leakage analog).
  //     ENFORCEABLE with the trajectory: every localization_sources[] path is linted with the SAME
  //     gold-test-path heuristic as patch_touches_tests (isTestFile). Any test path a localizer surfaced
  //     into the agent's context is a conformance breach (the conformant localizer skips all test dirs by
  //     construction — localize.mjs SKIP_DIRS). No trajectory → skip + forward-contract gap, as before.
  if (hasTraj) {
    const allSources = trajectory.flatMap((r) => Array.isArray(r.localization_sources) ? r.localization_sources : []);
    const goldHits = [...new Set(allSources.filter(isTestFile))];
    if (goldHits.length) {
      v.push(VEC('localization_no_gold', 'fail',
        `localizer surfaced ${goldHits.length} gold test path(s) into agent context (e.g. ${goldHits.slice(0, 5).join(', ')}) `
        + `— retrieval leaked gold FAIL_TO_PASS`));
    } else {
      v.push(VEC('localization_no_gold', 'pass',
        `${trajectory.length} instance trajector${trajectory.length === 1 ? 'y' : 'ies'} serialized; ${allSources.length} localization source path(s) surfaced, `
        + `0 are gold test paths (conformant retrieval — localize.mjs/trace-localize point only at source)`));
    }
  } else {
    v.push(VEC('localization_no_gold', 'skip', 'phase2 localize/trace-localize trajectory not serialized',
      'SAME forward-contract gap as FRAMES answer-leakage (INTEGRITY-AUDIT.md): localize.mjs / '
      + 'ruvector-localize.mjs / trace-localize run over repo source and conformant-tests.mjs never applies '
      + 'the gold test_patch, so gold is not in the corpus by construction — but we cannot PROVE the retrieved '
      + 'context excluded gold FAIL_TO_PASS without serializing the localization inputs. Pass --trajectory '
      + '<solver-trajectory.jsonl> (ADR-231 forward-contract) to turn this into a provable pass/fail.'));
  }

  // (7) No-gold-in-loop conformance flag (the SOTA_HORIZON honor-system claim, upgraded).
  //     Two machine-readable corroborations: leaderboardConformant AND noTestOracle (the --no-test-oracle
  //     switch: the solver ran with NO gold test oracle in-loop). Still `attested-by-flag`, not a full
  //     `pass` — a full pass needs the in-loop trajectory serialized (forward contract) — but the paired
  //     noTestOracle=true flag is a stronger, machine-checkable signal than the honor-system claim alone.
  //     ENFORCEABLE with the trajectory: the serialized per-instance gold_test_paths_accessed is the
  //     machine proof. Empty on EVERY instance → the solver provably never read the gold FAIL_TO_PASS/
  //     PASS_TO_PASS suite (or the gold test_patch) in-loop → PASS. Any instance with a non-empty set →
  //     a gold oracle ran in-loop → CRITICAL fail (a TDR/oracle run is NOT leaderboard-conformant).
  if (hasTraj) {
    const accessed = trajectory.filter((r) => Array.isArray(r.gold_test_paths_accessed) && r.gold_test_paths_accessed.length > 0);
    if (accessed.length) {
      v.push({ ...VEC('no_gold_in_loop', 'fail',
        `${accessed.length}/${trajectory.length} instance(s) accessed the gold test suite in-loop `
        + `(e.g. ${accessed.slice(0, 5).map((r) => r.instance_id).join(', ')}) — NON-conformant (gold oracle seen during solving)`),
        critical: true });
    } else {
      v.push({ ...VEC('no_gold_in_loop', 'pass',
        `${trajectory.length} instance trajector${trajectory.length === 1 ? 'y' : 'ies'} serialized; gold_test_paths_accessed empty on ALL `
        + `— machine-proven the solver never read gold FAIL_TO_PASS/PASS_TO_PASS in-loop (conformant-tests.mjs enforced, now trajectory-verified)`),
        critical: true });
    }
  } else if (solver && solver.leaderboardConformant === true) {
    const noOracle = solver.noTestOracle === true;
    v.push(VEC('no_gold_in_loop', 'attested-by-flag',
      `solver report leaderboardConformant=true${noOracle ? ' AND noTestOracle=true (ran with --no-test-oracle: '
        + 'no gold oracle in-loop)' : ' (noTestOracle not asserted — weaker)'}; conformant-tests.mjs is the `
      + 'enforcing gate (never applies gold test_patch). "attested-by-flag" (not "proven") until the in-loop '
      + 'trajectory is serialized to make the no-gold-access property fully machine-checkable.'));
  } else {
    v.push(VEC('no_gold_in_loop', 'skip', 'leaderboardConformant flag absent/false',
      'The core conformance claim is unattested for this run. Attach a solver report with '
      + 'leaderboardConformant=true, and serialize the trajectory (--trajectory) to upgrade to a provable pass.'));
  }

  // (8) Best-of-N winner-SELECTOR conformance — ENFORCEABLE with the trajectory (ADR-231 forward-contract).
  //     The per-instance selector.ranked_on records the exact signal(s) the winner-pick used. A conformant
  //     selector ranks on repro tests / self-written repro / an LLM judge / a handoff-accept heuristic —
  //     NEVER on gold. Any gold signal in ranked_on (e.g. the `gold-oracle` marker a non-conformant run
  //     records) → fail. No trajectory → the skip emitted in the best_of_n block above stands.
  if (hasTraj) {
    const rankedOn = trajectory.flatMap((r) => (r.selector && Array.isArray(r.selector.ranked_on)) ? r.selector.ranked_on : []);
    const goldSignals = [...new Set(rankedOn.map(String).filter((s) => GOLD_SIGNAL_RE.test(s)))];
    if (goldSignals.length) {
      v.push(VEC('best_of_n_selector_conformant', 'fail',
        `winner-selector ranked on gold signal(s): ${goldSignals.join(', ')} — a gold oracle picked the best-of-N/cascade winner`));
    } else {
      const methods = [...new Set(trajectory.map((r) => r.selector && r.selector.method).filter(Boolean))];
      v.push(VEC('best_of_n_selector_conformant', 'pass',
        `selector ranked_on across ${trajectory.length} instance(s) carries no gold signal (methods: ${methods.join(', ') || 'single'}); `
        + `winner chosen on non-gold signal only (repro/self-repro/judge/handoff-heuristic)`));
    }
  }

  return v;
}

/** Deterministic canonical JSON (sorted keys) — the exact bytes the Ed25519 witness signs. */
export function canonicalize(obj) {
  const sort = (x) => Array.isArray(x) ? x.map(sort)
    : (x && typeof x === 'object') ? Object.keys(x).sort().reduce((a, k) => (a[k] = sort(x[k]), a), {})
      : x;
  return JSON.stringify(sort(obj));
}

export function witnessHash(bodyObj) {
  return createHash('sha256').update(canonicalize(bodyObj)).digest('hex');
}

/** Build the full attestation object from a gold report (+ optional solver report). */
export function buildAttestation(gold, solver, { split, dataset, harnessVersion, now, predictions, trajectory } = {}) {
  const total = gold.total_instances, resolved = gold.resolved_instances;
  const sp = split || deriveSplit(total);
  const vectors = vectorAudit(gold, solver, predictions, trajectory);
  const hasTraj = Array.isArray(trajectory) && trajectory.length > 0;
  const body = {
    attestation_version: '1.0',
    adr: 'ADR-231',
    harness_version: harnessVersion || 'unknown',
    generated_at: now || new Date().toISOString(),
    run: {
      split: sp,
      n: total,
      dataset_name: dataset || datasetForSplit(sp),
      gold_oracle: 'official-docker:swebench.harness.run_evaluation',
      gold_oracle_proven_by: isOfficialGoldReport(gold)
        ? `schema_version:${gold.schema_version ?? '?'} report with resolved_ids/empty_patch_ids present`
        : 'NON-OFFICIAL SCHEMA — gold-oracle provenance NOT proven',
      resolved,
      resolve_pct: total ? +(100 * resolved / total).toFixed(1) : null,
      wilson_ci: total ? wilson(resolved, total) : null,
    },
    empty_patch_rate: emptyPatchRate(gold),
    k_sample: {
      N: solver?.kSampleN ?? solver?.k ?? null,
      cascade: solver?.cascade ?? null,
      escalate_model: solver?.escalateModel ?? null,
      winner_selector: solver?.winnerSelector ?? null,
    },
    patches_linted: Array.isArray(predictions) ? predictions.length : null,
    // ADR-231 forward-contract — the serialized solver-trajectory summary (null when no --trajectory).
    trajectory: hasTraj ? {
      instances: trajectory.length,
      gold_test_paths_accessed_instances: trajectory.filter((r) => Array.isArray(r.gold_test_paths_accessed) && r.gold_test_paths_accessed.length).length,
      localization_sources_total: trajectory.reduce((a, r) => a + (Array.isArray(r.localization_sources) ? r.localization_sources.length : 0), 0),
      selector_methods: [...new Set(trajectory.map((r) => r.selector && r.selector.method).filter(Boolean))],
    } : null,
    cost: {
      total_usd: solver?.totalCost_usd ?? null,
      per_inst_usd: solver?.blendedCostPerInst_usd ?? null,
      source: typeof solver?.totalCost_usd === 'number' ? 'measured' : 'skip',
    },
    vectors,
    summary: vectors.reduce((a, x) => (a[x.result] = (a[x.result] || 0) + 1, a), {}),
  };
  const witness_sha256 = witnessHash(body);
  return {
    ...body,
    signature: {
      alg: 'ed25519',
      witness_sha256,
      // NEVER fabricate a signature. Signed at publish with the harness Ed25519 key (.harness/witness.json,
      // ADR-103 / verify-witness skill) — exactly as ruflo signs its GAIA attestation (ADR-167).
      sig: null,
      pubkey: null,
      todo: 'sign witness_sha256 with the publisher Ed25519 key at PR/issue time; embed sig+pubkey.',
    },
  };
}

// ─────────────────────────── Ed25519 signing (ADR-103, node-native, zero-dep) ───────────────────────────
// Uses Node's built-in Ed25519 (no @noble, no external key infra). Keys are the same raw-hex convention the
// harness witness manifest uses (32-byte/64-hex pubkey, 64-byte/128-hex signature — see witness-client.ts).
// We sign the raw 32-byte witness digest (SHA-256 of the canonical attestation body). The signature is
// produced ONLY when a seed is explicitly provided; the script NEVER fabricates or persists a key.

// Fixed DER prefixes to wrap a raw 32-byte Ed25519 seed / public key into PKCS8 / SPKI for node's crypto.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex'); // + 32-byte seed
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');           // + 32-byte pubkey

/** Import a raw 32-byte Ed25519 seed (Buffer or 64-hex string) into a node private KeyObject. */
export function privKeyFromSeed(seed) {
  const raw = Buffer.isBuffer(seed) ? seed : Buffer.from(String(seed).trim(), 'hex');
  if (raw.length !== 32) throw new Error(`ed25519 seed must be 32 bytes (got ${raw.length})`);
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]), format: 'der', type: 'pkcs8' });
}

/** Import a raw 32-byte Ed25519 public key (Buffer or 64-hex) into a node public KeyObject. */
export function pubKeyFromRaw(pub) {
  const raw = Buffer.isBuffer(pub) ? pub : Buffer.from(String(pub).trim(), 'hex');
  if (raw.length !== 32) throw new Error(`ed25519 public key must be 32 bytes (got ${raw.length})`);
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** Extract the raw 32-byte public key (hex) from a private KeyObject. */
export function rawPublicHex(privKey) {
  const spki = createPublicKey(privKey).export({ format: 'der', type: 'spki' });
  return Buffer.from(spki.subarray(spki.length - 32)).toString('hex');
}

/**
 * Sign an attestation with a raw Ed25519 seed. Returns a NEW attestation whose `signature` block carries the
 * real 128-hex signature + 64-hex pubkey over the witness digest. Recomputes the witness first so a signature
 * is always bound to the exact body being signed.
 */
export function signAttestation(att, seed) {
  const { signature, ...body } = att;
  const witness_sha256 = witnessHash(body);
  const priv = privKeyFromSeed(seed);
  const sig = edSign(null, Buffer.from(witness_sha256, 'hex'), priv);
  return {
    ...body,
    signature: {
      alg: 'ed25519',
      witness_sha256,
      sig: sig.toString('hex'),
      pubkey: rawPublicHex(priv),
    },
  };
}

/**
 * Verify a signed attestation: (a) recompute the witness over the body and confirm it matches the embedded
 * witness_sha256 (catches ANY body tampering), then (b) Ed25519-verify the signature over that digest with
 * the embedded pubkey. Returns { valid, reason, witnessMatch, sigValid }.
 */
export function verifyAttestation(att) {
  if (!att || typeof att !== 'object' || !att.signature) return { valid: false, reason: 'no signature block' };
  const { signature, ...body } = att;
  const recomputed = witnessHash(body);
  const witnessMatch = recomputed === signature.witness_sha256;
  if (!witnessMatch) return { valid: false, witnessMatch: false, reason: `witness_sha256 mismatch — body tampered (recomputed ${recomputed.slice(0, 16)}… ≠ embedded ${String(signature.witness_sha256).slice(0, 16)}…)` };
  if (!signature.sig || !signature.pubkey) return { valid: false, witnessMatch: true, sigValid: false, reason: 'unsigned (sig/pubkey null) — witness matches but no Ed25519 signature to verify' };
  let sigValid = false;
  try {
    sigValid = edVerify(null, Buffer.from(signature.witness_sha256, 'hex'), pubKeyFromRaw(signature.pubkey), Buffer.from(signature.sig, 'hex'));
  } catch (e) { return { valid: false, witnessMatch: true, sigValid: false, reason: `signature verify error: ${e.message}` }; }
  return sigValid ? { valid: true, witnessMatch: true, sigValid: true } : { valid: false, witnessMatch: true, sigValid: false, reason: 'Ed25519 signature does not verify against pubkey' };
}

/**
 * The fail-closed gate decision (used by nightly-sota-review.mjs). A number is publishable as SOTA only if
 * NO vector `fail`s (a CRITICAL fail — e.g. patch_touches_tests — always blocks) AND the number of honest
 * `skip`s does not exceed `maxSkips`. `immune`/`pass`/`attested-by-flag` do not count against the budget.
 */
export function integrityGateDecision(att, { maxSkips = 4 } = {}) {
  const vectors = att?.vectors || [];
  const fails = vectors.filter((v) => v.result === 'fail');
  const criticalFails = fails.filter((v) => v.critical);
  const skips = vectors.filter((v) => v.result === 'skip');
  const open = fails.length === 0 && skips.length <= maxSkips;
  const reasons = [];
  if (criticalFails.length) reasons.push(`CRITICAL fail: ${criticalFails.map((v) => v.vector).join(', ')}`);
  if (fails.length && !criticalFails.length) reasons.push(`fail: ${fails.map((v) => v.vector).join(', ')}`);
  if (skips.length > maxSkips) reasons.push(`${skips.length} skips > threshold ${maxSkips}: ${skips.map((v) => v.vector).join(', ')}`);
  if (open) reasons.push(`clean: 0 fails, ${skips.length}/${maxSkips} skips within budget`);
  return { open, fails: fails.map((v) => v.vector), criticalFails: criticalFails.map((v) => v.vector), skipCount: skips.length, maxSkips, reason: reasons.join('; ') };
}

// ─────────────────────────── CLI ───────────────────────────
function argv(k, d) { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

const USAGE = 'usage: sota-attest.mjs --gold-report <official-report.json> [--solver-report <r.json>] '
  + '[--predictions <predictions.jsonl>] [--trajectory <solver-trajectory.jsonl>] [--split lite|verified] '
  + '[--out <path>] [--sign] [--seed-hex <64hex>|--key <file>]\n'
  + '       sota-attest.mjs --verify <integrity-attestation.json>';

/** Resolve the Ed25519 signing seed (64-hex) from --seed-hex, --key <file>, or $SOTA_SIGNING_SEED_HEX. Never logged. */
function resolveSeed() {
  const inline = argv('--seed-hex');
  if (inline) return inline.trim();
  const keyFile = argv('--key');
  if (keyFile) {
    if (!existsSync(keyFile)) { console.error(`--key file not found: ${keyFile}`); process.exit(1); }
    return readFileSync(keyFile, 'utf8').trim();
  }
  if (process.env.SOTA_SIGNING_SEED_HEX) return process.env.SOTA_SIGNING_SEED_HEX.trim();
  return null;
}

function main() {
  // ── verify mode ──
  const verifyPath = argv('--verify');
  if (verifyPath) {
    if (!existsSync(verifyPath)) { console.error(`attestation not found: ${verifyPath}`); process.exit(1); }
    const att = JSON.parse(readFileSync(verifyPath, 'utf8'));
    const r = verifyAttestation(att);
    console.log(`verify ${verifyPath}`);
    console.log(`  witness match: ${r.witnessMatch === false ? 'NO' : 'yes'}   signature: ${r.sigValid ? 'VALID' : (r.sigValid === false ? 'invalid/absent' : 'n/a')}`);
    console.log(`  VERDICT: ${r.valid ? 'VALID — attestation is authentic and untampered' : `INVALID — ${r.reason}`}`);
    process.exit(r.valid ? 0 : 1);
  }

  const goldPath = argv('--gold-report');
  if (!goldPath) { console.error(USAGE); process.exit(1); }
  if (!existsSync(goldPath)) { console.error(`gold report not found: ${goldPath}`); process.exit(1); }
  const gold = JSON.parse(readFileSync(goldPath, 'utf8'));
  const solverPath = argv('--solver-report');
  const solver = solverPath && existsSync(solverPath) ? JSON.parse(readFileSync(solverPath, 'utf8')) : null;
  if (solverPath && !solver) console.error(`WARN: solver report not found: ${solverPath} — cost/k-sample vectors will skip`);
  const predPath = argv('--predictions');
  let predictions = null;
  if (predPath) {
    if (!existsSync(predPath)) console.error(`WARN: predictions not found: ${predPath} — patch_touches_tests will skip`);
    else predictions = parsePredictionsJsonl(readFileSync(predPath, 'utf8'));
  }
  // ADR-231 forward-contract — the solver-trajectory.jsonl (same JSONL parse as predictions). Absent →
  // no_gold_in_loop / localization_no_gold / best_of_n_selector_conformant stay skip/attested-by-flag.
  const trajPath = argv('--trajectory');
  let trajectory = null;
  if (trajPath) {
    if (!existsSync(trajPath)) console.error(`WARN: trajectory not found: ${trajPath} — no_gold_in_loop/localization_no_gold/best_of_n_selector_conformant will not be enforced`);
    else trajectory = parsePredictionsJsonl(readFileSync(trajPath, 'utf8'));
  }

  let harnessVersion = 'unknown';
  try { harnessVersion = execSync('git rev-parse --short HEAD', { cwd: dirname(resolve(goldPath)), encoding: 'utf8' }).trim(); } catch { /**/ }

  let att = buildAttestation(gold, solver, { split: argv('--split'), dataset: argv('--dataset'), harnessVersion, predictions, trajectory });

  // ── optional real Ed25519 signing at emit time ──
  if (process.argv.includes('--sign')) {
    const seed = resolveSeed();
    if (!seed) { console.error('--sign requires a key: --seed-hex <64hex>, --key <file>, or $SOTA_SIGNING_SEED_HEX'); process.exit(1); }
    att = signAttestation(att, seed);
  }

  const out = argv('--out', join(dirname(resolve(goldPath)), 'integrity-attestation.json'));
  writeFileSync(out, JSON.stringify(att, null, 2));

  const { split, n, resolved, resolve_pct, wilson_ci } = att.run;
  console.log(`integrity-attestation → ${out}`);
  console.log(`  claim: ${split} ${resolved}/${n} = ${resolve_pct}% (Wilson ${wilson_ci?.[0]}–${wilson_ci?.[1]}%), gold-oracle=official-docker`);
  console.log(`  empty_patch_rate: ${att.empty_patch_rate != null ? (att.empty_patch_rate * 100).toFixed(1) + '%' : 'skip'}   cost: ${att.cost.source}   patches_linted: ${att.patches_linted ?? 'none'}   trajectory: ${att.trajectory ? att.trajectory.instances + ' inst' : 'none'}   witness: ${att.signature.witness_sha256.slice(0, 16)}…`);
  console.log(`  signature: ${att.signature.sig ? 'SIGNED (ed25519, pubkey ' + att.signature.pubkey.slice(0, 16) + '…)' : 'unsigned (sig=null)'}`);
  console.log('  per-vector:');
  for (const v of att.vectors) console.log(`    ${v.result.toUpperCase().padEnd(16)} ${v.vector}${v.critical ? ' *CRITICAL*' : ''}${v.harness_gap ? '  [gap]' : ''}`);
  console.log(`  summary: ${JSON.stringify(att.summary)}`);
  const gate = integrityGateDecision(att);
  console.log(`  gate: ${gate.open ? 'OPEN' : 'FAIL-CLOSED'} — ${gate.reason}`);
  const hasFail = att.vectors.some((v) => v.result === 'fail');
  if (hasFail) {
    // ADR-231: a failed vector (e.g. a trajectory-proven gold-in-loop access, a gold path in
    // localization, or a gold-signal selector) is a hard integrity finding — exit non-zero so CI and
    // the publish pipeline fail-closed on it. The attestation file is still written (the finding is the
    // product); only the exit code signals the failure.
    console.log(`  VERDICT: FAIL — vector(s) failed: ${att.vectors.filter((v) => v.result === 'fail').map((v) => v.vector).join(', ')}; this number is NOT a credible SOTA claim.`);
    process.exit(1);
  } else if (!att.signature.sig) console.log('  VERDICT: attestation emitted (skips are honest gaps, not passes). Sign witness_sha256 (--sign) to make it a SOTA-eligible claim.');
  else console.log('  VERDICT: SIGNED attestation emitted — recompute + verify with `--verify`.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
