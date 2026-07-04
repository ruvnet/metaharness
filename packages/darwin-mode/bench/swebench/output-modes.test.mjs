// SPDX-License-Identifier: MIT
// Unit tests for the ADR-232 cost-aware output-mode decoder policy. All pure logic is covered.
// Run: node --test --experimental-strip-types output-modes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estTokens, outputBudgets, fableOutputBudgets, chooseOutputMode, chooseFableMode,
  assertFableLoopMode, assertFableMode, FABLE_FULL_PROSE_ALLOWED, FABLE_LOOP_MODES,
  modeToMaxTokens, PRICES, priceFor, effectiveCost, costPerAccepted, accepted, costPerAcceptedTask,
  CONTRACTS, repairFormatLocal, validateOutput, tryParseJson, handleContractViolation, defaultTryLocalRepair,
  VERDICT_INVARIANTS, buildVerdictPrompt, parseVerdict,
  CONTINUATION_NEXT, buildContinuationPrompt, parseContinuation, decideContinuationHeuristic,
  buildCapsule, validateCapsule, makeArtifactLogger, receiptCoverage,
  STAGE_TABLE, PRIORITY_HIERARCHY,
  costPerHarnessAccepted, costPerUserAccepted, fableAuditLine, detectErosion, MERGE_CRITERION,
} from './output-modes.mjs';

test('estTokens: chars/4 proxy', () => {
  assert.equal(estTokens(''), 0);
  assert.equal(estTokens('abcd'), 1);
  assert.equal(estTokens('abcde'), 2);
});

test('chooseOutputMode: general decoder policy', () => {
  assert.equal(chooseOutputMode({ needsCodeChange: true }), 'patch_only');
  assert.equal(chooseOutputMode({ isReview: true }), 'verdict_only');
  assert.equal(chooseOutputMode({ isAgentHandoff: true }), 'capsule');
  assert.equal(chooseOutputMode({ isReport: true }), 'json_delta');
  assert.equal(chooseOutputMode({}), 'full_prose');
  // needsCodeChange dominates
  assert.equal(chooseOutputMode({ needsCodeChange: true, isReview: true }), 'patch_only');
});

test('chooseFableMode: never returns full_prose', () => {
  for (const t of [{}, { isReview: true }, { needsCodeChange: true }, { needsContext: true }, { giveUp: true }]) {
    const m = chooseFableMode(t);
    assert.ok(FABLE_LOOP_MODES.includes(m), `${JSON.stringify(t)} -> ${m}`);
    assert.notEqual(m, 'full_prose');
  }
  assert.equal(chooseFableMode({ giveUp: true }), 'blocked');
  assert.equal(chooseFableMode({ needsContext: true }), 'need_context');
  assert.equal(chooseFableMode({ isReview: true }), 'verdict_only');
  assert.equal(chooseFableMode({}), 'minimal_patch');
});

test('assertFableLoopMode: hard guard throws on prose (governance switch off)', () => {
  assert.equal(FABLE_FULL_PROSE_ALLOWED, false, 'default must be false');
  assert.throws(() => assertFableLoopMode('full_prose'), /forbidden inside the loop/);
  assert.throws(() => assertFableLoopMode('renderer_prose'), /forbidden inside the loop/);
  for (const m of FABLE_LOOP_MODES) assert.equal(assertFableLoopMode(m), m);
  // alias
  assert.equal(assertFableMode, assertFableLoopMode);
});

test('modeToMaxTokens: budgets are the wire cap', () => {
  assert.equal(modeToMaxTokens('verdict_only'), 200);
  assert.equal(modeToMaxTokens('patch_only'), 1200);
  assert.equal(modeToMaxTokens('minimal_patch'), 1200);
  assert.equal(modeToMaxTokens('need_context'), 120);
  assert.equal(modeToMaxTokens('blocked'), 80);
  assert.equal(modeToMaxTokens('capsule'), 800);
  assert.throws(() => modeToMaxTokens('nope'));
});

test('PRICES: fable output is 5x input and dominant', () => {
  const f = priceFor('anthropic/claude-fable-5');
  assert.equal(f.inPerM, 10);
  assert.equal(f.outPerM, 50);
  assert.equal(priceFor('unknown-model'), null);
});

test('effectiveCost: in*inP + out*outP + retries*retryCost', () => {
  const c = effectiveCost({ inputTokens: 1e6, outputTokens: 1e6, model: 'anthropic/claude-fable-5' });
  assert.equal(c, 60); // 10 + 50
  const c2 = effectiveCost({ outputTokens: 2e6, retries: 2, expectedRetryCost: 0.5, price: { inPerM: 0, outPerM: 50 } });
  assert.equal(c2, 100 + 1);
  assert.throws(() => effectiveCost({ outputTokens: 1 }));
});

test('costPerAccepted / accepted / costPerAcceptedTask: anti-pathological-win', () => {
  assert.equal(costPerAccepted(10, 5), 2);
  assert.equal(costPerAccepted(10, 0), Infinity);
  // accepted requires resolved AND no latent defect AND full receipt coverage
  const good = { resolved: true, totalCostUsd: 1, fableOutputTokens: 100, retries: 0, contractViolations: 0, latentDefect: false, receiptCoverage: 1 };
  const thin = { ...good, latentDefect: true, totalCostUsd: 0.3 }; // "cheap win" that later fails
  const noReceipt = { ...good, receiptCoverage: 0.5 };
  assert.equal(accepted(good), true);
  assert.equal(accepted(thin), false);
  assert.equal(accepted(noReceipt), false);
  // the thin cheap win inflates cost-per-accepted rather than lowering it
  assert.equal(costPerAcceptedTask([good, thin]), (1 + 0.3) / 1);
  assert.equal(costPerAcceptedTask([thin]), Infinity);
});

test('repairFormatLocal: strips fences, >>> prefix, leading prose before JSON', () => {
  assert.equal(repairFormatLocal('```json\n{"a":1}\n```').text, '{"a":1}');
  assert.equal(repairFormatLocal('>>> {"tool":"read"}').text, '{"tool":"read"}');
  assert.equal(repairFormatLocal('Here is the JSON: {"a":1} done', { requireJson: true }).text, '{"a":1}');
});

test('validateOutput: rejects over-budget + forbidden sections; retry ladder never Fable-first', () => {
  // clean verdict
  const ok = validateOutput('{"verdict":"accept"}', 'verdict_only');
  assert.equal(ok.ok, true);
  assert.equal(ok.action, 'accept');
  // prose-wrapped (forbidden) → local repair first, not Fable
  const prose = validateOutput('Let me explain. {"verdict":"accept"}', 'verdict_only');
  assert.equal(prose.ok, false);
  assert.equal(prose.action, 'repair_local');
  // over budget only → cheap_normalize or smaller contract, never retry_fable
  const big = validateOutput('x'.repeat(2000), 'verdict_only');
  assert.equal(big.ok, false);
  assert.notEqual(big.action, 'retry_fable');
  // missing required key after we've already repaired → schema issue → smaller contract, not Fable
  const missing = validateOutput('{"foo":1}', 'verdict_only', { firstAttempt: false });
  assert.equal(missing.ok, false);
  assert.notEqual(missing.action, 'retry_fable');
});

test('handleContractViolation: Fable is NOT in the repair chain', async () => {
  let cheapCalled = false, smallerCalled = false;
  // local repair succeeds → never reaches cheap/smaller
  const p1 = await handleContractViolation({ ok: false, reason: 'malformed_json' }, '```json\n{"a":1}\n```', {
    cheapNormalize: async () => { cheapCalled = true; return { ok: false, reason: 'malformed_json' }; },
  });
  assert.deepEqual(p1, { a: 1 });
  assert.equal(cheapCalled, false);
  // local fails, cheap normalize succeeds
  const p2 = await handleContractViolation({ ok: false, reason: 'malformed_json' }, 'not json at all', {
    tryLocalRepair: () => ({ ok: false, reason: 'malformed_json' }),
    cheapNormalize: async () => ({ ok: true, parsed: { normalized: true } }),
  });
  assert.deepEqual(p2, { normalized: true });
  // all non-Fable repairs fail → throws (Fable never re-invoked for formatting)
  await assert.rejects(handleContractViolation({ ok: false, reason: 'schema_violation' }, 'junk', {
    tryLocalRepair: () => ({ ok: false, reason: 'malformed_json' }),
    cheapNormalize: async () => ({ ok: false, reason: 'malformed_json' }),
    retryWithSmallerContract: async () => { smallerCalled = true; return { ok: false, reason: 'schema_violation' }; },
  }), /Contract failed after non-Fable repairs/);
  assert.equal(smallerCalled, true);
  // ok result passes through
  assert.deepEqual(await handleContractViolation({ ok: true, parsed: { x: 1 } }, 'raw'), { x: 1 });
});

test('parseVerdict: invariant gate downgrades a laundered accept', () => {
  const clean = parseVerdict(JSON.stringify({ verdict: 'accept', invariants: Object.fromEntries(VERDICT_INVARIANTS.map((i) => [i, true])), blocking_issues: [] }));
  assert.equal(clean.verdict, 'accept');
  assert.equal(clean.downgraded, false);
  // accept with a failing invariant → downgraded to revise
  const bad = parseVerdict(JSON.stringify({ verdict: 'accept', invariants: { ...Object.fromEntries(VERDICT_INVARIANTS.map((i) => [i, true])), tests_pass: false }, blocking_issues: [] }));
  assert.equal(bad.verdict, 'revise');
  assert.equal(bad.downgraded, true);
  // accept with unanswered invariant → downgraded
  const missing = parseVerdict(JSON.stringify({ verdict: 'accept', invariants: { tests_pass: true }, blocking_issues: [] }));
  assert.equal(missing.verdict, 'revise');
  assert.equal(missing.downgraded, true);
  // garbage → safe default revise
  assert.equal(parseVerdict('garbage').verdict, 'revise');
});

test('buildVerdictPrompt: bakes the invariant checklist in', () => {
  const p = buildVerdictPrompt('issue', 'diff', 'trace');
  for (const inv of VERDICT_INVARIANTS) assert.ok(p.includes(inv), `prompt missing invariant ${inv}`);
  assert.ok(/not by vibes/.test(p));
});

test('parseContinuation + heuristic: brutal cheap gate schema', () => {
  const c = parseContinuation('{"continue_fable":true,"next":"run_tests","reason":"looks good"}');
  assert.equal(c.continue_fable, true);
  assert.equal(c.next, 'run_tests');
  // next=stop forces continue_fable false
  assert.equal(parseContinuation('{"continue_fable":true,"next":"stop"}').continue_fable, false);
  // unknown next → stop
  assert.equal(parseContinuation('{"continue_fable":true,"next":"wat"}').next, 'stop');
  // reason capped at 20 words
  const long = parseContinuation(`{"continue_fable":true,"next":"run_tests","reason":"${'w '.repeat(40)}"}`);
  assert.ok(long.reason.split(/\s+/).length <= 20);
  // heuristic early-stops thrash
  assert.equal(decideContinuationHeuristic({ consecutiveTestFails: 3, madeProgress: false }).continue_fable, false);
  assert.equal(decideContinuationHeuristic({ repeatedEdits: 3 }).next, 'stop');
  assert.equal(decideContinuationHeuristic({ needContext: true }).next, 'need_context');
  assert.equal(decideContinuationHeuristic({ madeProgress: true }).continue_fable, true);
  for (const n of CONTINUATION_NEXT) assert.ok(typeof n === 'string');
});

test('buildCapsule + validateCapsule: <=800 tok, <=5 state bullets', () => {
  const cap = buildCapsule({ goal: 'fix bug', state: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], changed_files: ['x.py'], open_risks: ['r'], next_action: 'test', confidence: 1.5 });
  assert.equal(cap.state.length, 5); // clamped
  assert.equal(cap.confidence, 1); // clamped to [0,1]
  const v = validateCapsule(cap);
  assert.equal(v.ok, true);
  assert.ok(v.tokens <= outputBudgets.capsule);
  // missing keys fail
  assert.equal(validateCapsule({ goal: 'x' }).ok, false);
});

test('makeArtifactLogger + receiptCoverage: full observability outside model path', () => {
  const writes = [];
  const fakeFs = { mkdirSync: () => {}, writeFileSync: (p, b) => writes.push([p, b]) };
  const logger = makeArtifactLogger('/some/dir', fakeFs);
  const r1 = logger.log('diff', 'diff --git ...');
  const r2 = logger.log('verifier_score', { score: 0.9 });
  assert.equal(r1.kind, 'diff');
  assert.ok(/^[0-9a-f]{64}$/.test(r1.sha256));
  assert.equal(logger.receipts.length, 2);
  assert.equal(writes.length, 2);
  // receipt coverage metric
  assert.equal(receiptCoverage(logger.receipts, ['diff', 'verifier_score']), 1);
  assert.equal(receiptCoverage(logger.receipts, ['diff', 'verifier_score', 'capsule']), 2 / 3);
  // logging never throws even without fs
  const noFs = makeArtifactLogger(null, null);
  assert.ok(noFs.log('x', 'y').id);
});

test('STAGE_TABLE + PRIORITY_HIERARCHY: normative shapes', () => {
  // Final stage prose is NOT Fable
  const final = STAGE_TABLE.find((s) => s.stage === 'Final');
  assert.ok(/NOT Fable/i.test(final.note));
  // no Fable stage uses full_prose
  for (const s of STAGE_TABLE) if (s.model === 'fable') assert.notEqual(s.mode, 'full_prose');
  // priority: correctness #1, cost-per-accepted #4, token reduction last
  assert.equal(PRIORITY_HIERARCHY[0].goal, 'correctness');
  assert.equal(PRIORITY_HIERARCHY[3].goal, 'cost_per_accepted_task');
  assert.equal(PRIORITY_HIERARCHY[PRIORITY_HIERARCHY.length - 1].goal, 'token_reduction');
});

test('defaultTryLocalRepair: fence-wrapped json', () => {
  assert.deepEqual(defaultTryLocalRepair('```json\n{"a":1}\n```'), { ok: true, parsed: { a: 1 } });
  assert.equal(defaultTryLocalRepair('no json here').ok, false);
});

test('tryParseJson: tolerant of surrounding text', () => {
  assert.deepEqual(tryParseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(tryParseJson('prefix {"a":1} suffix'), { a: 1 });
  assert.equal(tryParseJson('nope'), null);
});

test('governance: harness vs user cost split (lagged-truth)', () => {
  const runs = [
    { class: 'harness_accepted', totalCostUsd: 1, latentDefect: false, receiptCoverage: 1 },
    { class: 'user_accepted', totalCostUsd: 2, latentDefect: false, receiptCoverage: 1 },
    { class: 'latent_defect_found', totalCostUsd: 3, latentDefect: true, receiptCoverage: 1 },
    { class: 'rolled_back', totalCostUsd: 4, latentDefect: false, receiptCoverage: 1 },
  ];
  // harness metric: only the harness_accepted, defect-free, receipted run counts in the denominator
  assert.equal(costPerHarnessAccepted(runs), (1 + 2 + 3 + 4) / 1);
  // user (shadow) metric: only user_accepted counts (rolled_back excluded)
  assert.equal(costPerUserAccepted(runs), (1 + 2 + 3 + 4) / 1);
  // a harness_accepted run with a latent defect does NOT count in the harness denominator
  assert.equal(costPerHarnessAccepted([{ class: 'harness_accepted', totalCostUsd: 5, latentDefect: true, receiptCoverage: 1 }]), Infinity);
  // a harness_accepted run without full receipts does NOT count
  assert.equal(costPerHarnessAccepted([{ class: 'harness_accepted', totalCostUsd: 5, latentDefect: false, receiptCoverage: 0.5 }]), Infinity);
});

test('governance: audit line + erosion detection', () => {
  const line = fableAuditLine({ mode: 'verdict_only', inputTokens: 18422, outputTokens: 219, contractOk: true, receiptId: 'r-abc' });
  assert.equal(line.model, 'fable');
  assert.equal(line.full_prose_allowed, false);
  assert.equal(line.mode, 'verdict_only');
  assert.equal(line.output_tokens, 219);
  // erosion query: clean rows → no offenders
  const clean = [line, fableAuditLine({ mode: 'minimal_patch', inputTokens: 1, outputTokens: 1, contractOk: true, receiptId: 'r' })];
  assert.equal(detectErosion(clean).length, 0);
  // a smuggled full_prose fable call is flagged
  const eroded = [...clean, { model: 'fable', mode: 'full_prose' }];
  assert.equal(detectErosion(eroded).length, 1);
  assert.equal(detectErosion(eroded)[0].mode, 'full_prose');
  // non-fable rows are ignored
  assert.equal(detectErosion([{ model: 'sonnet', mode: 'full_prose' }]).length, 0);
});

test('governance: merge criterion is the 4-line gate', () => {
  assert.equal(MERGE_CRITERION.length, 4);
  assert.ok(MERGE_CRITERION.some((c) => /prose in-loop/i.test(c)));
  assert.ok(MERGE_CRITERION.some((c) => /modeled claim/i.test(c)));
});
