#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Tests the ADR-231 integrity gate wiring in nightly-sota-review.mjs against the REAL committed reports.
// Fail-closed on the gold-only Verified-500 (unprovable cost/conformance); opens on a full conformant triple.
// NO network / NO GCP / NO Docker — pure attestation path. Run: node scripts/nightly-sota-gate.test.mjs
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIntegrityGate, attestationSection } from './nightly-sota-review.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SW = join(__dirname, '..', 'packages/darwin-mode/bench/swebench');

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

console.log('nightly-sota-review.mjs integrity-gate tests (real committed reports):');

t('gold-only Verified-500 → FAIL-CLOSED (cost/conformance unprovable, 6 skips)', () => {
  const g = runIntegrityGate({ goldPath: join(SW, 'darwin-agentic.verified-500-cascade-local.json'), maxSkips: 4 });
  assert.ok(g, 'gold report loads');
  assert.equal(g.gate.open, false, 'gold-only must not open a SOTA issue/PR');
  assert.equal(g.att.summary.skip, 6);
  assert.equal(g.att.run.resolved, 278);
});

t('full conformant triple (mcts-pilot25 gold+solver+predictions) → OPEN', () => {
  const g = runIntegrityGate({
    goldPath: join(SW, 'mcts-pilot25-eval-report.json'),
    solverPath: join(SW, 'solve-mcts-pilot25.json'),
    predictionsPath: join(SW, 'predictions-mcts-pilot25.jsonl'),
    maxSkips: 4,
  });
  assert.ok(g);
  assert.equal(g.gate.open, true, 'clean conformant triple opens');
  assert.equal(g.gate.criticalFails.length, 0);
  assert.ok(g.att.summary.pass >= 4, `expected ≥4 pass, got ${g.att.summary.pass}`);
  assert.equal(g.att.patches_linted, 25, 'all 25 predictions linted');
  const pt = g.att.vectors.find((v) => v.vector === 'patch_touches_tests');
  assert.equal(pt.result, 'pass');
  assert.equal(pt.critical, true);
});

t('a missing gold report → fail-closed (null gate)', () => {
  assert.equal(runIntegrityGate({ goldPath: join(SW, 'does-not-exist.json') }), null);
});

t('attestationSection embeds the witness hash and a per-vector table row', () => {
  const g = runIntegrityGate({ goldPath: join(SW, 'mcts-pilot25-eval-report.json'), solverPath: join(SW, 'solve-mcts-pilot25.json'), predictionsPath: join(SW, 'predictions-mcts-pilot25.jsonl') });
  const md = attestationSection(g.att);
  assert.ok(md.includes(g.att.signature.witness_sha256), 'full witness hash embedded');
  assert.ok(md.includes('| `patch_touches_tests` |'), 'per-vector table row present');
  assert.ok(md.includes('Integrity attestation (ADR-231)'));
});

console.log(`\n${pass} passed`);
