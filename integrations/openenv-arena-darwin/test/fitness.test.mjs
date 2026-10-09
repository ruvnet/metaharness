import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { meetsPromotionRule } from '../../../packages/flywheel/src/gate.ts';
import {
  classifyEpisode, classifyEpisodeDetailed, scoreCell, scoreGenome, failClosed, episodeGenTokens, choose4,
  TRUNCATION_CODES, INFRA_CODES, FAIL_CLOSED_COST,
} from '../lib/fitness.mjs';

// REAL rows from proxy calibration of qwen38@1d4bf0f2 (calib2 = v1 runner, calib-v2 = v2 runner),
// message contents trimmed by the fixture builder; every other field is verbatim.
const ROWS = readFileSync(new URL('./fixtures/real-rows.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line));
const cell = (source) => ROWS.filter((r) => r._fixture.source === source);
const episodes = (source) => cell(source).filter((r) => r.type === 'episode');
const V1_CAP = { maxTokensPerRequest: 4096 }; // v1 plan: max_completion_tokens 131072 / max_calls 32
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
const deepClone = (v) => JSON.parse(JSON.stringify(v));

test('fixture holds the real cells and failure codes we ground the rules on', () => {
  const failures = new Set(ROWS.filter((r) => r.type === 'episode').map((r) => r.failure));
  assert.deepEqual([...failures].sort(), ['ValidationError', 'completion_truncated', null].sort());
  assert.equal(ROWS.filter((r) => r.type === 'episode').length, 36);
});

test('real solved and partial rows from both runners', () => {
  for (const r of ROWS.filter((x) => x.type === 'episode' && x.reward === 1)) assert.equal(classifyEpisode(r), 'solved');
  const partials = ROWS.filter((x) => x.type === 'episode' && x.reward > 0 && x.reward < 1);
  assert.deepEqual(partials.map((r) => r.reward).sort(), [0.5, 0.5, 0.6666666666666666, 0.75, 0.75, 0.75]);
  for (const r of partials) assert.equal(classifyEpisode(r), 'partial');
});

test('real v2 completion_truncated rows (finish_reason=length at the episode budget) are truncation', () => {
  const rows = ROWS.filter((x) => x.failure === 'completion_truncated');
  assert.equal(rows.length, 2);
  for (const r of rows) {
    const last = r.trajectory.provider_metrics.at(-1);
    assert.equal(last.finish_reason, 'length');
    assert.equal(last.completion_tokens, last.request_max_tokens);
    assert.equal(classifyEpisode(r), 'truncation');
  }
});

test('real v1 ValidationError: long replies are truncation, the 604-token one-call reply is a FORMAT error', () => {
  const ve = ROWS.filter((x) => x.failure === 'ValidationError');
  assert.equal(ve.length, 8);
  const short = ve.filter((r) => r.total_tokens_reported < 4096);
  assert.equal(short.length, 1);
  assert.equal(short[0].task_id, 'security_triage');
  assert.equal(short[0].calls, 1);
  assert.equal(short[0].total_tokens_reported, 604);
  assert.deepEqual(classifyEpisodeDetailed(short[0], V1_CAP), { cls: 'format', reason: 'ValidationError:legacy_total_below_request_cap' });
  for (const r of ve.filter((x) => x !== short[0])) {
    assert.ok(r.total_tokens_reported >= 5500, 'long ones consumed > the 4096 per-request cap in total');
    assert.equal(classifyEpisode(r, V1_CAP), 'truncation');
  }
  // Without the plan's per-request cap a length cut cannot be excluded: conservative truncation.
  assert.equal(classifyEpisode(short[0]), 'truncation');
});

// Codes absent from the real sample: derived from a REAL v2 row by changing only the failure fields.
const base = episodes('calib-v2/math_route_d2.jsonl').find((r) => r.failure === 'completion_truncated');
const variant = (failure, lastMetric = {}, reward = 0) => {
  const r = deepClone(base);
  r.failure = failure; r.trajectory.failure = failure; r.reward = reward; r.solved = reward === 1;
  Object.assign(r.trajectory.provider_metrics.at(-1), lastMetric);
  return r;
};

test('every runner failure code maps to its documented class', () => {
  for (const code of TRUNCATION_CODES) assert.equal(classifyEpisode(variant(code)), 'truncation', code);
  for (const code of INFRA_CODES) assert.equal(classifyEpisode(variant(code)), 'infra', code);
  assert.equal(classifyEpisode(variant('step_budget_exhausted')), 'truncation', 'runner 8-step cap is an artefact (env cap 16)');
  assert.equal(classifyEpisode(variant('SomethingNew')), 'infra', 'unknown codes fail closed, never reasoning');
  assert.equal(classifyEpisode(variant('TimeoutError')), 'infra');
  assert.equal(classifyEpisode(variant(null)), 'reasoning', 'submitted, wrong');
  assert.equal(classifyEpisode(variant(null, {}, 0.25)), 'partial');
});

test('format failures: finished reply -> format (not reasoning), length-limited reply -> truncation', () => {
  const stopShort = { finish_reason: 'stop', completion_tokens: 900, request_max_tokens: 7152 };
  for (const code of ['invalid_json_action', 'missing_action_content', 'ValidationError']) {
    assert.deepEqual(classifyEpisodeDetailed(variant(code, stopShort)), { cls: 'format', reason: `${code}:finished_reply` });
    assert.equal(classifyEpisode(variant(code, { finish_reason: 'length' })), 'truncation', code);
    assert.equal(classifyEpisode(variant(code, { finish_reason: 'stop', completion_tokens: 7152, request_max_tokens: 7152 })), 'truncation');
    assert.equal(classifyEpisode(variant(code, { finish_reason: 'unknown', completion_tokens: null })), 'truncation');
  }
  const r = variant('invalid_json_action');
  r.trajectory.provider_metrics = [];
  assert.equal(classifyEpisode(r), 'truncation', 'no metric at all: cannot rule out a cut');
});

test('invalid rows throw instead of being scored; missing token accounting is not free', () => {
  for (const reward of [Number.NaN, Infinity, -0.1, 1.5, '1', null]) {
    assert.throws(() => classifyEpisode({ ...base, reward }), /invalid_episode_row/);
  }
  assert.throws(() => classifyEpisode({ type: 'plan' }), /invalid_episode_row/);
  assert.throws(() => scoreCell([{ ...base, trajectory: { ...base.trajectory, accounting: { generation_tokens: -5 } } }]), /generation_tokens/);
  // Schema drift (accounting dropped, metrics without token counts, no total) on an episode with calls -> throws.
  const drift = { ...base, total_tokens_reported: undefined,
    trajectory: { ...base.trajectory, accounting: undefined, provider_metrics: [{ finish_reason: 'stop' }] } };
  assert.throws(() => episodeGenTokens(drift), /provider metric without a token count/);
  assert.throws(() => episodeGenTokens({ ...drift, trajectory: {} }), /no token accounting/);
  assert.equal(episodeGenTokens({ ...drift, calls: 0, trajectory: {} }), 0, 'no call was made: zero is honest');
});

test('choose4 is exact', () => {
  assert.deepEqual([0, 3, 4, 5, 8, 16, 64].map(choose4), [0, 0, 1, 5, 70, 1820, 635376]);
});

// Synthetic cell (derived by hand): 5 solved, 2 partial(0.5), 1 truncation; n = 8, eligible m = 7.
//   signal       = (C(7,4) - C(5,4) - C(2,4)) / C(8,4) = (35 - 5 - 0) / 70 = 3/7
//   deadGroupRate = (C(5,4) + C(2,4) + C(1,4)) / C(8,4) = 5/70 = 1/14
//   varSignal    = var([1,1,1,1,1,.5,.5]) / 0.25 * 7/8 = (5/98) * 4 * 7/8 = 5/28
const ep = (seed, reward, failure = null) => ({ type: 'episode', seed, attempt: seed % 4, reward, failure, calls: 2,
  trajectory: { accounting: { generation_tokens: 1000 }, provider_metrics: [{ finish_reason: failure ? 'length' : 'stop' }] } });
const eight = [ep(0, 1), ep(1, 1), ep(2, 1), ep(3, 1), ep(4, 1), ep(5, 0.5), ep(6, 0.5), ep(7, 0, 'completion_truncated')];

test('signal = P(random group of 4 is all-eligible and mixed), hand-derived at n = 8', () => {
  const s = scoreCell(eight);
  assert.deepEqual([s.n, s.eligible, s.solved, s.partial, s.truncation], [8, 7, 5, 2, 1]);
  close(s.signal, 3 / 7);
  close(s.deadGroupRate, 1 / 14);
  close(s.varSignal, 5 / 28);
  assert.equal(s.dead, false);
  assert.equal(s.mixedFromReasoning, true);
  // Turning the truncation into any eligible outcome never lowers the signal (GRPO review finding 2 ordering).
  const solved = scoreCell([...eight.slice(0, 7), ep(7, 1)]); // (C(8,4) - C(6,4)) / 70 = 55/70
  close(solved.signal, 55 / 70);
  const wrong = scoreCell([...eight.slice(0, 7), ep(7, 0)]); // (70 - 5) / 70
  close(wrong.signal, 65 / 70);
  assert.ok(solved.signal > s.signal && wrong.signal > s.signal);
  const twoTrunc = scoreCell([...eight.slice(0, 6), ep(6, 0, 'completion_truncated'), ep(7, 0, 'completion_truncated')]);
  close(twoTrunc.signal, (choose4(6) - choose4(5)) / 70); // 10/70: more truncation, less signal
});

test('scoreCell on real v2 cells', () => {
  // science_calibration d2: rewards [1, .75, .75, .75], all eligible -> the only group is mixed -> signal 1.
  const sci = scoreCell(cell('calib-v2/science_calibration_d2.jsonl'));
  assert.equal(sci.n, 4); assert.equal(sci.solved, 1); assert.equal(sci.partial, 3);
  close(sci.meanReward, 0.8125); close(sci.rewardVar, 0.01171875);
  assert.equal(sci.signal, 1);
  close(sci.varSignal, 0.046875); // secondary: 0.01171875 / 0.25 * 4/4
  assert.equal(sci.deadGroupRate, 0);
  assert.equal(sci.mixedFromReasoning, true); assert.equal(sci.dead, false);
  const gen = episodes('calib-v2/science_calibration_d2.jsonl').reduce((a, r) => a + r.trajectory.accounting.generation_tokens, 0);
  assert.equal(sci.genTokens, gen);

  // math_route d2: [1, 1, T, 1]. The arena group IS mixed (deadGroupRate 0) but only because of truncation: signal 0.
  const math = scoreCell(cell('calib-v2/math_route_d2.jsonl'));
  assert.equal(math.solved, 3); assert.equal(math.truncation, 1); close(math.truncShare, 0.25);
  close(math.rewardVar, 0.1875);
  assert.equal(math.signal, 0, 'variance that comes only from truncation earns nothing');
  assert.equal(math.deadGroupRate, 0);
  assert.deepEqual([math.dead, math.mixedFromReasoning], [true, false]);

  const fin = scoreCell(cell('calib-v2/finance_ledger_d3.jsonl')); // [1, .5, 1, 1]
  assert.deepEqual([fin.signal, fin.mixedFromReasoning], [1, true]);
  const media = scoreCell(cell('calib-v2/media_timeline_d3.jsonl')); // [T, 1, 1, 1]
  assert.deepEqual([media.signal, media.dead], [0, true]);
});

test('scoreCell on real v1 cells derives the request cap from the plan row', () => {
  const ind = scoreCell(cell('calib2/industrial_schedule_d2.jsonl'));
  assert.equal(ind.solved, 1); assert.equal(ind.truncation, 3);
  assert.equal(ind.signal, 0); assert.equal(ind.mixedFromReasoning, false);

  const sec3 = scoreCell(cell('calib2/security_triage_d3.jsonl'));
  assert.deepEqual([sec3.truncation, sec3.format, sec3.reasoning, sec3.dead, sec3.signal, sec3.deadGroupRate], [3, 1, 0, true, 0, 1]);

  // security_triage d2: [2/3, T, 1, 1] -> m = 3 < 4: no all-eligible group (was 0.333 under the variance rule).
  const sec2 = scoreCell(cell('calib2/security_triage_d2.jsonl'));
  assert.deepEqual([sec2.solved, sec2.partial, sec2.truncation, sec2.signal], [2, 1, 1, 0]);
  assert.equal(sec2.mixedFromReasoning, false);
  close(sec2.varSignal, 2 / 27); // var([2/3,1,1]) = 2/81; / 0.25 * 3/4
  // Same cell with the truncation turned into a solve: [2/3, 1, 1, 1] -> signal 1.
  const fixedRows = deepClone(cell('calib2/security_triage_d2.jsonl'));
  Object.assign(fixedRows.find((r) => r.type === 'episode' && r.failure === 'ValidationError'), { reward: 1, solved: true, failure: null });
  assert.equal(scoreCell(fixedRows).signal, 1);

  const sat = scoreCell(cell('calib2/math_route_d1.jsonl'));
  assert.deepEqual([sat.solved, sat.dead, sat.signal, sat.rewardVar, sat.deadGroupRate], [4, true, 0, 0, 1]);

  for (const source of new Set(ROWS.map((r) => r._fixture.source))) {
    const summary = cell(source).find((r) => r.type === 'summary');
    if (summary) assert.equal(scoreCell(cell(source)).solved, summary.families[0].successes, source);
  }
});

test('empty and infra cells stay finite', () => {
  const empty = scoreCell([]);
  for (const [k, v] of Object.entries(empty)) if (typeof v === 'number') assert.ok(Number.isFinite(v), k);
  assert.deepEqual([empty.n, empty.dead, empty.signal, empty.deadGroupRate], [0, true, 0, 1]);
  const infra = scoreCell([variant('request_timeout'), variant('request_timeout'), variant(null, {}, 1), variant(null, {}, 1)]);
  close(infra.infraShare, 0.5);
  assert.equal(infra.signal, 0);
});

const realCells = () => [
  'calib-v2/science_calibration_d2.jsonl', 'calib-v2/math_route_d2.jsonl', 'calib2/math_route_d1.jsonl', 'calib2/security_triage_d2.jsonl',
].map((s) => scoreCell(cell(s)));

test('scoreGenome aggregates real cells into a gate-valid scorecard', () => {
  const cells = realCells(); // signals 1, 0, 0, 0
  const card = scoreGenome(cells);
  assert.equal(card.primary, 1);
  assert.equal(card.noopRate, 0.75, '1 - mean signal');
  assert.equal(card.regressed, false);
  assert.equal(card.raw.mixedFromReasoningCount, 1);
  assert.equal(card.raw.deadCells, 3);
  close(card.raw.deadGroupRate, 0.25); // (0 + 0 + 1 + 0) / 4: the literal arena zero-gradient rate, reported only
  close(card.costPerWin, cells.reduce((a, c) => a + c.genTokens, 0) / 1, 'tokens per unit of reasoning signal');
  assert.deepEqual(JSON.parse(JSON.stringify(card)), card, 'JSON round trip loses nothing');
  assert.notDeepEqual(meetsPromotionRule({ baseline: card, candidate: card }).reasons, ['invalid_score_evidence']);
});

test('scoreGenome regressed rules: < 4 episodes, ANY infra episode, runner error', () => {
  const ok = realCells();
  assert.equal(scoreGenome(ok).regressed, false);
  assert.equal(scoreGenome([...ok, scoreCell([])]).regressed, true);
  const infra = (k) => scoreCell([...Array(k)].map(() => variant('provider_request_failed')).concat([...Array(4 - k)].map(() => variant(null, {}, 1))));
  const one = scoreGenome([...ok, infra(1)]);
  assert.equal(one.regressed, true, 'one infra episode is no longer tolerated (arena trains on valid episodes only)');
  assert.ok(one.raw.regressedReasons.includes('cell[4]:infra_episodes_1'));
  assert.equal(scoreGenome([...ok, { ...ok[0], error: 'runner exit 2' }]).regressed, true);
  const zero = scoreGenome([scoreCell([variant('completion_truncated')])]);
  assert.ok(zero.regressed && zero.raw.regressedReasons.includes('cell[0]:too_few_episodes_1'));
  assert.ok(Number.isFinite(zero.costPerWin) && zero.costPerWin > 0, 'no signal -> huge but finite cost');
});

test('scoreGenome fails closed on NaN / Infinity / negative / malformed input', () => {
  const good = realCells()[0];
  const bad = [
    [], null, [{ ...good, signal: Number.NaN }], [{ ...good, genTokens: Infinity }], [{ ...good, genTokens: -1 }],
    [{ ...good, rewardVar: -0.01 }], [{ ...good, infraShare: Number.NaN }], [{ ...good, n: 2.5 }], [{ ...good, dead: 'no' }],
    [{ ...good, deadGroupRate: 2 }], [{ ...good, infra: -1 }],
  ];
  for (const input of bad) {
    const card = scoreGenome(input);
    assert.equal(card.regressed, true);
    assert.match(card.evaluatorError, /^scoreGenome: /);
    assert.equal(card.raw.evaluatorError, card.evaluatorError, 'survives numeric-evaluator parseScoreCard (keeps only raw)');
    assert.equal(card.primary, -1);
    assert.equal(card.costPerWin, FAIL_CLOSED_COST);
    assert.deepEqual(JSON.parse(JSON.stringify(card)), card);
  }
  const decision = meetsPromotionRule({ baseline: scoreGenome([good]), candidate: failClosed('x') });
  assert.equal(decision.promote, false);
  assert.ok(decision.reasons.includes('safety_regressed'));
});
