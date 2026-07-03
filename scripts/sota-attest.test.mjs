#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Pure-function tests for sota-attest.mjs (ADR-231). NO network / NO Docker / NO git.
// Run: node scripts/sota-attest.test.mjs
import assert from 'node:assert';
import {
  wilson, deriveSplit, datasetForSplit, emptyPatchRate, isOfficialGoldReport,
  vectorAudit, canonicalize, witnessHash, buildAttestation,
  isTestFile, parsePatchPaths, lintPatch, lintPredictions, parsePredictionsJsonl,
  signAttestation, verifyAttestation, integrityGateDecision,
} from './sota-attest.mjs';
import { randomBytes } from 'node:crypto';

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

// A real-shaped official gold report (mirrors darwin-agentic.verified-500-cascade-local.json schema).
const GOLD = {
  total_instances: 500, submitted_instances: 500, completed_instances: 500,
  resolved_instances: 278, unresolved_instances: 222, empty_patch_instances: 52, error_instances: 0,
  resolved_ids: new Array(278).fill('x'), empty_patch_ids: new Array(52).fill('y'), schema_version: 2,
};

console.log('sota-attest.mjs unit tests:');

t('wilson matches the published Verified CI (278/500 ≈ 51.2–59.9)', () => {
  const [lo, hi] = wilson(278, 500);
  assert(Math.abs(lo - 51.2) < 0.3, `lo ${lo}`);
  assert(Math.abs(hi - 59.9) < 0.3, `hi ${hi}`);
});

t('deriveSplit maps the two official denominators, else unknown', () => {
  assert.equal(deriveSplit(300), 'lite');
  assert.equal(deriveSplit(500), 'verified');
  assert.equal(deriveSplit(123), 'unknown');
});

t('datasetForSplit resolves the princeton-nlp names', () => {
  assert.equal(datasetForSplit('lite'), 'princeton-nlp/SWE-bench_Lite');
  assert.equal(datasetForSplit('verified'), 'princeton-nlp/SWE-bench_Verified');
});

t('emptyPatchRate = empty/total off the official report', () => {
  assert.equal(emptyPatchRate(GOLD), +(52 / 500).toFixed(4)); // 0.104
  assert.equal(emptyPatchRate({ total_instances: 0, empty_patch_instances: 0 }), null);
  assert.equal(emptyPatchRate({}), null);
});

t('isOfficialGoldReport fingerprints the schema (ids arrays)', () => {
  assert.equal(isOfficialGoldReport(GOLD), true);
  assert.equal(isOfficialGoldReport({ resolvedInLoop: 15, n: 25 }), false); // solver report ≠ gold report
});

// ── THE DISCIPLINE TEST: absent evidence must skip, NEVER pass ──
t('vectorAudit: gold-only → cost/k-sample/no-gold-in-loop SKIP (not pass), each with a harness_gap', () => {
  const v = vectorAudit(GOLD, null);
  const by = Object.fromEntries(v.map((x) => [x.vector, x]));
  assert.equal(by.cost_measured.result, 'skip', 'no solver report → cost must skip');
  assert.ok(by.cost_measured.harness_gap, 'skip carries a harness_gap');
  assert.equal(by.best_of_n_disclosure.result, 'skip', 'no k config → best-of-N must skip');
  assert.equal(by.no_gold_in_loop.result, 'skip', 'no conformant flag → no-gold-in-loop must skip');
  assert.equal(by.patch_touches_tests.result, 'skip', 'no patch-lint → skip (forward-contract gap)');
  // structural immunities are still asserted from the harness, independent of the solver report
  assert.equal(by.answer_db_leakage.result, 'immune');
  assert.equal(by.normalization_collision.result, 'immune');
  assert.equal(by.no_work_scores_a_pass.result, 'immune');
  // never a false pass anywhere without evidence
  assert.ok(!v.some((x) => x.result === 'pass' && x.vector === 'cost_measured'));
});

t('vectorAudit: with a conformant solver report, the relevant vectors upgrade off skip', () => {
  const solver = {
    leaderboardConformant: true, noTestOracle: false, cascade: true, escalateModel: 'anthropic/claude-opus-4.8',
    totalCost_usd: 137.4, blendedCostPerInst_usd: 0.27, modelParams: { temperature: 0, seed: 42 },
  };
  const by = Object.fromEntries(vectorAudit(GOLD, solver).map((x) => [x.vector, x]));
  assert.equal(by.cost_measured.result, 'pass', 'measured cost present → pass');
  assert.equal(by.empty_patch_rate_disclosed.result, 'pass');
  assert.equal(by.best_of_n_disclosure.result, 'pass', 'cascade/escalate config disclosed → pass');
  assert.equal(by.no_gold_in_loop.result, 'attested-by-flag', 'flag present but not machine-proven');
  assert.equal(by.reproducibility.result, 'pass', 'temperature present → reproducibility pass');
});

t('vectorAudit: a patch that edits tests is a FAIL, not a skip', () => {
  const solver = { patchLint: [{ touchesTests: true, deletesTests: false }] };
  const by = Object.fromEntries(vectorAudit(GOLD, solver).map((x) => [x.vector, x]));
  assert.equal(by.patch_touches_tests.result, 'fail');
});

t('canonicalize is deterministic under key reordering', () => {
  assert.equal(canonicalize({ b: 1, a: [3, { y: 2, x: 1 }] }), canonicalize({ a: [3, { x: 1, y: 2 }] , b: 1 }));
});

t('witnessHash is stable for equal bodies, changes when a field changes', () => {
  const a = witnessHash({ run: { resolved: 278 }, x: 1 });
  const b = witnessHash({ x: 1, run: { resolved: 278 } });
  assert.equal(a, b, 'order-independent');
  assert.notEqual(a, witnessHash({ run: { resolved: 279 }, x: 1 }), 'tamper changes hash');
});

t('buildAttestation binds gold+solver and NEVER emits a real signature (sig=null)', () => {
  const att = buildAttestation(GOLD, null, { now: '2026-07-03T00:00:00Z', harnessVersion: 'testsha' });
  assert.equal(att.run.split, 'verified');
  assert.equal(att.run.resolved, 278);
  assert.equal(att.run.resolve_pct, 55.6);
  assert.equal(att.empty_patch_rate, 0.104);
  assert.equal(att.cost.source, 'skip');
  assert.equal(att.signature.sig, null, 'no fabricated signature');
  assert.ok(att.signature.witness_sha256.length === 64, 'sha256 hex witness present');
  assert.ok(att.summary.skip >= 1 && att.summary.immune >= 3, 'summary tallies results');
});

// ── patch_touches_tests: the CRITICAL grader-sabotage vector, off predictions.jsonl ──
t('isTestFile flags test conventions, not source', () => {
  for (const p of ['django/tests/foo/test_x.py', 'src/conftest.py', 'a/b/mymod_test.py', 'pkg/test/helpers.py', 'test_utils.py'])
    assert.equal(isTestFile(p), true, p);
  for (const p of ['django/forms/boundfield.py', 'src/testing/util.py', 'requests/models.py', '/dev/null'])
    assert.equal(isTestFile(p), false, p);
});

t('parsePatchPaths extracts touched + deleted files from a unified diff', () => {
  const patch = 'diff --git a/tests/test_m.py b/tests/test_m.py\n--- a/tests/test_m.py\n+++ b/tests/test_m.py\n@@ -1 +1 @@\n-a\n+b\n';
  const { files } = parsePatchPaths(patch);
  assert.ok(files.has('tests/test_m.py'));
  const del = 'diff --git a/conftest.py b/conftest.py\ndeleted file mode 100644\n--- a/conftest.py\n+++ /dev/null\n';
  assert.ok(parsePatchPaths(del).deletedFiles.has('conftest.py'));
});

t('lintPatch: editing a test file → touchesTests; deleting → deletesTests; source-only → clean', () => {
  assert.equal(lintPatch('diff --git a/tests/test_x.py b/tests/test_x.py\n--- a/tests/test_x.py\n+++ b/tests/test_x.py\n@@ -1 +1 @@\n-x\n+y\n').touchesTests, true);
  assert.equal(lintPatch('diff --git a/conftest.py b/conftest.py\ndeleted file mode 100644\n--- a/conftest.py\n+++ /dev/null\n').deletesTests, true);
  assert.equal(lintPatch('diff --git a/pkg/mod.py b/pkg/mod.py\n--- a/pkg/mod.py\n+++ b/pkg/mod.py\n@@ -1 +1 @@\n-x\n+y\n').touchesTests, false);
});

t('vectorAudit + predictions: a RESOLVED instance whose patch edits tests → CRITICAL fail', () => {
  const preds = [{ instance_id: 'x', model_patch: 'diff --git a/tests/test_a.py b/tests/test_a.py\n--- a/tests/test_a.py\n+++ b/tests/test_a.py\n@@ -1 +1 @@\n-a\n+b\n' }];
  const gold = { ...GOLD, resolved_ids: ['x'] };
  const by = Object.fromEntries(vectorAudit(gold, null, preds).map((v) => [v.vector, v]));
  assert.equal(by.patch_touches_tests.result, 'fail');
  assert.equal(by.patch_touches_tests.critical, true);
});

t('vectorAudit + predictions: a test-edit on an UNRESOLVED instance is not a scored sabotage → pass', () => {
  const preds = [{ instance_id: 'not-resolved', model_patch: 'diff --git a/tests/test_a.py b/tests/test_a.py\n--- a/tests/test_a.py\n+++ b/tests/test_a.py\n@@ -1 +1 @@\n-a\n+b\n' }];
  const gold = { ...GOLD, resolved_ids: ['someone-else'] };
  assert.equal(Object.fromEntries(vectorAudit(gold, null, preds).map((v) => [v.vector, v])).patch_touches_tests.result, 'pass');
});

t('vectorAudit + clean predictions (source-only patches) → patch_touches_tests pass', () => {
  const preds = [{ instance_id: 'x', model_patch: 'diff --git a/pkg/mod.py b/pkg/mod.py\n--- a/pkg/mod.py\n+++ b/pkg/mod.py\n@@ -1 +1 @@\n-x\n+y\n' }];
  assert.equal(Object.fromEntries(vectorAudit(GOLD, null, preds).map((v) => [v.vector, v])).patch_touches_tests.result, 'pass');
});

t('vectorAudit reads the darwin `k` field for best_of_n disclosure (not only kSampleN)', () => {
  const by = Object.fromEntries(vectorAudit(GOLD, { k: 5, leaderboardConformant: true, totalCost_usd: 1 }).map((v) => [v.vector, v]));
  assert.equal(by.best_of_n_disclosure.result, 'pass');
});

t('parsePredictionsJsonl parses lines, skips blanks/garbage', () => {
  const arr = parsePredictionsJsonl('{"instance_id":"a"}\n\n{bad}\n{"instance_id":"b"}\n');
  assert.deepEqual(arr.map((x) => x.instance_id), ['a', 'b']);
});

// ── Ed25519 signing (ADR-103) ──
t('signAttestation → verifyAttestation round-trips; tampering the body fails verification', () => {
  const seed = randomBytes(32);
  const att = buildAttestation(GOLD, null, { now: '2026-07-03T00:00:00Z', harnessVersion: 'testsha' });
  const signed = signAttestation(att, seed);
  assert.equal(signed.signature.sig.length, 128, '128-hex ed25519 signature');
  assert.equal(signed.signature.pubkey.length, 64, '64-hex ed25519 pubkey');
  assert.equal(verifyAttestation(signed).valid, true, 'clean signed attestation verifies');
  const tampered = JSON.parse(JSON.stringify(signed));
  tampered.run.resolved = 279; // change the claim
  const r = verifyAttestation(tampered);
  assert.equal(r.valid, false, 'tampered body fails');
  assert.equal(r.witnessMatch, false, 'witness mismatch pinpoints the tamper');
});

t('verifyAttestation: a flipped signature byte fails the Ed25519 check even if witness matches', () => {
  const signed = signAttestation(buildAttestation(GOLD, null, { now: 'x', harnessVersion: 'y' }), randomBytes(32));
  const bad = JSON.parse(JSON.stringify(signed));
  bad.signature.sig = (bad.signature.sig[0] === '0' ? '1' : '0') + bad.signature.sig.slice(1);
  const r = verifyAttestation(bad);
  assert.equal(r.valid, false);
  assert.equal(r.witnessMatch, true, 'witness still matches (body untouched)');
  assert.equal(r.sigValid, false, 'but the signature no longer verifies');
});

t('buildAttestation still emits sig=null (never fabricated); signing is an explicit opt-in step', () => {
  assert.equal(buildAttestation(GOLD, null, { now: 'x', harnessVersion: 'y' }).signature.sig, null);
});

// ── fail-closed gate decision ──
t('integrityGateDecision: clean attestation (0 fails, few skips) → OPEN', () => {
  const solver = { leaderboardConformant: true, noTestOracle: true, cascade: true, escalateModel: 'm', totalCost_usd: 1, modelParams: { temperature: 0, seed: 42 } };
  const preds = [{ instance_id: 'x', model_patch: 'diff --git a/pkg/m.py b/pkg/m.py\n--- a/pkg/m.py\n+++ b/pkg/m.py\n@@ -1 +1 @@\n-x\n+y\n' }];
  const att = buildAttestation(GOLD, solver, { now: 'x', harnessVersion: 'y', predictions: preds });
  assert.equal(integrityGateDecision(att).open, true);
});

t('integrityGateDecision: a CRITICAL fail (patch edits a resolved test) → FAIL-CLOSED', () => {
  const gold = { ...GOLD, resolved_ids: ['x'] };
  const preds = [{ instance_id: 'x', model_patch: 'diff --git a/tests/test_a.py b/tests/test_a.py\n--- a/tests/test_a.py\n+++ b/tests/test_a.py\n@@ -1 +1 @@\n-a\n+b\n' }];
  const att = buildAttestation(gold, { leaderboardConformant: true, totalCost_usd: 1, cascade: true }, { now: 'x', harnessVersion: 'y', predictions: preds });
  const g = integrityGateDecision(att);
  assert.equal(g.open, false, 'critical fail blocks');
  assert.ok(g.criticalFails.includes('patch_touches_tests'));
});

t('integrityGateDecision: gold-only (6 skips) exceeds the skip budget → FAIL-CLOSED', () => {
  const att = buildAttestation(GOLD, null, { now: 'x', harnessVersion: 'y' });
  assert.equal(integrityGateDecision(att, { maxSkips: 4 }).open, false);
});

console.log(`\n${pass} passed`);
