// decideSubmit is the ONLY place a submission is allowed; exhaustively check that every condition is load-bearing.
// Run: node --experimental-strip-types --test integrations/openenv-arena-darwin/flywheel/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionFlags, DECISION_KEYS, decideSubmit, replayCoversRequest } from '../decide.mjs';

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
