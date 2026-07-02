// Unit tests for the Fusion loop (ADR-222) — mock LLM, $0, no network/Docker/git.
// Run: node --test fusion-loop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeRouter, fusionSolve, buildFusionSystem, buildSidekickSystem } from './fusion-loop.mjs';

// ── in-memory io implementing the makeTools contract (paths are '/repo/<rel>') ──────────────────
// Exported for reuse by advisor-loop.test.mjs (ADR-226 §3.8) — same fake, zero duplication.
export function makeFakeIo(files, opts = {}) {
  const store = { ...files };
  const changed = new Set();
  let testsPass = opts.testsPass ?? false;
  const norm = (p) => String(p).replace(/^\/repo\/?/, '').replace(/^\.?\//, '');
  return {
    work: '/repo', path: { join }, MAX_OUT: 4000,
    readFile: (p) => { const k = norm(p); if (!(k in store)) throw new Error(`ENOENT ${k}`); return store[k]; },
    listDir: () => [...new Set(Object.keys(store).map((k) => k.split('/')[0]))],
    writeFile: (p, c) => { const k = norm(p); store[k] = c; changed.add(k); },
    exists: (p) => norm(p) in store,
    gitDiff: () => [...changed].map((k) => `+++ b/${k}\n${store[k]}`).join('\n'),
    grepRepo: (pat) => Object.entries(store).filter(([, v]) => v.includes(pat)).map(([k]) => `${k}:1:${pat}`).join('\n'),
    applyEdit: (content, s, r) => (content.includes(s) ? content.replace(s, r) : null),
    isTestPath: (r) => /(^|\/)test/.test(r),
    runTests: () => (testsPass ? { resolved: true, logTail: '' } : { resolved: false, logTail: 'FAIL: boom' }),
    _setTestsPass: (v) => { testsPass = v; },
  };
}
// A scripted LLM: pops queued { raw, cost } responses; throws if it runs dry (test bug).
// Exported for reuse by advisor-loop.test.mjs (ADR-226 §3.8).
export function scripted(responses, label = 'llm') {
  const q = [...responses];
  return async () => {
    if (!q.length) throw new Error(`${label} script exhausted`);
    const r = q.shift();
    return { raw: r.raw, cost: r.cost ?? 0 };
  };
}
const A = (o) => JSON.stringify(o); // action -> raw model output

// ════════════════════════════════════════════════════════════════════════════════════════════════
test('router: lead → mechanical, escalates on repeated test-fail, sticks for the cooldown, then relaxes', () => {
  const r = makeRouter({ leadSteps: 2, escalateAfterFails: 2, cooldown: 3 });
  assert.equal(r.decide({ step: 1 }).model, 'high');                       // lead-planning
  assert.equal(r.decide({ step: 2 }).model, 'high');                       // lead-planning
  assert.equal(r.decide({ step: 3 }).model, 'low');                        // mechanical default
  const esc = r.decide({ step: 4, consecutiveTestFails: 2 });              // trigger escalation
  assert.equal(esc.model, 'high');
  assert.match(esc.reason, /repeated-test-fail/);
  // sticky cooldown: steps 5,6,7 stay high even if the fail signal clears
  assert.equal(r.decide({ step: 5, consecutiveTestFails: 0 }).model, 'high');
  assert.equal(r.decide({ step: 6, consecutiveTestFails: 0 }).model, 'high');
  assert.equal(r.decide({ step: 7, consecutiveTestFails: 0 }).model, 'high');
  assert.equal(r.decide({ step: 8, consecutiveTestFails: 0 }).model, 'low'); // relaxed
});

test('router: a NEW thrash event escalates to frontier (edge-triggered, not permanent)', () => {
  const r = makeRouter({ leadSteps: 0, escalateAfterFails: 99, cooldown: 1 });
  assert.equal(r.decide({ step: 1, thrash: 0 }).model, 'low');
  const esc = r.decide({ step: 2, thrash: 1 });      // thrash went 0->1
  assert.equal(esc.model, 'high');
  assert.equal(esc.reason, 'thrash');
  // window is 1 step; same thrash count does not re-trigger after it lapses
  assert.equal(r.decide({ step: 4, thrash: 1 }).model, 'low');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
test('delegation: the lead routes a mechanical step to the sidekick, which applies the edit', async () => {
  const io = makeFakeIo({ 'foo.py': 'def f():\n    return OLD\n' });
  // Lead: delegate a mechanical edit, then submit after reviewing.
  const llmHigh = scripted([
    { raw: A({ tool: 'delegate', task: "apply the decided edit: replace OLD with NEW in foo.py", max_steps: 4 }), cost: 0.02 },
    { raw: A({ tool: 'submit' }), cost: 0.02 },
  ], 'high');
  // Sidekick: do the edit, then submit.
  const llmLow = scripted([
    { raw: A({ tool: 'edit', path: 'foo.py', search: 'return OLD', replace: 'return NEW' }), cost: 0.001 },
    { raw: A({ tool: 'submit' }), cost: 0.001 },
  ], 'low');

  const res = await fusionSolve({
    problem: 'replace OLD with NEW', io, llmHigh, llmLow,
    router: makeRouter({ leadSteps: 5 }), maxSteps: 6, sidekickSteps: 4,
  });

  assert.equal(res.delegations.length, 1, 'exactly one delegation happened');
  assert.equal(res.delegations[0].changed, true, 'sidekick applied an edit');
  assert.ok(res.sideCost > 0, 'sidekick cost was accrued');
  assert.match(io.readFile('/repo/foo.py'), /return NEW/, 'the edit landed on the shared tree');
  assert.ok(res.patch.includes('return NEW'), 'the final patch reflects the sidekick edit');
  assert.equal(res.submitted, true);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
test('fusion loop terminates and emits a non-empty patch (edit → run_tests pass → submit)', async () => {
  const io = makeFakeIo({ 'bug.py': 'x = 1\n' }, { testsPass: false });
  const llmHigh = scripted([
    { raw: A({ tool: 'edit', path: 'bug.py', search: 'x = 1', replace: 'x = 2' }), cost: 0.01 },
    { raw: A({ tool: 'run_tests' }), cost: 0.01 },   // fails first
    { raw: A({ tool: 'run_tests' }), cost: 0.01 },   // now passes (we flip below via onStep)
    { raw: A({ tool: 'submit' }), cost: 0.01 },
  ], 'high');
  const llmLow = scripted([], 'low'); // never delegated

  // flip tests to passing right before the 3rd step's run_tests
  let n = 0;
  const onStep = () => { n += 1; if (n === 2) io._setTestsPass(true); };

  const res = await fusionSolve({
    problem: 'fix x', io, llmHigh, llmLow,
    router: makeRouter({ leadSteps: 20 }), maxSteps: 8, onStep,
  });

  assert.equal(res.submitted, true, 'loop terminated via submit');
  assert.equal(res.resolvedInLoop, true, 'run_tests reported a pass');
  assert.ok(res.patch.includes('x = 2'), 'patch emitted');
  assert.ok(res.steps <= 8);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
test('cost accounting: total cost == mainCost + sideCost == sum of scripted main+sidekick costs', async () => {
  const io = makeFakeIo({ 'm.py': 'AAA\n' });
  const llmHigh = scripted([
    { raw: A({ tool: 'delegate', task: 'replace AAA with BBB in m.py' }), cost: 0.05 }, // main m1
    { raw: A({ tool: 'submit' }), cost: 0.03 },                                          // main m2
  ], 'high');
  const llmLow = scripted([
    { raw: A({ tool: 'edit', path: 'm.py', search: 'AAA', replace: 'BBB' }), cost: 0.002 }, // side s1
    { raw: A({ tool: 'submit' }), cost: 0.004 },                                            // side s2
  ], 'low');

  const res = await fusionSolve({
    problem: 'x', io, llmHigh, llmLow,
    router: makeRouter({ leadSteps: 5 }), maxSteps: 4, sidekickSteps: 4,
  });

  const mainExpected = 0.05 + 0.03;
  const sideExpected = 0.002 + 0.004;
  assert.ok(Math.abs(res.mainCost - mainExpected) < 1e-9, `mainCost ${res.mainCost}`);
  assert.ok(Math.abs(res.sideCost - sideExpected) < 1e-9, `sideCost ${res.sideCost}`);
  assert.ok(Math.abs(res.cost - (mainExpected + sideExpected)) < 1e-9, `cost ${res.cost}`);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
test('mid-session routing IN the loop: downgrades to cheap for mechanical steps, escalates on test-fail', async () => {
  const io = makeFakeIo({ 'z.py': 'v = 0\n' }, { testsPass: false });
  // leadSteps=1 → step1 high; then mechanical → low; a failing run_tests (fails>=1) → escalate high.
  const router = makeRouter({ leadSteps: 1, escalateAfterFails: 1, cooldown: 3 });
  // step1 (high): edit so run_tests can run.  step2 (low): run_tests -> fail.  step3 (high, escalated): submit.
  const llmHigh = scripted([
    { raw: A({ tool: 'edit', path: 'z.py', search: 'v = 0', replace: 'v = 1' }), cost: 0.01 }, // step1
    { raw: A({ tool: 'submit' }), cost: 0.01 },                                                 // step3
  ], 'high');
  const llmLow = scripted([
    { raw: A({ tool: 'run_tests' }), cost: 0.001 }, // step2 (mechanical stretch, cheap) — fails
  ], 'low');

  const res = await fusionSolve({ problem: 'x', io, llmHigh, llmLow, router, maxSteps: 5 });

  assert.deepEqual(res.routeLog.map((r) => r.model), ['high', 'low', 'high']);
  assert.equal(res.routeLog[1].reason, 'mechanical-default');
  assert.match(res.routeLog[2].reason, /repeated-test-fail/);
  assert.equal(res.modelSwitches, 2, 'high->low->high == 2 switches');
  assert.equal(res.lowSteps, 1);
  assert.equal(res.submitted, true);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
test('system prompts: lead advertises delegate, sidekick does not sub-delegate', () => {
  const lead = buildFusionSystem('py', '*.py');
  assert.match(lead, /"tool":"delegate"/, 'lead prompt advertises the delegate tool');
  assert.match(lead, /LEAD agent/);
  const side = buildSidekickSystem('py', '*.py');
  assert.doesNotMatch(side, /"tool":"delegate"/, 'sidekick prompt has no delegate tool');
  assert.match(side, /SIDEKICK sub-agent/);
});
