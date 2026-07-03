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
import { createHash } from 'node:crypto';
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

const VEC = (vector, result, evidence, harness_gap) =>
  harness_gap ? { vector, result, evidence, harness_gap } : { vector, result, evidence };

/**
 * The per-vector RDI audit. Each entry is pass | skip | fail. `skip` ALWAYS carries a harness_gap.
 * `gold` = official report (required), `solver` = darwin solver report (may be null).
 * Structural-immunity claims are justified from the harness, not asserted; everything else is skip
 * until an artifact proves it.
 */
export function vectorAudit(gold, solver) {
  const v = [];

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

  // (1) Grader-tampering-via-PATCH — the ONE residual of the grader vector. The agent's patch IS applied
  //     inside the grading image, so a diff that edits test files / conftest / deletes tests could sabotage
  //     scoring. Not provable without the submitted diffs serialized → skip unless a patch-lint is present.
  if (solver && Array.isArray(solver.patchLint)) {
    const bad = solver.patchLint.filter((p) => p.touchesTests || p.deletesTests);
    v.push(bad.length
      ? VEC('patch_touches_tests', 'fail', `${bad.length} submitted patch(es) edit/delete test files`)
      : VEC('patch_touches_tests', 'pass', 'no submitted patch edits or deletes test files (patchLint clean)'));
  } else {
    v.push(VEC('patch_touches_tests', 'skip', 'no per-instance patch-lint in the report',
      'FORWARD-CONTRACT GAP (ADR-167 §4 / ruflo#2550): submitted diffs are not serialized, so we cannot '
      + 'prove the patch did not edit conftest/tests. Apply the trajectory-serialization contract to the '
      + 'darwin bench harness to turn this skip into a provable pass.'));
  }

  // (2) Best-of-N / k-sample disclosure + CONFORMANT winner selection.
  if (solver && (typeof solver.kSampleN === 'number' || solver.cascade != null || solver.escalateModel != null)) {
    const selector = solver.winnerSelector || (solver.noTestOracle === false ? 'unknown' : 'conformant-repro?');
    v.push(VEC('best_of_n_disclosure', 'pass',
      `k/best-of-N config disclosed: cascade=${solver.cascade}, escalateModel=${solver.escalateModel ?? 'none'}, `
      + `kSampleN=${solver.kSampleN ?? 'n/a'}, selector=${selector}. `
      + `noTestOracle=${solver.noTestOracle} (if false, no gold oracle picked the winner).`));
    if (selector === 'unknown' || solver.winnerSelector == null) {
      v.push(VEC('best_of_n_selector_conformant', 'skip', 'winner-selection method not serialized',
        'k-sample N is disclosed but the SELECTOR is not proven conformant (must be repro-tests, never gold '
        + 'FAIL_TO_PASS). Serialize the selector to prove no oracle leakage in the pick.'));
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
  v.push(VEC('localization_no_gold', 'skip', 'phase2 localize/trace-localize trajectory not serialized',
    'SAME forward-contract gap as FRAMES answer-leakage (INTEGRITY-AUDIT.md): localize.mjs / '
    + 'ruvector-localize.mjs / trace-localize run over repo source and conformant-tests.mjs never applies '
    + 'the gold test_patch, so gold is not in the corpus by construction — but we cannot PROVE the retrieved '
    + 'context excluded gold FAIL_TO_PASS without serializing the localization inputs. ADR-167 §4 fix applies.'));

  // (7) No-gold-in-loop conformance flag (the SOTA_HORIZON honor-system claim, upgraded).
  if (solver && solver.leaderboardConformant === true) {
    v.push(VEC('no_gold_in_loop', 'attested-by-flag',
      'solver report leaderboardConformant=true; conformant-tests.mjs is the enforcing gate (never applies '
      + 'gold test_patch). Downgraded from "proven" to "attested-by-flag" until the in-loop trajectory is '
      + 'serialized to make the no-gold-access property machine-checkable.'));
  } else {
    v.push(VEC('no_gold_in_loop', 'skip', 'leaderboardConformant flag absent/false',
      'The core conformance claim is unattested for this run. Attach a solver report with '
      + 'leaderboardConformant=true, and serialize the trajectory to upgrade to a provable pass.'));
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
export function buildAttestation(gold, solver, { split, dataset, harnessVersion, now } = {}) {
  const total = gold.total_instances, resolved = gold.resolved_instances;
  const sp = split || deriveSplit(total);
  const vectors = vectorAudit(gold, solver);
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
      N: solver?.kSampleN ?? null,
      cascade: solver?.cascade ?? null,
      escalate_model: solver?.escalateModel ?? null,
      winner_selector: solver?.winnerSelector ?? null,
    },
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

// ─────────────────────────── CLI ───────────────────────────
function argv(k, d) { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

function main() {
  const goldPath = argv('--gold-report');
  if (!goldPath) { console.error('usage: sota-attest.mjs --gold-report <official-report.json> [--solver-report <r.json>] [--split lite|verified] [--out <path>]'); process.exit(1); }
  if (!existsSync(goldPath)) { console.error(`gold report not found: ${goldPath}`); process.exit(1); }
  const gold = JSON.parse(readFileSync(goldPath, 'utf8'));
  const solverPath = argv('--solver-report');
  const solver = solverPath && existsSync(solverPath) ? JSON.parse(readFileSync(solverPath, 'utf8')) : null;
  if (solverPath && !solver) console.error(`WARN: solver report not found: ${solverPath} — cost/k-sample vectors will skip`);

  let harnessVersion = 'unknown';
  try { harnessVersion = execSync('git rev-parse --short HEAD', { cwd: dirname(resolve(goldPath)), encoding: 'utf8' }).trim(); } catch { /**/ }

  const att = buildAttestation(gold, solver, { split: argv('--split'), dataset: argv('--dataset'), harnessVersion });
  const out = argv('--out', join(dirname(resolve(goldPath)), 'integrity-attestation.json'));
  writeFileSync(out, JSON.stringify(att, null, 2));

  const { split, n, resolved, resolve_pct, wilson_ci } = att.run;
  console.log(`integrity-attestation → ${out}`);
  console.log(`  claim: ${split} ${resolved}/${n} = ${resolve_pct}% (Wilson ${wilson_ci?.[0]}–${wilson_ci?.[1]}%), gold-oracle=official-docker`);
  console.log(`  empty_patch_rate: ${att.empty_patch_rate != null ? (att.empty_patch_rate * 100).toFixed(1) + '%' : 'skip'}   cost: ${att.cost.source}   witness: ${att.signature.witness_sha256.slice(0, 16)}…`);
  console.log('  per-vector:');
  for (const v of att.vectors) console.log(`    ${v.result.toUpperCase().padEnd(16)} ${v.vector}${v.harness_gap ? '  [gap]' : ''}`);
  console.log(`  summary: ${JSON.stringify(att.summary)}`);
  const hasFail = att.vectors.some((v) => v.result === 'fail');
  if (hasFail) console.log('  VERDICT: FAIL — a vector failed; this number is NOT a credible SOTA claim.');
  else console.log('  VERDICT: attestation emitted (skips are honest gaps, not passes). Sign witness_sha256 to make it a SOTA-eligible claim.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
