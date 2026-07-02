// Unit tests for the Advisor loop (ADR-226 §3.8) — mock LLM, $0, no network/Docker/git.
// Run: node --test advisor-loop.test.mjs
// Reuses makeFakeIo + scripted from fusion-loop.test.mjs (queue exhaustion throws → loop overrun
// is an explicit failure). The 10 tests below are the §3.8 contract, verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeIo, scripted } from './fusion-loop.test.mjs';
import { advisorSolve, makeAdvisorGate, buildAdvisedSystem, buildAdvisorSystem, buildAdvisorPrompt } from './advisor-loop.mjs';
import { buildAgenticSystem } from './agentic-loop.mjs';

const A = (o) => JSON.stringify(o); // action -> raw model output
// A gate that never fires — used where a test's signals (failing run_tests) would otherwise
// trigger an unscripted checkpoint consult.
const quietGate = () => makeAdvisorGate({ adviseAfterFails: 99, adviseOnThrash: false });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (1) voluntary advise injects an ADVISOR: obs, advisorCost accrues, cost === loopCost + advisorCost
test('voluntary advise: injects ADVISOR obs, advisorCost accrues, cost splits exactly', async () => {
  const io = makeFakeIo({ 'foo.py': 'def f():\n    return OLD\n' });
  const llmLow = scripted([
    { raw: A({ tool: 'advise', question: 'is OLD the bug?' }), cost: 0.001 },
    { raw: A({ tool: 'edit', path: 'foo.py', search: 'return OLD', replace: 'return NEW' }), cost: 0.002 },
    { raw: A({ tool: 'submit' }), cost: 0.003 },
  ], 'low');
  const llmAdvisor = scripted([
    { raw: 'Yes — OLD is the bug. Next: edit foo.py line 2, replace OLD with NEW.', cost: 0.03 },
    { raw: 'VERDICT: APPROVE', cost: 0.02 }, // mandatory pre-submit review
  ], 'advisor');

  const res = await advisorSolve({ problem: 'fix OLD', io, llmLow, llmAdvisor, gate: quietGate(), maxSteps: 6 });

  assert.equal(res.advisories.length, 2, 'one voluntary + one pre-submit advisory recorded');
  assert.equal(res.advisories[0].trigger, 'advise');
  assert.equal(res.advisories[0].question, 'is OLD the bug?');
  assert.match(res.transcript[0].obs, /^ADVISOR:\n/, 'advice injected as an ADVISOR: observation');
  assert.match(res.transcript[0].obs, /Guidance only — you execute the actions/);
  const loopExpected = 0.001 + 0.002 + 0.003;
  const advisorExpected = 0.03 + 0.02;
  assert.ok(Math.abs(res.loopCost - loopExpected) < 1e-9, `loopCost ${res.loopCost}`);
  assert.ok(Math.abs(res.advisorCost - advisorExpected) < 1e-9, `advisorCost ${res.advisorCost}`);
  assert.ok(Math.abs(res.cost - (loopExpected + advisorExpected)) < 1e-9, `cost ${res.cost}`);
  assert.equal(res.submitted, true);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (2) gate edge-trigger + cooldown, observable via _state()
test('gate: consults on repeated-test-fail, suppresses for the cooldown, thrash is edge-triggered', () => {
  const g = makeAdvisorGate({ adviseAfterFails: 2, cooldown: 4 });
  assert.equal(g.decide({ step: 1 }).consult, false);
  assert.equal(g.decide({ step: 2, consecutiveTestFails: 1 }).consult, false);
  const c = g.decide({ step: 3, consecutiveTestFails: 2 });
  assert.equal(c.consult, true);
  assert.match(c.reason, /repeated-test-fail\(2\)/);
  assert.deepEqual(g._state(), { advisedUntil: 7, lastThrash: 0 }, 'cooldown set to step+4');
  // suppressed through step 7 even if the signal persists
  for (const s of [4, 5, 6, 7]) assert.equal(g.decide({ step: s, consecutiveTestFails: 3 }).consult, false, `step ${s} suppressed`);
  assert.equal(g.decide({ step: 8, consecutiveTestFails: 3 }).consult, true, 'step 8 re-consults');
  // thrash edge-trigger: a NEW thrash event consults; the same count does not re-trigger
  const g2 = makeAdvisorGate({ adviseAfterFails: 99, cooldown: 1 });
  const t = g2.decide({ step: 1, thrash: 1 });
  assert.equal(t.consult, true);
  assert.equal(t.reason, 'thrash');
  assert.deepEqual(g2._state(), { advisedUntil: 2, lastThrash: 1 });
  assert.equal(g2.decide({ step: 3, thrash: 1 }).consult, false, 'same thrash count after cooldown does not re-trigger');
  assert.equal(g2.decide({ step: 4, thrash: 2 }).consult, true, 'a NEW thrash event re-triggers');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (3) veto → fix → approve, with the vetoed diff snapshotted before the fix
test('pre-submit veto: REVISE snapshots the pre-fix diff, loop continues, second submit approves', async () => {
  const io = makeFakeIo({ 'bug.py': 'x = 0\n' });
  const llmLow = scripted([
    { raw: A({ tool: 'edit', path: 'bug.py', search: 'x = 0', replace: 'x = 1' }), cost: 0.001 },
    { raw: A({ tool: 'submit' }), cost: 0.001 },                                                  // vetoed
    { raw: A({ tool: 'edit', path: 'bug.py', search: 'x = 1', replace: 'x = 2' }), cost: 0.001 }, // the fix
    { raw: A({ tool: 'submit' }), cost: 0.001 },                                                  // approved
  ], 'low');
  const llmAdvisor = scripted([
    { raw: 'VERDICT: REVISE — x', cost: 0.03 },
    { raw: 'VERDICT: APPROVE', cost: 0.03 },
  ], 'advisor');

  const res = await advisorSolve({ problem: 'fix x', io, llmLow, llmAdvisor, gate: quietGate(), maxSteps: 8 });

  assert.equal(res.vetoes, 1);
  assert.equal(res.submitted, true);
  assert.equal(res.vetoedPatches.length, 1);
  assert.match(res.vetoedPatches[0].diff, /x = 1/, 'snapshot holds the PRE-fix diff');
  assert.doesNotMatch(res.vetoedPatches[0].diff, /x = 2/, 'snapshot does not contain the post-veto fix');
  assert.match(res.patch, /x = 2/, 'final patch has the fix');
  assert.match(res.transcript[1].obs, /submit VETOED by advisor \(1\/2\)/);
  const verdicts = res.advisories.filter((a) => a.trigger === 'pre-submit').map((a) => a.verdict);
  assert.deepEqual(verdicts, ['REVISE', 'APPROVE']);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (4) an always-REVISE advisor cannot block forever: after maxVetoes, submit passes unreviewed
test('veto bound: always-REVISE advisor still submits after maxVetoes', async () => {
  const io = makeFakeIo({ 'a.py': 'v = 0\n' });
  const llmLow = scripted([
    { raw: A({ tool: 'edit', path: 'a.py', search: 'v = 0', replace: 'v = 1' }), cost: 0.001 },
    { raw: A({ tool: 'submit' }), cost: 0.001 }, // veto 1
    { raw: A({ tool: 'submit' }), cost: 0.001 }, // veto 2
    { raw: A({ tool: 'submit' }), cost: 0.001 }, // passes unreviewed (veto budget spent)
  ], 'low');
  const llmAdvisor = scripted([
    { raw: 'VERDICT: REVISE — no', cost: 0.03 },
    { raw: 'VERDICT: REVISE — still no', cost: 0.03 },
    // NO third response: a third review call would throw 'script exhausted' — proving unreviewed.
  ], 'advisor');

  const res = await advisorSolve({ problem: 'x', io, llmLow, llmAdvisor, gate: quietGate(), maxSteps: 8, maxVetoes: 2 });

  assert.equal(res.vetoes, 2);
  assert.equal(res.vetoedPatches.length, 2);
  assert.equal(res.submitted, true, 'third submit passed unreviewed');
  assert.ok(res.patch.includes('v = 1'), 'the (twice-vetoed) patch is still returned');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (5) advisor errors are non-fatal (§3.6) — the loop continues; pre-submit failure = APPROVE
test('advisor throw is non-fatal: consult error becomes an obs, pre-submit error fail-opens', async () => {
  const io = makeFakeIo({ 'b.py': 'w = 0\n' });
  const llmLow = scripted([
    { raw: A({ tool: 'advise', question: 'help?' }), cost: 0.001 },
    { raw: A({ tool: 'edit', path: 'b.py', search: 'w = 0', replace: 'w = 1' }), cost: 0.001 },
    { raw: A({ tool: 'submit' }), cost: 0.001 },
  ], 'low');
  const llmAdvisor = async () => { throw new Error('503 upstream'); }; // always down

  const res = await advisorSolve({ problem: 'x', io, llmLow, llmAdvisor, gate: quietGate(), maxSteps: 6 });

  assert.match(res.transcript[0].obs, /advisor unavailable: 503 upstream/);
  assert.equal(res.submitted, true, 'pre-submit advisor failure counted as APPROVE');
  assert.equal(res.advisorCost, 0);
  assert.equal(res.vetoes, 0);
  assert.ok(res.patch.includes('w = 1'));
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (6) buildAdvisorPrompt: full-transcript asymmetry (early entries beyond the 12k loop window),
//     the elision marker, the diff, and the ≤38k hard bound
test('buildAdvisorPrompt: diff + early entries + elision marker, never exceeds 38k chars', () => {
  const bigObs = 'X'.repeat(3000); // above the 1200 obsChars re-cap
  const transcript = Array.from({ length: 40 }, (_, i) => ({ actionRaw: `{"tool":"read","path":"file${i}.py"}`, obs: `obs-${i} ` + bigObs }));
  const p = buildAdvisorPrompt({ problem: 'the bug', transcript, diff: '+++ b/fix.py\n+the actual fix line', phase: 'checkpoint', reason: 'thrash' });
  assert.ok(p.length <= 38000, `prompt ${p.length} chars exceeds the 38k hard bound`);
  assert.match(p, /the actual fix line/, 'current diff included');
  // Head anchoring: entries 0 and 1 survive even though the loop's .slice(-12000) window lost them.
  assert.match(p, /file0\.py/, 'first transcript entry kept (beyond the 12k loop window)');
  assert.match(p, /file1\.py/, 'second transcript entry kept');
  assert.match(p, /…\[elided \d+ steps\]/, 'elision marker present');
  assert.match(p, /obs-39/, 'tail (current state) kept');
  assert.match(p, /…\[obs truncated \d+ chars\]/, 'oversized observations re-capped at obsChars');
  assert.match(p, /PHASE: checkpoint\(thrash\)/);
  // A consult with a question includes the (capped) question line.
  const q = buildAdvisorPrompt({ problem: 'x', transcript: [], diff: '', phase: 'consult', question: 'Q'.repeat(600) });
  assert.match(q, /AGENT'S QUESTION: Q+/);
  assert.ok(!q.includes('Q'.repeat(501)), 'question capped at 500 chars');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (7) prompt surgery: the advised system advertises advise; the advisor system does not
test('system prompts: buildAdvisedSystem advertises advise, buildAdvisorSystem does not', () => {
  const advised = buildAdvisedSystem('py', '*.py');
  assert.match(advised, /"tool":"advise"/);
  assert.match(advised, /STRONG senior ADVISOR on call/);
  assert.match(advised, /"tool":"submit"/, 'submit line survives the insertion');
  const advisor = buildAdvisorSystem('py');
  assert.doesNotMatch(advisor, /"tool":"advise"/);
  assert.match(advisor, /READ-ONLY senior engineer/);
  assert.match(advisor, /VERDICT: APPROVE/);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (8) maxAdvisories exhaustion: the (N+1)th advise gets the budget-exhausted obs, no advisor call
test('maxAdvisories exhaustion: over-budget advise gets the exhaustion obs without a consult', async () => {
  const io = makeFakeIo({ 'c.py': 'y = 0\n' });
  const llmLow = scripted([
    { raw: A({ tool: 'advise', question: 'q1' }), cost: 0.001 },
    { raw: A({ tool: 'advise', question: 'q2' }), cost: 0.001 }, // over budget (maxAdvisories=1)
    { raw: A({ tool: 'submit' }), cost: 0.001 },                  // empty diff → skips review
  ], 'low');
  const llmAdvisor = scripted([
    { raw: 'first and only advice', cost: 0.03 },
    // NO second response: a second consult would throw 'script exhausted'.
  ], 'advisor');

  const res = await advisorSolve({ problem: 'x', io, llmLow, llmAdvisor, gate: quietGate(), maxSteps: 6, maxAdvisories: 1 });

  assert.equal(res.advisories.length, 1, 'only one consult happened');
  assert.match(res.transcript[1].obs, /advisor budget exhausted \(1\) — proceed with your best judgment/);
  assert.equal(res.submitted, true, 'empty-diff submit skipped the pre-submit review');
  assert.ok(Math.abs(res.advisorCost - 0.03) < 1e-9);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (9) checkpoint-then-resolve: repeated test-fails trigger an involuntary consult; after the fix
//     (io._setTestsPass flipped mid-run) tests pass and the loop resolves
test('checkpoint consult fires on repeated test-fails, then the loop resolves after the fix', async () => {
  const io = makeFakeIo({ 'd.py': 'z = 0\n' }, { testsPass: false });
  const llmLow = scripted([
    { raw: A({ tool: 'edit', path: 'd.py', search: 'z = 0', replace: 'z = 1' }), cost: 0.001 },
    { raw: A({ tool: 'run_tests' }), cost: 0.001 }, // fail 1
    { raw: A({ tool: 'run_tests' }), cost: 0.001 }, // fail 2 → checkpoint consult fires
    { raw: A({ tool: 'edit', path: 'd.py', search: 'z = 1', replace: 'z = 2' }), cost: 0.001 },
    { raw: A({ tool: 'run_tests' }), cost: 0.001 }, // passes (flipped below)
    { raw: A({ tool: 'submit' }), cost: 0.001 },
  ], 'low');
  const llmAdvisor = scripted([
    { raw: 'Root cause: z must be 2, not 1. Next: edit d.py line 1.', cost: 0.03 }, // checkpoint
    { raw: 'VERDICT: APPROVE', cost: 0.03 },                                        // pre-submit
  ], 'advisor');
  // flip the fake oracle to passing right before the 5th step's run_tests
  let n = 0;
  const onStep = () => { n += 1; if (n === 4) io._setTestsPass(true); };

  const res = await advisorSolve({
    problem: 'fix z', io, llmLow, llmAdvisor,
    gate: makeAdvisorGate({ adviseAfterFails: 2, cooldown: 4 }), maxSteps: 8, onStep,
  });

  const checkpoint = res.advisories.find((a) => a.trigger === 'checkpoint');
  assert.ok(checkpoint, 'a checkpoint consult happened');
  assert.match(checkpoint.reason, /repeated-test-fail\(2\)/);
  assert.match(res.transcript[2].obs, /📋 ADVISOR \(checkpoint: repeated-test-fail\(2\)\):/, 'advice APPENDED to the run_tests obs');
  assert.equal(res.resolvedInLoop, true);
  assert.equal(res.submitted, true);
  assert.match(res.patch, /z = 2/);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (10) D0 mode (llmAdvisor: null): unmodified buildAgenticSystem, zero advisor calls,
//      advisorCost === 0, executorActions === steps
test('D0 mode: llmAdvisor null uses buildAgenticSystem, makes zero advisor calls', async () => {
  const io = makeFakeIo({ 'e.py': 'k = 0\n' }, { testsPass: true });
  let seenSystem;
  const base = scripted([
    { raw: A({ tool: 'edit', path: 'e.py', search: 'k = 0', replace: 'k = 1' }), cost: 0.001 },
    { raw: A({ tool: 'run_tests' }), cost: 0.001 },
    { raw: A({ tool: 'submit' }), cost: 0.001 }, // non-empty diff, but D0 → NO pre-submit review
  ], 'low');
  const llmLow = async (prompt, system, temp) => { seenSystem = system; return base(prompt, system, temp); };

  const res = await advisorSolve({ problem: 'x', io, llmLow, llmAdvisor: null, maxSteps: 6 });

  assert.equal(seenSystem, buildAgenticSystem(), 'D0 runs the unmodified agentic system prompt');
  assert.doesNotMatch(seenSystem, /"tool":"advise"/);
  assert.equal(res.advisories.length, 0);
  assert.equal(res.advisorCost, 0);
  assert.equal(res.vetoes, 0);
  assert.equal(res.executorActions, res.steps, 'every D0 action is an executor action');
  assert.equal(res.submitted, true);
  assert.equal(res.resolvedInLoop, true);
});
