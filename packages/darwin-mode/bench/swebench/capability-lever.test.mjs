// $0 unit tests for the STRUCTURAL capability lever (ADR-236 §6). No network, no repos, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesToFlags, CAPABILITY_ALLOWLIST, CAPABILITY_LEVER, makeCliSolver } from './swebench-solver-cli.mjs';
import { makeSwebenchProposer } from './flywheel-swebench-evaluator.mjs';

test('capabilitiesToFlags: allowlisted tokens → their flags, deduped, order-stable', () => {
  assert.deepEqual(capabilitiesToFlags('repro-gate reviewer'), ['--repro-gate', '--reviewer']);
  assert.deepEqual(capabilitiesToFlags('reviewer repro-gate'), ['--reviewer', '--repro-gate']); // order preserved
  assert.deepEqual(capabilitiesToFlags('reviewer, reviewer'), ['--reviewer']);                   // deduped
  assert.deepEqual(capabilitiesToFlags('  REPRO-GATE  '), ['--repro-gate']);                     // case/space tolerant
});

test('capabilitiesToFlags: empty/garbage ⇒ [] (solver runs at its default)', () => {
  for (const v of ['', '   ', undefined, null, 'nope', 'localize']) assert.deepEqual(capabilitiesToFlags(v), []);
});

test('capabilitiesToFlags: injection-safe — only EXACT allowlist tokens survive; everything else dropped', () => {
  // A malicious/hallucinated proposer value can never become arbitrary argv. Two layers of safety:
  //   (1) every token is looked up in the allowlist — non-matches are dropped;
  //   (2) matches map to a KNOWN flag string (spawnSync uses an argv array, so no shell interpretation).
  assert.deepEqual(capabilitiesToFlags('repro-gate; rm -rf / --dangerous'), []); // 'repro-gate;' ≠ 'repro-gate' → fail-closed
  assert.deepEqual(capabilitiesToFlags('reviewer && rm -rf /'), ['--reviewer']); // clean token extracted, junk dropped
  assert.deepEqual(capabilitiesToFlags('$(whoami) reviewer'), ['--reviewer']);   // '$(whoami)' is its own token → dropped
  assert.deepEqual(capabilitiesToFlags('--repro-gate'), []);                     // the flag form is NOT an allowlist token
  assert.deepEqual(Object.values(CAPABILITY_ALLOWLIST), ['--repro-gate', '--reviewer']);
});

test('makeCliSolver: the capability lever maps to flags and is EXCLUDED from the prose system prompt', async () => {
  let sawPolicy = null, sawFlags = null;
  // A stub solve script that records its argv flags + the SWE_POLICY_SYSTEM it received, then writes an
  // empty prediction so the plumbing completes. We spy via a custom policyToSystem + reading argv here.
  const spyPolicyToSystem = (p) => { sawPolicy = p; return Object.values(p).filter(Boolean).join('\n'); };
  // Use a tiny inline stub script that echoes its capability flags into the report.
  const runSolver = makeCliSolver({
    solveScript: new URL('./_stub-capflags.mjs', import.meta.url).pathname,
    apiKeyEnv: 'NONE', policyToSystem: spyPolicyToSystem,
  });
  const out = await runSolver({ editPolicy: 'be concise', solverCapabilities: 'reviewer repro-gate' }, [{ instance_id: 'x' }]);
  // The prose system prompt saw editPolicy but NOT the structural lever
  assert.ok(sawPolicy && 'editPolicy' in sawPolicy, 'prose lever present');
  assert.ok(!(CAPABILITY_LEVER in sawPolicy), 'structural lever excluded from the prose system prompt');
  // The stub echoed the flags it actually received on argv
  sawFlags = out[0]?.model_patch; // the stub writes the received flags as the patch text
  assert.equal(sawFlags, '--reviewer --repro-gate', 'allowlisted flags reached the solver argv in order');
});

test('proposer: the capability lever proposes only MENU tokens (free-text/garbage filtered out)', async () => {
  const complete = async () => 'reviewer  banana   repro-gate reviewer\nplease enable everything';
  const propose = makeSwebenchProposer({ complete, proposerModel: 'mock' });
  const picked = await propose({ policy: { solverCapabilities: '' } }, CAPABILITY_LEVER);
  assert.equal(picked, 'reviewer repro-gate'); // only menu tokens, deduped, order-stable — no 'banana'/prose
});

test('proposer: a prose lever is unchanged by the capability branch', async () => {
  const complete = async () => 'always emit a minimal search/replace edit';
  const propose = makeSwebenchProposer({ complete, proposerModel: 'mock' });
  const text = await propose({ policy: { editPolicy: '' } }, 'editPolicy');
  assert.equal(text, 'always emit a minimal search/replace edit');
});
