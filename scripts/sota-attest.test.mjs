#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Pure-function tests for sota-attest.mjs (ADR-231). NO network / NO Docker / NO git.
// Run: node scripts/sota-attest.test.mjs
import assert from 'node:assert';
import {
  wilson, deriveSplit, datasetForSplit, emptyPatchRate, isOfficialGoldReport,
  vectorAudit, canonicalize, witnessHash, buildAttestation,
} from './sota-attest.mjs';

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

console.log(`\n${pass} passed`);
