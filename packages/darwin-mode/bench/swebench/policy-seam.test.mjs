// $0 node:test — the flywheel OPERATING-POLICY seam (applyPolicySystem), shared by solve.mjs
// (single-shot) and solve-agentic.mjs (multi-shot). Proves: (1) no policy ⇒ base returned
// byte-identical (backward-safe); (2) a policy is appended on a fresh line; (3) blank/whitespace
// policy is treated as no policy; (4) the env-var default is honored. This is what lets the D1
// flywheel evolve HOW either solver operates — the precondition for a D1 positive-path run.
import { test } from 'node:test';
import assert from 'node:assert';
import { applyPolicySystem } from './agentic-loop.mjs';

test('no policy ⇒ base is returned byte-identical (backward-safe)', () => {
  const base = 'SYSTEM PROMPT BASE';
  assert.strictEqual(applyPolicySystem(base, undefined), base);
  assert.strictEqual(applyPolicySystem(base, ''), base);
  assert.strictEqual(applyPolicySystem(base, '   \n  '), base); // whitespace-only ⇒ no policy
});

test('a policy is appended on a fresh line', () => {
  assert.strictEqual(applyPolicySystem('BASE', 'prefer minimal edits'), 'BASE\nprefer minimal edits');
});

test('policy is trimmed before appending', () => {
  assert.strictEqual(applyPolicySystem('BASE', '  run tests first  '), 'BASE\nrun tests first');
});

test('defaults to SWE_POLICY_SYSTEM env (the seam the flywheel runSolver sets)', () => {
  const prev = process.env.SWE_POLICY_SYSTEM;
  try {
    process.env.SWE_POLICY_SYSTEM = 'escalate on repeated failure';
    assert.strictEqual(applyPolicySystem('BASE'), 'BASE\nescalate on repeated failure');
    delete process.env.SWE_POLICY_SYSTEM;
    assert.strictEqual(applyPolicySystem('BASE'), 'BASE'); // unset ⇒ identical
  } finally {
    if (prev === undefined) delete process.env.SWE_POLICY_SYSTEM;
    else process.env.SWE_POLICY_SYSTEM = prev;
  }
});
