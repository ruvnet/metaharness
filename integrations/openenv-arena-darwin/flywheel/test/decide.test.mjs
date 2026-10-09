// decideSubmit is the ONLY place a submission is allowed; exhaustively check that every condition is load-bearing.
// Run: node --experimental-strip-types --test integrations/openenv-arena-darwin/flywheel/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionFlags, DECISION_KEYS, decideSubmit, decisionKind, KIND_LABELS, POLICIES, REDRAW_KEYS, REDRAW_REQUEST_KEYS,
  replayCoversRequest } from '../decide.mjs';

const allTrue = () => Object.fromEntries(DECISION_KEYS.map(k => [k, true]));
const H = c => c.repeat(64);

test('all conditions true -> submit, no reasons', () => {
  assert.deepEqual(decideSubmit(allTrue()), { submit: true, reasons: [] });
  assert.equal(DECISION_KEYS.length, new Set(DECISION_KEYS).size);
});

test('every single condition, made non-true in any way, blocks and is named', () => {
  for (const k of DECISION_KEYS) {
    for (const bad of [false, undefined, null, 'true', 1, {}, []]) {
      const f = allTrue();
      if (bad === undefined) delete f[k]; else f[k] = bad;
      assert.deepEqual(decideSubmit(f), { submit: false, reasons: [k] }, `${k}=${JSON.stringify(bad)}`);
    }
  }
});

test('every pair of failing conditions blocks and both are reported in policy order', () => {
  for (let a = 0; a < DECISION_KEYS.length; a++) {
    for (let b = a + 1; b < DECISION_KEYS.length; b++) {
      const f = allTrue();
      f[DECISION_KEYS[a]] = false; f[DECISION_KEYS[b]] = false;
      assert.deepEqual(decideSubmit(f), { submit: false, reasons: [DECISION_KEYS[a], DECISION_KEYS[b]] });
    }
  }
});

test('all false lists every key; unknown keys and non-objects fail closed', () => {
  assert.deepEqual(decideSubmit(Object.fromEntries(DECISION_KEYS.map(k => [k, false]))).reasons, [...DECISION_KEYS]);
  assert.deepEqual(decideSubmit({ ...allTrue(), approvedInSlack: true }), { submit: false, reasons: ['unexpected_flag:approvedInSlack'] });
  for (const v of [null, undefined, 'auto', [], 42, true]) assert.deepEqual(decideSubmit(v), { submit: false, reasons: ['invalid_decision_input'] });
});

// A complete, consistent set of raw facts from which buildDecisionFlags must derive all-true.
const COMMIT = '0af81c55269be029dd64ccdc79e23654aa9dcaa4';
function goodFacts() {
  const sha = H('a'), tasks = [{ task_id: 'math_route-d2' }, { task_id: 'finance_ledger-d3' }];
  return {
    mode: 'auto', darwin: { evidence: 'evaluator_scorecards' }, incumbent: { genomeDigest: H('1'), day1: true, submissionId: null },
    leaderboard: { hasIncumbent: false, latestValidatedId: null }, candidate: { genomeDigest: H('2') },
    plan: { intact: true, candidateDigest: H('2'), incumbentDigest: H('1'), alpha: 0.05, lambda: 0.5, candidateBudget: 7, envSourceSha: H('5') },
    confirmation: { preregistered: true, provenanceMatchesPlan: true, dryRun: false, cardsMatchGenomes: true, pairedUsed: true },
    gate: { promote: true, verified: true, publicKeyPinned: true, candidateDigest: H('c'), expectedCandidateDigest: H('c'),
      baselineDigest: H('b'), expectedBaselineDigest: H('b'), boundRequestSha256: sha, alpha: 0.05, lambda: 0.5, candidateBudget: 7 },
    request: { sha256: sha, image: 'ghcr.io/x/y@sha256:' + H('9'), expectedImage: 'ghcr.io/x/y@sha256:' + H('9'), renderedFor: 'candidate',
      tasks, tasksMatchCandidate: true, genomeDigest: H('2') },
    checks: { requestSha256: sha, image: 'ghcr.io/x/y@sha256:' + H('9'), envSourceSha: H('5'), envCommit: COMMIT, envDirty: false,
      checks: { anonymousPull: { ok: true }, openenvValidate: { ok: true },
        exampleReplay: { ok: true, taskIds: ['finance_ledger-d3', 'math_route-d2'] }, schemaEqual: { ok: true }, limits: { ok: true } } },
    expectEnvCommit: COMMIT, dates: { run: '2026-10-09', today: '2026-10-09' },
    slot: { free: true }, alreadySubmitted: false,
  };
}

test('buildDecisionFlags: consistent facts derive exactly the decision keys, all true', () => {
  const flags = buildDecisionFlags(goodFacts());
  assert.deepEqual(Object.keys(flags).sort(), [...DECISION_KEYS].sort());
  assert.deepEqual(decideSubmit(flags), { submit: true, reasons: [] });
  assert.deepEqual(decideSubmit(buildDecisionFlags({})).reasons, [...DECISION_KEYS], 'empty facts: everything blocks');
});

test('buildDecisionFlags: each raw-fact defect maps to its condition', () => {
  const cases = [
    ['modeAuto', f => { f.mode = 'dry-run'; }],
    ['leaderboardAgreesWithIncumbent', f => { f.leaderboard.hasIncumbent = true; }], // day 1 locally, but the board lists the user
    ['leaderboardAgreesWithIncumbent', f => { f.leaderboard.hasIncumbent = null; }], // unknown / truncated board
    ['leaderboardAgreesWithIncumbent', f => { f.incumbent.day1 = false; }], // a validated incumbent the board does not show
    ['leaderboardAgreesWithIncumbent', f => { delete f.incumbent.day1; }],
    ['darwinEvidenceIsScorecards', f => { f.darwin.evidence = 'evaluator_dry_run_fake_rows_not_model_rollouts'; }],
    ['candidatePresent', f => { f.candidate = null; }],
    ['candidateDiffersFromIncumbent', f => { f.candidate.genomeDigest = f.incumbent.genomeDigest; }],
    ['confirmationNotDryRun', f => { f.confirmation.dryRun = true; }],
    ['confirmationNotDryRun', f => { delete f.confirmation.dryRun; }],
    ['gateCandidateDigestMatches', f => { f.gate.candidateDigest = H('d'); }],
    ['gateCandidateDigestMatches', f => { f.gate.candidateDigest = H('C'); f.gate.expectedCandidateDigest = H('C'); }], // not lowercase hex
    ['gateBaselineDigestMatches', f => { f.gate.baselineDigest = null; f.gate.expectedBaselineDigest = null; }],
    ['requestDigestBoundInGateReceipt', f => { f.gate.boundRequestSha256 = null; }],
    ['requestDigestBoundInGateReceipt', f => { f.gate.boundRequestSha256 = H('e'); }],
    ['requestRenderedForCandidate', f => { f.request.renderedFor = 'needs-human'; }],
    ['requestRenderedForCandidate', f => { f.request.tasksMatchCandidate = false; }],
    ['requestRenderedForCandidate', f => { f.request.expectedImage = 'ghcr.io/x/y@sha256:' + H('8'); }],
    ['checksForThisRequest', f => { f.checks.image = 'ghcr.io/x/z@sha256:' + H('9'); }],
    ['imagePulledAnonymously', f => { f.checks.checks.anonymousPull.ok = 'yes'; }],
    ['openenvValidatePassed', f => { delete f.checks.checks.openenvValidate; }],
    ['schemaEqual', f => { f.checks.checks.schemaEqual = { ok: false }; }],
    ['limitsOk', f => { f.checks.checks.limits = true; }],
    ['exampleReplayAllTasksPassed', f => { f.checks.checks.exampleReplay.taskIds = ['math_route-d2']; }],
    ['exampleReplayAllTasksPassed', f => { delete f.checks.checks.exampleReplay.taskIds; }],
    ['slotFree', f => { f.slot = { free: 'true' }; }],
    ['notAlreadySubmitted', f => { delete f.alreadySubmitted; }],
    // adv 9: own GET /submissions must agree with local state too
    ['leaderboardAgreesWithIncumbent', f => { f.leaderboard.latestValidatedId = 'someone-validated-earlier'; }],
    ['leaderboardAgreesWithIncumbent', f => { delete f.leaderboard.latestValidatedId; }], // list unreadable = unknown
    ['leaderboardAgreesWithIncumbent', f => { f.incumbent = { ...f.incumbent, day1: false, submissionId: 'mine-1' }; f.leaderboard = { hasIncumbent: true, latestValidatedId: 'mine-2' }; }],
    // adv 1: plan, candidate and rendered request must name one genome
    ['candidateMatchesPlan', f => { f.plan.candidateDigest = H('3'); }],
    ['candidateMatchesPlan', f => { f.plan.incumbentDigest = H('3'); }],
    ['candidateMatchesPlan', f => { f.request.genomeDigest = H('3'); }],
    ['candidateMatchesPlan', f => { f.plan.intact = false; }],
    ['candidateMatchesPlan', f => { f.plan = null; }],
    // adv 2: the receipt's test is the preregistered one
    ['gateConfigMatchesPlan', f => { f.gate.alpha = 0.5; }],
    ['gateConfigMatchesPlan', f => { f.gate.lambda = 0.9; }],
    ['gateConfigMatchesPlan', f => { f.gate.candidateBudget = 1; }],
    ['gateConfigMatchesPlan', f => { f.plan.alpha = null; f.gate.alpha = null; }],
    // adv 5 / adv 3: env lane pinned + clean; the image's env source is what was measured
    ['envLaneCommitPinned', f => { f.expectEnvCommit = null; }],
    ['envLaneCommitPinned', f => { f.checks.envCommit = 'f'.repeat(40); }],
    ['envLaneCommitPinned', f => { f.checks.envDirty = true; }],
    ['imageEnvSourceMatchesPlan', f => { f.checks.envSourceSha = H('6'); }],
    ['imageEnvSourceMatchesPlan', f => { f.checks.envSourceSha = null; f.plan.envSourceSha = null; }],
    // adv 4: a resumed old date never submits
    ['runDateIsToday', f => { f.dates.today = '2026-10-20'; }],
    ['runDateIsToday', f => { f.dates.today = null; f.dates.run = null; }],
  ];
  for (const [key, mutate] of cases) {
    const f = goodFacts();
    mutate(f);
    const d = decideSubmit(buildDecisionFlags(f));
    assert.equal(d.submit, false, key);
    assert.ok(d.reasons.includes(key), `${key}: got ${d.reasons}`);
  }
  // A request digest change desynchronises binding, checks and validity together; it must never pass.
  const f = goodFacts();
  f.request.sha256 = 'not-a-digest';
  assert.deepEqual(decideSubmit(buildDecisionFlags(f)).reasons, ['requestDigestValid', 'requestDigestBoundInGateReceipt', 'checksForThisRequest']);
});

test('replayCoversRequest requires the exact task-id set', () => {
  const tasks = [{ task_id: 'a-d1' }, { task_id: 'b-d2' }];
  assert.equal(replayCoversRequest({ taskIds: ['b-d2', 'a-d1'] }, tasks), true);
  assert.equal(replayCoversRequest({ taskIds: ['a-d1'] }, tasks), false);
  assert.equal(replayCoversRequest({ taskIds: ['a-d1', 'b-d2', 'c-d3'] }, tasks), false);
  assert.equal(replayCoversRequest({ taskIds: ['a-d1', 'a-d1'] }, tasks), false);
  assert.equal(replayCoversRequest({ taskIds: [] }, []), false);
  assert.equal(replayCoversRequest({}, tasks), false);
});

// ---------------------------------------------------------------------------------------------------------------
// Policies. gate-only must be byte-identical to the pre-policy decideSubmit; daily-best decides over the kind's keys.
// LEGACY is a frozen copy of decideSubmit as it was before the policy field existed.
const LEGACY_SET = new Set(DECISION_KEYS);
function LEGACY(flags) {
  if (flags === null || typeof flags !== 'object' || Array.isArray(flags)) return { submit: false, reasons: ['invalid_decision_input'] };
  const reasons = DECISION_KEYS.filter(k => flags[k] !== true);
  for (const k of Object.keys(flags).sort()) if (!LEGACY_SET.has(k)) reasons.push(`unexpected_flag:${k}`);
  return { submit: reasons.length === 0, reasons };
}
const BAD = [false, undefined, null, 'true', 1, {}, []];
const redrawTrue = () => Object.fromEntries(REDRAW_KEYS.map(k => [k, true])); // no gate keys -> kind incumbent-redraw
const withBad = (f, k, bad) => { const g = { ...f }; if (bad === undefined) delete g[k]; else g[k] = bad; return g; };
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

test('gate-only (default and explicit) is byte-identical to the legacy decision over every single and pair sweep', () => {
  assert.deepEqual(POLICIES, ['gate-only', 'daily-best']);
  const inputs = [allTrue(), {}, null, undefined, 'auto', [], 42, true, { ...allTrue(), approvedInSlack: true },
    { ...allTrue(), incumbentValidated: true }, { ...redrawTrue() }, Object.fromEntries(DECISION_KEYS.map(k => [k, false]))];
  for (const k of DECISION_KEYS) for (const bad of BAD) inputs.push(withBad(allTrue(), k, bad));
  for (let a = 0; a < DECISION_KEYS.length; a++) for (let b = a + 1; b < DECISION_KEYS.length; b++) {
    inputs.push({ ...allTrue(), [DECISION_KEYS[a]]: false, [DECISION_KEYS[b]]: false });
  }
  for (const f of inputs) {
    same(decideSubmit(f), LEGACY(f), JSON.stringify(f));
    same(decideSubmit(f, 'gate-only'), LEGACY(f), JSON.stringify(f));
    same(decideSubmit(f, undefined), LEGACY(f));
  }
  // the re-draw-only flags are unknown to gate-only: they can never be smuggled into a gate-only decision
  assert.deepEqual(decideSubmit({ ...allTrue(), redrawIsIncumbentRequest: true }), { submit: false, reasons: ['unexpected_flag:redrawIsIncumbentRequest'] });
  assert.equal('kind' in decideSubmit(allTrue()), false, 'gate-only output has no new field');
});

test('unknown policies fail closed; daily-best rejects non-objects and unknown keys', () => {
  for (const p of ['daily', 'DAILY-BEST', 'yolo', null, 1, '']) assert.deepEqual(decideSubmit(allTrue(), p), { submit: false, reasons: ['invalid_policy'], kind: null }, String(p));
  for (const v of [null, undefined, 'auto', [], 42, true]) assert.deepEqual(decideSubmit(v, 'daily-best'), { submit: false, reasons: ['invalid_decision_input'], kind: null });
  assert.deepEqual(decideSubmit({ ...redrawTrue(), approvedInSlack: true }, 'daily-best'),
    { submit: false, reasons: ['unexpected_flag:approvedInSlack'], kind: 'incumbent-redraw' });
  assert.deepEqual(decideSubmit({ ...allTrue(), approvedInSlack: true }, 'daily-best'), { submit: false, reasons: ['unexpected_flag:approvedInSlack'], kind: 'promoted' });
});

test('daily-best: the kind is chosen by gatePromote && gateReceiptVerified alone', () => {
  const cases = [[true, true, 'promoted'], [true, false, 'incumbent-redraw'], [false, true, 'incumbent-redraw'], [false, false, 'incumbent-redraw'],
    ['true', true, 'incumbent-redraw'], [true, 1, 'incumbent-redraw'], [undefined, undefined, 'incumbent-redraw']];
  for (const [promote, verified, kind] of cases) {
    const f = { ...redrawTrue(), gatePromote: promote, gateReceiptVerified: verified };
    assert.equal(decisionKind(f), kind, `${promote}/${verified}`);
    assert.equal(decideSubmit(f, 'daily-best').kind, kind);
  }
  assert.equal(decisionKind(null), 'incumbent-redraw');
});

test('daily-best, promoted kind: all DECISION_KEYS -> submit the candidate; any other single failure blocks (never falls through)', () => {
  const both = () => ({ ...allTrue(), ...redrawTrue() }); // a perfectly valid re-draw is available too
  assert.deepEqual(decideSubmit(allTrue(), 'daily-best'), { submit: true, reasons: [], kind: 'promoted' });
  assert.deepEqual(decideSubmit(both(), 'daily-best'), { submit: true, reasons: [], kind: 'promoted' });
  for (const k of DECISION_KEYS) {
    for (const bad of BAD) {
      const d = decideSubmit(withBad(both(), k, bad), 'daily-best');
      if (k === 'gatePromote' || k === 'gateReceiptVerified') { // not promoted with a verified receipt: today is a re-draw day
        assert.deepEqual(d, { submit: true, reasons: [], kind: 'incumbent-redraw' }, `${k}=${JSON.stringify(bad)}`);
        assert.equal(decideSubmit(withBad(allTrue(), k, bad), 'daily-best').submit, false, 'and without a valid re-draw nothing submits');
      } else assert.deepEqual(d, { submit: false, reasons: [k], kind: 'promoted' }, `${k}=${JSON.stringify(bad)}`);
    }
  }
});

test('daily-best, incumbent re-draw kind: every single REDRAW condition, made non-true in any way, blocks and is named', () => {
  assert.deepEqual(decideSubmit(redrawTrue(), 'daily-best'), { submit: true, reasons: [], kind: 'incumbent-redraw' });
  assert.deepEqual(decideSubmit({ ...redrawTrue(), gatePromote: false, gateReceiptVerified: true }, 'daily-best'),
    { submit: true, reasons: [], kind: 'incumbent-redraw' }, 'gate keys are allowed, just not required, for a re-draw');
  for (const k of REDRAW_KEYS) {
    for (const bad of BAD) assert.deepEqual(decideSubmit(withBad(redrawTrue(), k, bad), 'daily-best'), { submit: false, reasons: [k], kind: 'incumbent-redraw' }, `${k}=${JSON.stringify(bad)}`);
  }
  for (let a = 0; a < REDRAW_KEYS.length; a++) {
    for (let b = a + 1; b < REDRAW_KEYS.length; b++) {
      const f = { ...redrawTrue(), [REDRAW_KEYS[a]]: false, [REDRAW_KEYS[b]]: false };
      assert.deepEqual(decideSubmit(f, 'daily-best').reasons, [REDRAW_KEYS[a], REDRAW_KEYS[b]]);
    }
  }
  assert.deepEqual(decideSubmit(Object.fromEntries(REDRAW_KEYS.map(k => [k, false])), 'daily-best').reasons, [...REDRAW_KEYS]);
  assert.deepEqual(decideSubmit({}, 'daily-best'), { submit: false, reasons: [...REDRAW_KEYS], kind: 'incumbent-redraw' });
});

test('daily-best: dry-run (modeAuto not true) never submits either kind', () => {
  for (const f of [allTrue(), redrawTrue(), { ...allTrue(), ...redrawTrue() }]) {
    for (const bad of BAD) {
      const d = decideSubmit(withBad(f, 'modeAuto', bad), 'daily-best');
      assert.deepEqual([d.submit, d.reasons], [false, ['modeAuto']]);
    }
  }
});

test('REDRAW_KEYS: the shared checks plus seven re-draw-only conditions; no gate, plan or confirmation key', () => {
  assert.equal(new Set(REDRAW_KEYS).size, REDRAW_KEYS.length);
  const own = REDRAW_KEYS.filter(k => !DECISION_KEYS.includes(k));
  assert.deepEqual(own, ['redrawNotRehearsal', 'incumbentValidated', 'storedRequestIntact', 'requestRenderedForIncumbent', 'redrawIsIncumbentRequest',
    'incumbentBodyNotRejected', 'redrawCheckedToday']);
  for (const k of ['modeAuto', 'leaderboardAgreesWithIncumbent', 'requestDigestValid', 'checksForThisRequest',
    'envLaneCommitPinned', 'imagePulledAnonymously', 'openenvValidatePassed', 'exampleReplayAllTasksPassed', 'schemaEqual', 'limitsOk',
    'runDateIsToday', 'slotFree', 'notAlreadySubmitted']) assert.ok(REDRAW_KEYS.includes(k), k);
  // a body-only incumbent has no search, so darwinEvidenceIsScorecards is replaced (not dropped) by redrawNotRehearsal
  assert.ok(!REDRAW_KEYS.includes('darwinEvidenceIsScorecards'));
  assert.ok(REDRAW_REQUEST_KEYS.includes('storedRequestIntact'));
  for (const k of REDRAW_KEYS) assert.ok(!/^(gate|confirmation|candidate|plan)|requestDigestBoundInGateReceipt|imageEnvSourceMatchesPlan|pairedEvidenceUsed/.test(k), k);
  for (const k of REDRAW_REQUEST_KEYS) assert.ok(REDRAW_KEYS.includes(k), k);
  assert.match(KIND_LABELS['incumbent-redraw'], /selection on noise, not an improvement/);
  assert.match(KIND_LABELS.promoted, /promoted/);
});

// A consistent day-N re-draw: incumbent validated by the arena, its stored request intact and re-submitted with a fresh
// id and the re-draw name, every check passed today.
const IMG = 'ghcr.io/x/y@sha256:' + H('9');
const INC_ID = 'metaharness-darwin-2026-10-09-0123456789';
const INC_NAME = 'MetaHarness Darwin 2026-10-09';
function goodRedrawFacts() {
  const sha = H('7'), body = H('8'), tasks = [{ task_id: 'math_route-d2' }, { task_id: 'finance_ledger-d3' }];
  return {
    mode: 'auto', darwin: { evidence: 'evaluator_scorecards', skipped: null }, incumbent: { genomeDigest: H('1'), day1: false, submissionId: INC_ID },
    leaderboard: { hasIncumbent: true, latestValidatedId: INC_ID }, candidate: { genomeDigest: H('2') },
    gate: { promote: false, verified: true, publicKeyPinned: true },
    incumbentRecord: { state: 'validated', hasGenome: true, genomeDigest: H('1'), submissionId: INC_ID, requestSha256: H('a'), requestBodySha256: body,
      requestName: INC_NAME, lastRejected: null },
    storedRequest: { fileOk: true, problem: null, recordedSha256: H('a'), fileSha256: H('a'), canonicalSha256: H('a'), canonical: true,
      submissionId: INC_ID, name: INC_NAME, bodySha256: body, image: IMG },
    request: { sha256: sha, image: IMG, expectedImage: IMG, renderedFor: 'incumbent-redraw', source: 'stored-request', tasks,
      name: `${INC_NAME} (incumbent re-draw)`, expectedName: `${INC_NAME} (incumbent re-draw)`,
      submissionId: 'metaharness-darwin-2026-10-10-redraw-0123456789', bodySha256: body, asValidatedSha256: H('a') },
    checks: { requestSha256: sha, image: IMG, envSourceSha: H('5'), envCommit: COMMIT, envDirty: false, checkedDate: '2026-10-10',
      checks: { anonymousPull: { ok: true }, openenvValidate: { ok: true }, exampleReplay: { ok: true, taskIds: ['finance_ledger-d3', 'math_route-d2'] },
        schemaEqual: { ok: true }, limits: { ok: true } } },
    expectEnvCommit: COMMIT, dates: { run: '2026-10-10', today: '2026-10-10' }, clockToday: '2026-10-10', slot: { free: true }, alreadySubmitted: false,
    evaluatorDryRun: false,
  };
}
/** The same day for a body-only (bootstrapped, genome-less) incumbent: no search ran, nothing to promote. */
function genomeLessRedrawFacts() {
  const f = goodRedrawFacts();
  f.darwin = { evidence: 'search_skipped_incumbent_has_no_genome', skipped: 'incumbent_has_no_genome' };
  f.incumbent.genomeDigest = null;
  Object.assign(f.incumbentRecord, { hasGenome: false, genomeDigest: null });
  f.candidate = null;
  f.gate = {};
  return f;
}

test('buildDecisionFlags: gate-only emits exactly DECISION_KEYS; daily-best adds the seven re-draw keys', () => {
  assert.deepEqual(Object.keys(buildDecisionFlags(goodRedrawFacts())), [...DECISION_KEYS]);
  assert.deepEqual(Object.keys(buildDecisionFlags(goodRedrawFacts(), 'gate-only')), [...DECISION_KEYS]);
  assert.deepEqual(Object.keys(buildDecisionFlags(goodFacts())), [...DECISION_KEYS]);
  const flags = buildDecisionFlags(goodRedrawFacts(), 'daily-best');
  assert.deepEqual(Object.keys(flags), [...DECISION_KEYS, 'incumbentValidated', 'storedRequestIntact', 'requestRenderedForIncumbent',
    'redrawIsIncumbentRequest', 'incumbentBodyNotRejected', 'redrawCheckedToday', 'redrawNotRehearsal']);
  assert.deepEqual(decideSubmit(buildDecisionFlags(genomeLessRedrawFacts(), 'daily-best'), 'daily-best'), { submit: true, reasons: [], kind: 'incumbent-redraw' },
    'a body-only incumbent re-draws without any search');
  assert.ok(REDRAW_KEYS.every(k => flags[k] === true), JSON.stringify(flags));
  assert.deepEqual(decideSubmit(flags, 'daily-best'), { submit: true, reasons: [], kind: 'incumbent-redraw' });
  // the candidate's facts under daily-best still decide the promoted kind exactly as gate-only does
  const promoted = buildDecisionFlags(goodFacts(), 'daily-best');
  assert.deepEqual(decideSubmit(promoted, 'daily-best'), { submit: true, reasons: [], kind: 'promoted' });
  assert.deepEqual(decideSubmit(buildDecisionFlags({}, 'daily-best'), 'daily-best'), { submit: false, reasons: [...REDRAW_KEYS], kind: 'incumbent-redraw' });
});

test('buildDecisionFlags daily-best: each raw-fact defect of a re-draw maps to its condition', () => {
  const cases = [
    ['modeAuto', f => { f.mode = 'dry-run'; }],
    ['leaderboardAgreesWithIncumbent', f => { f.leaderboard.latestValidatedId = 'someone-validated-later'; }],
    ['leaderboardAgreesWithIncumbent', f => { delete f.leaderboard.latestValidatedId; }],
    ['redrawNotRehearsal', f => { f.darwin.evidence = 'evaluator_dry_run_fake_rows_not_model_rollouts'; }],
    ['redrawNotRehearsal', f => { f.darwin.skipped = 'incumbent_has_no_genome'; f.darwin.evidence = null; }], // skipped, but the incumbent HAS a genome
    // (a) the incumbent must itself have been accepted + validated by the arena, and still be on disk as such
    ['incumbentValidated', f => { f.incumbent.day1 = true; }],
    ['incumbentValidated', f => { f.incumbentRecord = null; }],
    ['incumbentValidated', f => { f.incumbentRecord.state = 'validating'; }],
    ['incumbentValidated', f => { f.incumbentRecord.genomeDigest = H('3'); }],
    ['incumbentValidated', f => { f.incumbentRecord.genomeDigest = null; }], // a record whose genome no longer hashes to its digest
    ['incumbentValidated', f => { f.incumbentRecord.submissionId = 'moved-since-this-run-loaded-it'; }],
    // (b) the stored copy is the exact validated request: file facts, both digests, id, name and body all bound to the record
    ['storedRequestIntact', f => { f.storedRequest = null; }], // no stored copy recorded
    ['storedRequestIntact', f => { f.storedRequest.fileOk = false; }], // missing, moved, symlinked, perms or owner changed
    ['storedRequestIntact', f => { f.storedRequest.canonical = false; }],
    ['storedRequestIntact', f => { f.storedRequest.fileSha256 = H('6'); }], // tampered bytes
    ['storedRequestIntact', f => { f.storedRequest.canonicalSha256 = H('6'); }],
    ['storedRequestIntact', f => { f.storedRequest.recordedSha256 = H('6'); }], // the record points at another stored copy
    ['storedRequestIntact', f => { f.storedRequest.submissionId = 'another-submission'; }], // a body of a different submission_id
    ['storedRequestIntact', f => { f.storedRequest.name = 'another name'; }],
    ['storedRequestIntact', f => { f.storedRequest.bodySha256 = H('6'); }],
    ['storedRequestIntact', f => { f.incumbentRecord.requestName = null; }],
    // the request is the stored one, for ITS image, under the re-draw name and a fresh id
    ['requestRenderedForIncumbent', f => { f.request.renderedFor = 'candidate'; }], // the wrong request fed for the kind
    ['requestRenderedForIncumbent', f => { f.request.renderedFor = 'needs-human'; }],
    ['requestRenderedForIncumbent', f => { f.request.source = null; }], // not built from the stored request
    ['requestRenderedForIncumbent', f => { f.request.expectedImage = 'ghcr.io/x/y@sha256:' + H('6'); }],
    ['requestRenderedForIncumbent', f => { f.request.expectedImage = null; }], // stored request unreadable
    ['requestRenderedForIncumbent', f => { f.request.name = INC_NAME; }], // the validated name, not the re-draw name
    ['requestRenderedForIncumbent', f => { f.request.submissionId = INC_ID; }], // not a fresh id
    ['requestRenderedForIncumbent', f => { f.request.submissionId = null; }],
    // re-draw = the validated request again, byte for byte apart from submission_id and name
    ['redrawIsIncumbentRequest', f => { f.request.bodySha256 = H('6'); }],
    ['redrawIsIncumbentRequest', f => { delete f.incumbentRecord.requestBodySha256; }], // a record without the body digest
    ['redrawIsIncumbentRequest', f => { f.request.bodySha256 = null; f.incumbentRecord.requestBodySha256 = null; }],
    ['redrawIsIncumbentRequest', f => { f.storedRequest = null; }],
    // ... and the body digest is bound to the bytes the arena validated: body + validated id/name reproduce requestSha256
    ['redrawIsIncumbentRequest', f => { f.request.asValidatedSha256 = H('6'); }], // a hand-written body digest of another body
    ['redrawIsIncumbentRequest', f => { f.request.asValidatedSha256 = null; }], // a record without requestName
    ['redrawIsIncumbentRequest', f => { delete f.incumbentRecord.requestSha256; }],
    // the arena rejected this body since it was validated (author origin): never POSTed again without a human
    ['incumbentBodyNotRejected', f => { f.incumbentRecord.lastRejected = { submissionId: 'r', requestBodySha256: H('8') }; }],
    ['incumbentBodyNotRejected', f => { f.incumbentRecord.lastRejected = { submissionId: 'r', requestBodySha256: null }; }], // digest unknown
    ['incumbentBodyNotRejected', f => { f.incumbentRecord.lastRejected = true; }], // malformed
    ['incumbentBodyNotRejected', f => { f.incumbentRecord = null; }],
    // every check, today, on this request
    ['redrawCheckedToday', f => { f.checks.checkedDate = '2026-10-09'; }], // yesterday's check report
    ['redrawCheckedToday', f => { f.checks.checkedDate = null; }],
    ['redrawCheckedToday', f => { f.clockToday = '2026-10-12'; }], // a stale --now: run date and checks agree, the clock does not
    ['redrawCheckedToday', f => { delete f.clockToday; }],
    ['checksForThisRequest', f => { f.checks.image = 'ghcr.io/x/z@sha256:' + H('9'); }],
    ['envLaneCommitPinned', f => { f.checks.envDirty = true; }],
    ['envLaneCommitPinned', f => { f.expectEnvCommit = null; }],
    ['imagePulledAnonymously', f => { f.checks.checks.anonymousPull.ok = 'yes'; }],
    ['openenvValidatePassed', f => { delete f.checks.checks.openenvValidate; }],
    ['schemaEqual', f => { f.checks.checks.schemaEqual = { ok: false }; }],
    ['limitsOk', f => { f.checks.checks.limits = true; }],
    ['exampleReplayAllTasksPassed', f => { f.checks.checks.exampleReplay.taskIds = ['math_route-d2']; }],
    ['runDateIsToday', f => { f.dates.today = '2026-10-11'; }],
    ['slotFree', f => { f.slot = { free: 'true' }; }],
    ['notAlreadySubmitted', f => { f.alreadySubmitted = true; }],
  ];
  for (const [key, mutate] of cases) {
    const f = goodRedrawFacts();
    mutate(f);
    const d = decideSubmit(buildDecisionFlags(f, 'daily-best'), 'daily-best');
    assert.equal(d.submit, false, key);
    assert.equal(d.kind, 'incumbent-redraw', key);
    assert.ok(d.reasons.includes(key), `${key}: got ${d.reasons}`);
  }
  const f = goodRedrawFacts();
  f.request.sha256 = 'not-a-digest';
  assert.deepEqual(decideSubmit(buildDecisionFlags(f, 'daily-best'), 'daily-best').reasons, ['requestDigestValid', 'checksForThisRequest']);
  const yesterday = goodRedrawFacts(); // a resumed run on a later day: both the date and the check date block
  yesterday.dates.today = '2026-10-11';
  assert.deepEqual(decideSubmit(buildDecisionFlags(yesterday, 'daily-best'), 'daily-best').reasons, ['redrawCheckedToday', 'runDateIsToday']);
});

test('buildDecisionFlags daily-best, body-only incumbent: no genome is never mistaken for a genome; a dry-run evaluator never re-draws', () => {
  const decide = mutate => { const f = genomeLessRedrawFacts(); mutate(f); return decideSubmit(buildDecisionFlags(f, 'daily-best'), 'daily-best'); };
  const cases = [
    [f => { f.evaluatorDryRun = true; }, ['redrawNotRehearsal']], // an evaluator.dryRun config never submits, search or not
    [f => { f.evaluatorDryRun = null; }, ['redrawNotRehearsal']],
    [f => { f.darwin.skipped = null; }, ['redrawNotRehearsal']],
    [f => { f.incumbentRecord.hasGenome = true; }, ['redrawNotRehearsal', 'incumbentValidated']], // a genome appeared on disk since the run loaded it
    [f => { f.incumbentRecord.genomeDigest = H('1'); }, ['incumbentValidated']],
    [f => { f.incumbent.genomeDigest = H('1'); }, ['redrawNotRehearsal', 'incumbentValidated']], // run loaded a genome, record has none
  ];
  for (const [m, reasons] of cases) assert.deepEqual(decide(m), { submit: false, reasons, kind: 'incumbent-redraw' }, String(m));
  // the promoted path can never be taken over a body-only incumbent: no candidate digest can differ from / match a missing genome
  const promoted = { ...goodFacts(), incumbent: { ...goodFacts().incumbent, genomeDigest: null } };
  const d = decideSubmit(buildDecisionFlags(promoted, 'daily-best'), 'daily-best');
  assert.equal(d.kind, 'promoted');
  for (const k of ['candidateDiffersFromIncumbent', 'candidateMatchesPlan']) assert.ok(d.reasons.includes(k), `${k}: ${d.reasons}`);
});

test('buildDecisionFlags daily-best: binding, rejection and clock conditions name exactly themselves; gate-only ignores their facts', () => {
  const decide = mutate => { const f = goodRedrawFacts(); mutate(f); return decideSubmit(buildDecisionFlags(f, 'daily-best'), 'daily-best'); };
  const exact = [
    [f => { f.request.asValidatedSha256 = H('6'); }, ['redrawIsIncumbentRequest']],
    [f => { f.incumbentRecord.requestSha256 = 'not-hex'; }, ['storedRequestIntact', 'redrawIsIncumbentRequest']],
    [f => { f.storedRequest.fileOk = false; }, ['storedRequestIntact']],
    [f => { f.incumbentRecord.lastRejected = { submissionId: 'r', date: '2026-10-10', errorOrigin: null, requestBodySha256: H('8') }; }, ['incumbentBodyNotRejected']],
    [f => { f.incumbentRecord.lastRejected = { submissionId: 'r' }; }, ['incumbentBodyNotRejected']],
    [f => { f.clockToday = '2026-10-12'; }, ['redrawCheckedToday']],
    [f => { f.clockToday = null; }, ['redrawCheckedToday']],
  ];
  for (const [m, reasons] of exact) assert.deepEqual(decide(m), { submit: false, reasons, kind: 'incumbent-redraw' }, String(m));
  // a recorded rejection of ANOTHER body (e.g. before a human reconciled the record) does not block this one; none at all is fine
  for (const lastRejected of [{ submissionId: 'r', requestBodySha256: H('c') }, null, undefined]) {
    assert.deepEqual(decide(f => { f.incumbentRecord.lastRejected = lastRejected; }), { submit: true, reasons: [], kind: 'incumbent-redraw' });
  }
  // gate-only never reads them: the same defects leave its flags byte-identical
  const base = goodFacts();
  for (const [m] of exact) {
    const f = { ...goodFacts(), incumbentRecord: goodRedrawFacts().incumbentRecord, storedRequest: goodRedrawFacts().storedRequest, clockToday: '2026-10-10' };
    m(f);
    assert.deepEqual(buildDecisionFlags(f), buildDecisionFlags(base));
    assert.deepEqual(buildDecisionFlags(f, 'gate-only'), buildDecisionFlags(base));
  }
});
