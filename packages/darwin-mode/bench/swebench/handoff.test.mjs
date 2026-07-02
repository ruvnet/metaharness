// SPDX-License-Identifier: MIT
//
// ADR-205 unit tests — escalation rules, receipt schema, chain traversal, and the claude -p
// subprocess seam. All mocked: $0, no network, no git, no real `claude` calls.
// Run: node --test handoff.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  solveViaClaudeP, buildHandoffEnv, buildHandoffPrompt, readAuthToken,
  parseEscalateChain, resolveSolverSpec, acceptHop, runEscalationChain, pickChainPatch,
  escalationSignals, shouldEscalate, evaluateEscalation, diffStats, buildReceipt, testFailureRepeats,
  OR_ANTHROPIC_BASE_URL, DEFAULT_HANDOFF_MODEL, SOLVER_ALIASES,
} from './handoff-solver.mjs';
import { agenticSolveNative } from './agentic-loop.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIFF_1FILE = 'diff --git a/src/a.py b/src/a.py\n--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1 @@\n-x\n+y\n';
const diffN = (n) => Array.from({ length: n }, (_, i) => `diff --git a/f${i}.py b/f${i}.py\n--- a/f${i}.py\n+++ b/f${i}.py\n@@ -1 +1 @@\n-x\n+y${i}\n`).join('');

// ── 2-of-N escalation rules ──────────────────────────────────────────────────────────────────────
test('escalationSignals: all five signals computed from loop-tracked facts', () => {
  const s = escalationSignals({ resolvedInLoop: false, submitted: false, thrash: 3, patch: diffN(5) });
  assert.deepEqual(s, { tests_failed: true, empty_patch: false, no_submit: true, thrash_repeat: true, too_many_files: true });
  const clean = escalationSignals({ resolvedInLoop: true, submitted: true, thrash: 0, patch: DIFF_1FILE });
  assert.deepEqual(clean, { tests_failed: false, empty_patch: false, no_submit: false, thrash_repeat: false, too_many_files: false });
});

test('shouldEscalate: 2-of-N — 0 or 1 signal does NOT fire, 2+ fires', () => {
  // 0 signals: darwin solved it cleanly — never escalate.
  assert.equal(shouldEscalate(escalationSignals({ resolvedInLoop: true, submitted: true, thrash: 0, patch: DIFF_1FILE })).escalate, false);
  // 1 signal (tests failed but submitted a tight non-empty patch, no thrash): does not fire.
  const one = shouldEscalate(escalationSignals({ resolvedInLoop: false, submitted: true, thrash: 0, patch: DIFF_1FILE }));
  assert.equal(one.escalate, false);
  assert.deepEqual(one.reasons, ['tests_failed']);
  // 2 signals (tests failed + never submitted): fires.
  const two = shouldEscalate(escalationSignals({ resolvedInLoop: false, submitted: false, thrash: 0, patch: DIFF_1FILE }));
  assert.equal(two.escalate, true);
  assert.deepEqual(two.reasons, ['tests_failed', 'no_submit']);
  // Empty patch + budget exhaustion (the hard-25 darwin signature): fires with 3 reasons.
  const hard = shouldEscalate(escalationSignals({ resolvedInLoop: false, submitted: false, thrash: 0, patch: '' }));
  assert.equal(hard.escalate, true);
  assert.deepEqual(hard.reasons, ['tests_failed', 'empty_patch', 'no_submit']);
  // Passing tests but sprawling >3-file patch + thrash: fires (low-confidence shape).
  const sprawl = shouldEscalate(escalationSignals({ resolvedInLoop: true, submitted: true, thrash: 2, patch: diffN(4) }));
  assert.equal(sprawl.escalate, true);
  assert.deepEqual(sprawl.reasons, ['thrash_repeat', 'too_many_files']);
});

test('evaluateEscalation: policy selector — two-of-n (production) vs aggressive (hard-slice proof)', () => {
  // Confident-but-wrong submit: darwin SUBMITTED a tight non-empty patch, tests just failed.
  // Only 1 signal fires. two-of-n KEEPS it (measures darwin's ceiling); aggressive escalates it.
  const confidentWrong = escalationSignals({ resolvedInLoop: false, submitted: true, thrash: 0, patch: DIFF_1FILE });
  assert.equal(evaluateEscalation(confidentWrong, 'two-of-n').escalate, false);
  const agg = evaluateEscalation(confidentWrong, 'aggressive');
  assert.equal(agg.escalate, true, 'aggressive escalates every darwin miss');
  assert.deepEqual(agg.reasons, ['tests_failed'], 'reasons stay the full firing set regardless of policy');
  // darwin RESOLVED in-loop with a clean patch: neither policy escalates (not a miss).
  const solved = escalationSignals({ resolvedInLoop: true, submitted: true, thrash: 0, patch: DIFF_1FILE });
  assert.equal(evaluateEscalation(solved, 'aggressive').escalate, false, 'aggressive still keeps genuine resolves');
  assert.equal(evaluateEscalation(solved, 'two-of-n').escalate, false);
  // Empty patch alone: aggressive escalates (empty_patch), two-of-n does not (1 signal only if submitted).
  const emptyOnly = escalationSignals({ resolvedInLoop: false, submitted: true, thrash: 0, patch: '' }); // tests_failed + empty_patch = 2 → both escalate
  assert.equal(evaluateEscalation(emptyOnly, 'two-of-n').escalate, true);
  assert.equal(evaluateEscalation(emptyOnly, 'aggressive').escalate, true);
  // default policy is two-of-n; unknown policy throws.
  assert.equal(evaluateEscalation(confidentWrong).escalate, false);
  assert.throws(() => evaluateEscalation(confidentWrong, 'yolo'), /unknown escalate-policy/);
});

test('testFailureRepeats: same run_tests failure signature ≥2 fires the thrash signal', () => {
  const fail = { actionRaw: '{"tool":"run_tests"}', obs: 'FAIL tests/test_a.py::test_x — AssertionError\nlogs at /tmp/agentic-run_1.jsonl' };
  const fail2 = { actionRaw: '{"tool":"run_tests"}', obs: 'FAIL tests/test_a.py::test_x — AssertionError\nlogs at /tmp/agentic-run_2.jsonl' }; // same sig, different /tmp path
  const pass = { actionRaw: '{"tool":"run_tests"}', obs: 'ALL TARGET TESTS PASS' };
  const nav = { actionRaw: '{"tool":"read","path":"a.py"}', obs: 'FAIL FAIL FAIL' }; // not a run_tests row
  assert.equal(testFailureRepeats([]), 0);
  assert.equal(testFailureRepeats(undefined), 0);
  assert.equal(testFailureRepeats([fail, nav, pass]), 1);
  assert.equal(testFailureRepeats([fail, fail2]), 2); // normalized: /tmp run-id path is volatile
  const differentFail = { actionRaw: '{"tool":"run_tests"}', obs: 'FAIL tests/test_b.py::test_y — TypeError' };
  assert.equal(testFailureRepeats([fail, differentFail]), 1); // progress (new failure) is NOT thrash
  // Wired into the signals: submitted non-empty patch + repeated failure sig ⇒ 2 signals ⇒ escalate.
  const sig = escalationSignals({ resolvedInLoop: false, submitted: true, thrash: 0, transcript: [fail, fail2], patch: DIFF_1FILE });
  assert.equal(sig.thrash_repeat, true);
  assert.equal(shouldEscalate(sig).escalate, true);
});

test('diffStats: files deduped, bytes counted, empty-safe', () => {
  assert.deepEqual(diffStats(''), { files: [], bytes: 0 });
  const d = diffStats(DIFF_1FILE + DIFF_1FILE); // same file twice → 1 unique
  assert.deepEqual(d.files, ['src/a.py']);
  assert.equal(diffStats(diffN(4)).files.length, 4);
  assert.equal(diffStats('x').bytes, 1);
});

// ── receipt schema ───────────────────────────────────────────────────────────────────────────────
const RECEIPT_FIELDS = ['instance_id', 'initial_solver', 'escalate_policy', 'darwin_cost_usd', 'darwin_steps', 'failure_reasons', 'escalated', 'escalation_reasons', 'handoff_solver', 'handoff_cost_usd', 'handoff_latency_ms', 'final_patch_nonempty', 'diff_files', 'diff_bytes', 'ts'];

test('buildReceipt: escalated row carries every spec field with real values', () => {
  const signals = escalationSignals({ resolvedInLoop: false, submitted: false, thrash: 0, patch: '' });
  const r = buildReceipt({
    instanceId: 'django__django-11099', initialSolver: 'darwin-deepseek-chat',
    darwinCostUsd: 0.0312, darwinSteps: 15, signals, escalated: true,
    escalationReasons: ['tests_failed', 'empty_patch', 'no_submit'],
    handoff: { solver: 'claude-p-fable', status: 'resolved', cost_usd: 1.25, latency_ms: 210_000, turns: 31, error: '' },
    finalPatch: DIFF_1FILE, escalatePolicy: 'aggressive', now: () => 1750000000000,
  });
  for (const f of RECEIPT_FIELDS) assert.ok(f in r, `missing receipt field: ${f}`);
  assert.equal(r.instance_id, 'django__django-11099');
  assert.equal(r.initial_solver, 'darwin-deepseek-chat');
  assert.equal(r.escalate_policy, 'aggressive');
  assert.equal(r.darwin_cost_usd, 0.0312);
  assert.equal(r.darwin_steps, 15);
  assert.deepEqual(r.failure_reasons, ['tests_failed', 'empty_patch', 'no_submit']);
  assert.equal(r.escalated, true);
  assert.equal(r.handoff_solver, 'claude-p-fable');
  assert.equal(r.handoff_cost_usd, 1.25);
  assert.equal(r.handoff_latency_ms, 210_000);
  assert.equal(r.final_patch_nonempty, true);
  assert.equal(r.diff_files, 1);
  assert.ok(r.diff_bytes > 0);
  assert.equal(r.ts, new Date(1750000000000).toISOString());
});

test('buildReceipt: non-escalated row keeps handoff_* null (the other training class)', () => {
  const signals = escalationSignals({ resolvedInLoop: true, submitted: true, thrash: 0, patch: DIFF_1FILE });
  const r = buildReceipt({ instanceId: 'x', initialSolver: 'darwin-deepseek-chat', darwinCostUsd: 0.01, darwinSteps: 6, signals, escalated: false, escalationReasons: [], handoff: null, finalPatch: DIFF_1FILE });
  for (const f of RECEIPT_FIELDS) assert.ok(f in r, `missing receipt field: ${f}`);
  assert.equal(r.escalated, false);
  assert.deepEqual(r.escalation_reasons, []);
  assert.deepEqual(r.failure_reasons, []);
  assert.equal(r.handoff_solver, null);
  assert.equal(r.handoff_cost_usd, null);
  assert.equal(r.handoff_latency_ms, null);
});

// ── chain parsing / registry ─────────────────────────────────────────────────────────────────────
test('parseEscalateChain: alias, generic forms, order preserved, unknown throws', () => {
  const single = parseEscalateChain('claude-p-fable');
  assert.equal(single.length, 1);
  assert.equal(single[0].kind, 'claude-p-model');
  assert.equal(single[0].model, DEFAULT_HANDOFF_MODEL);
  const chain = parseEscalateChain('darwin:z-ai/glm, claude-p:anthropic/claude-sonnet-5 ,claude-p-fable');
  assert.deepEqual(chain.map((s) => s.kind), ['darwin-model', 'claude-p-model', 'claude-p-model']);
  assert.deepEqual(chain.map((s) => s.model), ['z-ai/glm', 'anthropic/claude-sonnet-5', DEFAULT_HANDOFF_MODEL]);
  assert.throws(() => parseEscalateChain('gpt-magic'), /unknown solver/);
  assert.throws(() => parseEscalateChain(''), /empty chain/);
  assert.throws(() => parseEscalateChain('darwin:'), /unknown solver/);
  assert.equal(resolveSolverSpec('nope'), null);
  // Alias objects are copied, not shared.
  const a = resolveSolverSpec('claude-p-fable'); a.model = 'mutated';
  assert.equal(SOLVER_ALIASES['claude-p-fable'].model, DEFAULT_HANDOFF_MODEL);
});

test('acceptHop: non-empty patch + in-loop signal where reported', () => {
  assert.equal(acceptHop(null), false);
  assert.equal(acceptHop({ patch: '   ' }), false);
  assert.equal(acceptHop({ patch: DIFF_1FILE }), true);                          // claude-p rung: patch alone decides
  assert.equal(acceptHop({ patch: DIFF_1FILE, resolvedInLoop: false }), false);  // darwin rung: in-loop signal vetoes
  assert.equal(acceptHop({ patch: DIFF_1FILE, resolvedInLoop: true }), true);
});

// ── chain traversal (injected rung runners — no real solvers) ───────────────────────────────────
test('runEscalationChain: stops at first accepted rung; later rungs never run', async () => {
  const ran = [];
  const chain = parseEscalateChain('darwin:cheap/one,claude-p:anthropic/mid,claude-p-fable');
  const hops = await runEscalationChain(chain, {
    runDarwinHop: async (spec) => { ran.push(spec.name); return { status: 'failed', patch: '', cost_usd: 0.02, turns: 15, resolvedInLoop: false }; },
    runClaudeP: async (spec) => { ran.push(spec.name); return { status: 'resolved', patch: DIFF_1FILE, cost_usd: 0.9, turns: 20 }; },
  });
  assert.deepEqual(ran, ['darwin:cheap/one', 'claude-p:anthropic/mid']); // fable rung never launched
  assert.equal(hops.length, 2);
  assert.equal(acceptHop(hops[1].result), true);
  const pick = pickChainPatch(hops);
  assert.equal(pick.accepted, true);
  assert.equal(pick.hop.spec.name, 'claude-p:anthropic/mid');
});

test('runEscalationChain: failed rung feeds priorAttempts to the next rung', async () => {
  const seenPrior = [];
  const chain = parseEscalateChain('darwin:cheap/one,claude-p-fable');
  await runEscalationChain(chain, {
    priorAttempts: [{ solver: 'darwin-deepseek-chat', failureReasons: ['tests_failed', 'empty_patch'], steps: 15 }],
    runDarwinHop: async (spec, prior) => { seenPrior.push(prior.map((p) => p.solver)); return { status: 'failed', patch: '', turns: 15, resolvedInLoop: false }; },
    runClaudeP: async (spec, prior) => { seenPrior.push(prior.map((p) => p.solver)); return { status: 'resolved', patch: DIFF_1FILE }; },
  });
  assert.deepEqual(seenPrior[0], ['darwin-deepseek-chat']);
  assert.deepEqual(seenPrior[1], ['darwin-deepseek-chat', 'darwin:cheap/one']);
});

test('runEscalationChain: budget gate blocks BEFORE launching a rung; rung errors degrade to failed hops', async () => {
  const chain = parseEscalateChain('claude-p-fable,claude-p:anthropic/other');
  let launched = 0;
  const hops = await runEscalationChain(chain, {
    overBudget: () => true,
    runClaudeP: async () => { launched++; return { status: 'resolved', patch: DIFF_1FILE }; },
  });
  assert.equal(launched, 0);
  assert.equal(hops.length, 1);
  assert.equal(hops[0].skipped, 'budget');
  assert.equal(hops[0].result, null);
  assert.equal(pickChainPatch(hops), null); // nothing usable → caller keeps darwin's patch

  const hops2 = await runEscalationChain(parseEscalateChain('claude-p-fable'), {
    runClaudeP: async () => { throw new Error('subprocess exploded'); },
  });
  assert.equal(hops2[0].result.status, 'failed');
  assert.match(hops2[0].result.error, /subprocess exploded/);
});

test('pickChainPatch fallback: no accepted rung → last non-empty patch wins', () => {
  const chain = parseEscalateChain('darwin:a/b,darwin:c/d');
  const hops = [
    { spec: chain[0], result: { patch: DIFF_1FILE, resolvedInLoop: false } }, // non-empty but vetoed
    { spec: chain[1], result: { patch: '', resolvedInLoop: false } },
  ];
  const pick = pickChainPatch(hops);
  assert.equal(pick.accepted, false);
  assert.equal(pick.hop.spec.name, 'darwin:a/b');
});

// ── claude -p subprocess seam (injected exec — no real claude, no network) ──────────────────────
function mkExecMock({ claudeOut = JSON.stringify({ result: '', total_cost_usd: 1.31, num_turns: 27 }), diff = DIFF_1FILE, claudeThrows = null } = {}) {
  const calls = [];
  return {
    calls,
    exec: async (cmd, opts = {}) => {
      calls.push({ cmd, opts });
      if (cmd.startsWith('claude -p')) { if (claudeThrows) throw claudeThrows; return claudeOut; }
      if (cmd === 'git diff') return diff;
      return '';
    },
  };
}

test('solveViaClaudeP: OR env + no --model flag + patch from git diff (not the JSON result field)', async () => {
  const m = mkExecMock();
  const r = await solveViaClaudeP({
    instanceId: 'astropy__astropy-12907', repo: 'astropy/astropy', baseCommit: 'abc123',
    problemStatement: 'Modeling separability broken', maxTurns: 33, timeoutMs: 5000,
    priorAttempts: [{ solver: 'darwin-deepseek-chat', failureReasons: ['tests_failed', 'empty_patch'], steps: 15 }],
  }, { exec: m.exec, fetchRepo: async () => '/fake/work', authToken: 'sk-or-TEST' });

  const claudeCall = m.calls.find((c) => c.cmd.startsWith('claude -p'));
  assert.ok(claudeCall, 'claude -p was invoked');
  assert.match(claudeCall.cmd, /--max-turns 33/);
  assert.match(claudeCall.cmd, /--dangerously-skip-permissions/);
  assert.match(claudeCall.cmd, /--output-format json/);
  assert.ok(!/--model\s/.test(claudeCall.cmd), 'NO --model flag — ANTHROPIC_MODEL owns selection on a custom endpoint');
  assert.equal(claudeCall.opts.env.ANTHROPIC_BASE_URL, OR_ANTHROPIC_BASE_URL);
  assert.equal(claudeCall.opts.env.ANTHROPIC_AUTH_TOKEN, 'sk-or-TEST');
  assert.equal(claudeCall.opts.env.ANTHROPIC_MODEL, DEFAULT_HANDOFF_MODEL);
  assert.equal(claudeCall.opts.cwd, '/fake/work');
  assert.equal(claudeCall.opts.timeout, 5000);
  assert.match(claudeCall.cmd, /PRIOR ATTEMPTS/); // failed cheap attempt surfaced to the actuator
  assert.match(claudeCall.cmd, /Modeling separability broken/);

  assert.equal(r.status, 'resolved');       // 'resolved' == non-empty patch ONLY (gold-scored later)
  assert.equal(r.patch, DIFF_1FILE);        // from git diff, NOT the JSON result field
  assert.equal(r.cost_usd, 1.31);
  assert.equal(r.turns, 27);
  assert.equal(r.solver, 'claude-p-fable');
  assert.equal(r.error, '');
  assert.ok(r.latency_ms >= 0);
});

test('solveViaClaudeP: empty diff → failed; timeout salvages the diff; unparseable JSON keeps the patch', async () => {
  const empty = mkExecMock({ diff: '' });
  const r1 = await solveViaClaudeP({ repo: 'a/b', baseCommit: 'c' }, { exec: empty.exec, fetchRepo: async () => '/w' });
  assert.equal(r1.status, 'failed');
  assert.equal(r1.patch, '');

  const to = mkExecMock({ claudeThrows: Object.assign(new Error('Command timed out'), { killed: true }), diff: DIFF_1FILE });
  const r2 = await solveViaClaudeP({ repo: 'a/b', baseCommit: 'c' }, { exec: to.exec, fetchRepo: async () => '/w' });
  assert.equal(r2.status, 'resolved'); // salvaged non-empty diff after timeout
  assert.equal(r2.patch, DIFF_1FILE);
  assert.match(r2.error, /timed out/i);

  const toEmpty = mkExecMock({ claudeThrows: Object.assign(new Error('Command timed out'), { killed: true }), diff: '' });
  const r3 = await solveViaClaudeP({ repo: 'a/b', baseCommit: 'c' }, { exec: toEmpty.exec, fetchRepo: async () => '/w' });
  assert.equal(r3.status, 'timeout');

  const badJson = mkExecMock({ claudeOut: 'not json at all' });
  const r4 = await solveViaClaudeP({ repo: 'a/b', baseCommit: 'c' }, { exec: badJson.exec, fetchRepo: async () => '/w' });
  assert.equal(r4.status, 'resolved'); // JSON display quirk must never lose the patch
  assert.equal(r4.cost_usd, 0);
});

test('buildHandoffEnv/readAuthToken/buildHandoffPrompt: pure pieces', () => {
  const env = buildHandoffEnv('anthropic/claude-fable-5', 'tok', { PATH: '/bin' });
  assert.deepEqual(env, { PATH: '/bin', ANTHROPIC_BASE_URL: OR_ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'anthropic/claude-fable-5' });
  assert.equal(readAuthToken('explicit'), 'explicit');
  const p = buildHandoffPrompt('the issue');
  assert.ok(!p.includes('PRIOR ATTEMPTS'), 'no prior-attempts section when none');
  assert.match(p, /Do NOT edit test files/);
});

// ── the non-escalated path must stay byte-identical (static gating guard) ───────────────────────
// The runtime property "absent --escalate-to ⇒ identical output" can't be exercised without paid
// LLM calls, so guard it structurally: every ADR-205 side effect in solve-agentic.mjs (receipt
// writes, chain execution, receipt-file truncation) must be gated on HANDOFF_CHAIN, and
// HANDOFF_CHAIN must be null when --escalate-to is absent.
test('solve-agentic gating: all handoff side effects require --escalate-to', () => {
  const src = readFileSync(join(HERE, 'solve-agentic.mjs'), 'utf8');
  assert.match(src, /const HANDOFF_CHAIN = ESCALATE_TO \? parseEscalateChain\(ESCALATE_TO\) : null;/);
  assert.match(src, /if \(HANDOFF_CHAIN\) writeFileSync\(RECEIPTS, ''\);/);
  assert.match(src, /if \(HANDOFF_CHAIN && t1res\) \{/);
  // Every receipts write sits inside the HANDOFF_CHAIN-gated block: no RECEIPTS append may appear
  // before the gate. Check by ensuring all appendFileSync(RECEIPTS…) occurrences come after the gate.
  const gateIdx = src.indexOf('if (HANDOFF_CHAIN && t1res) {');
  let idx = src.indexOf('appendFileSync(RECEIPTS');
  assert.ok(idx > gateIdx, 'receipt writes only inside the gated block');
  while (idx !== -1) { assert.ok(idx > gateIdx); idx = src.indexOf('appendFileSync(RECEIPTS', idx + 1); }
  // The chain executor is only reachable from the gated block.
  assert.equal(src.split('runChainFor(').length, 3, 'one definition + one gated call site');
  // Perf pass gating: every claude -p rung goes through the concurrency semaphore, and
  // --early-escalate is opt-in (defaults off ⇒ benchmark arms measure the spec'd behaviour).
  assert.match(src, /withHandoffSlot\(\(\) => solveViaClaudeP\(/);
  assert.match(src, /const EARLY_ESCALATE = args\.includes\('--early-escalate'\);/);
  // Escalation policy: default is the production two-of-n cost-saver; the decision goes through
  // evaluateEscalation(signals, ESCALATE_POLICY) so --escalate-policy aggressive is honoured.
  assert.match(src, /const ESCALATE_POLICY = argv\('--escalate-policy', 'two-of-n'\);/);
  assert.match(src, /evaluateEscalation\(signals, ESCALATE_POLICY\)/);
  assert.match(src, /if \(HANDOFF_CHAIN && EARLY_ESCALATE\)/);
});

// ── --early-escalate: onStep 'stop' aborts the loop's remaining budget ──────────────────────────
test("agenticSolveNative: onStep returning 'stop' aborts at half budget when no edit was attempted", async () => {
  // A model that only ever greps — the unrecoverable all-exploration signature.
  const llm = async (messages) => ({
    message: { content: null, tool_calls: [{ id: `c${messages.length}`, function: { name: 'grep', arguments: JSON.stringify({ pattern: `p${messages.length}` }) } }] },
    cost: 0.001,
  });
  const io = {
    work: '/repo', path: { join }, MAX_OUT: 4000,
    readFile: () => '', listDir: () => [], writeFile: () => {}, exists: () => false,
    gitDiff: () => '', grepRepo: () => 'no matches', applyEdit: () => null, isTestPath: () => false,
    runTests: () => ({ resolved: false, logTail: 'FAIL' }),
  };
  const maxSteps = 10;
  let edited = false;
  const onStep = (step, action) => {
    if (action.tool === 'edit' || action.tool === 'line_edit') edited = true;
    if (!edited && step >= Math.ceil(maxSteps / 2)) return 'stop';
  };
  const res = await agenticSolveNative({ problem: 'bug', io, llm, maxSteps, onStep });
  assert.equal(res.steps, Math.ceil(maxSteps / 2)); // aborted at half budget, not 10
  assert.equal(res.submitted, false);
  assert.equal(res.patch, '');
  // …which is exactly the 2-of-N escalation signature (tests_failed + empty_patch + no_submit).
  const { escalate } = shouldEscalate(escalationSignals({ resolvedInLoop: res.resolvedInLoop, submitted: res.submitted, thrash: res.thrash, patch: res.patch }));
  assert.equal(escalate, true);
});

test('agenticSolveNative: plain onStep (undefined return) leaves the loop untouched', async () => {
  const llm = async (messages) => ({
    message: { content: null, tool_calls: [{ id: `c${messages.length}`, function: { name: 'grep', arguments: JSON.stringify({ pattern: `p${messages.length}` }) } }] },
    cost: 0,
  });
  const io = {
    work: '/repo', path: { join }, MAX_OUT: 4000,
    readFile: () => '', listDir: () => [], writeFile: () => {}, exists: () => false,
    gitDiff: () => '', grepRepo: () => 'no matches', applyEdit: () => null, isTestPath: () => false,
    runTests: () => ({ resolved: false, logTail: 'FAIL' }),
  };
  const seen = [];
  const res = await agenticSolveNative({ problem: 'bug', io, llm, maxSteps: 4, onStep: (s) => { seen.push(s); } });
  assert.equal(res.steps, 4); // full budget — no accidental abort from a void callback
  assert.deepEqual(seen, [1, 2, 3, 4]);
});
