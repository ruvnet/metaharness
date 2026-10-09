// flywheel.mjs policy paths with full fakes (no GPU, network, docker or token):
// dry-run never POSTs; auto submits only when EVERY condition holds; each single failing condition blocks;
// day 1 without a win renders a needs-human request for the v2 defaults; the incumbent moves only on `validated`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFlywheel } from '../flywheel.mjs';
import { baselineGenome, FAMILIES } from '../../lib/cells.mjs';
import { canonicalDigest } from '../canonical-json.mjs';
import { candidateOf, makeFakes, setup, startOf } from './fw-fakes.mjs';

const DATE = '2026-10-09';
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
// auto = config.json says auto (the --mode flag alone can only downgrade); --now is 10:17 Toronto on --date.
async function run(fakeOpts = {}, { mode, date = DATE, env } = {}) {
  const e = env ?? setup();
  if (mode === 'auto') e.config.mode = 'auto';
  const f = makeFakes({ stateDirFn: () => e.stateDir, ...fakeOpts, journalPath: () => join(e.stateDir, 'journal.jsonl') });
  const st = await runFlywheel({ config: e.config, date, now: startOf(date), mode, stateDir: e.stateDir, deps: f.deps });
  return { st, ...f, ...e };
}

test('dry-run (the default) never POSTs, even when every other condition holds', async () => {
  const { st, calls, stateDir } = await run();
  assert.equal(st.mode, 'dry-run');
  assert.equal(calls.submit.length, 0);
  assert.deepEqual(st.decision, { submit: false, reasons: ['modeAuto'] });
  assert.equal(st.wouldSubmitInAuto, true);
  assert.equal(st.outcome, 'skipped');
  assert.deepEqual(calls.down, [4243], 'gpu torn down exactly once');
  assert.ok(existsSync(join(stateDir, 'reports', DATE, 'report.md')) && existsSync(join(stateDir, 'reports', DATE, 'status.json')));
  assert.equal(existsSync(join(stateDir, 'incumbent.json')), false);
  assert.equal(existsSync(join(stateDir, 'flywheel.lock')), false, 'lock released');
});

test('auto submits exactly once when every condition holds; incumbent updates only after `validated`', async () => {
  const { st, calls, stateDir } = await run({ statusSeq: ['validating', 'validated'] }, { mode: 'auto' });
  assert.deepEqual(st.decision, { submit: true, reasons: [] });
  assert.equal(calls.submit.length, 1);
  const sub = calls.submit[0];
  assert.equal(sub.approvedSha256, canonicalDigest(sub.request), 'POSTs exactly the approved bytes');
  assert.equal(sub.approvedSha256, st.request.requestSha256);
  assert.equal(sub.request.tasks.find(t => t.task_id.startsWith('software_change')).task_id, 'software_change-d3', 'the candidate, not the incumbent');
  assert.equal(st.outcome, 'submitted-validated');
  assert.deepEqual(calls.sleep, [60_000], 'polled once after `validating`');
  assert.deepEqual(readJson(join(stateDir, 'incumbent.json')).genome, candidateOf(baselineGenome()));
  assert.equal(existsSync(join(stateDir, 'pending-submission.json')), false);
  // The gate saw the search report (selection context), the confirmation cards, the paired outcomes, the
  // preregistered alpha split and the request digest it was asked to bind.
  assert.equal(calls.gate[0].requestSha256, st.request.requestSha256);
  assert.equal(calls.gate[0].runPath, join(stateDir, 'runs', DATE, 'darwin-1', 'reports', 'darwin-run.json'));
  assert.equal(calls.gate[0].runPath, calls.search[0].workRoot + '/reports/darwin-run.json', 'the search this candidate came from');
  assert.match(calls.gate[0].candidatePath, /confirm\/candidate-card\.json$/);
  assert.ok(calls.gate[0].pairedPath);
  assert.equal(calls.gate[0].candidateBudget, 7, 'config null -> the search evaluated count, as gate.mjs v2 defaults');
  assert.equal(st.confirmation.candidateBudget, 7);
  assert.deepEqual(JSON.parse(readFileSync(calls.gate[0].pairedPath, 'utf8')).map(p => p.itemId),
    ['software_change:d2b8192->d3b8192@seed2028100', 'software_change:d2b8192->d3b8192@seed2028104'], 'Darwin pairing: changed cell only');
  assert.deepEqual([calls.status, calls.standing, calls.recover], [1, ['ruv'], 1], 'public board read and ledger sweep in preflight');
  assert.equal(st.incumbent.boardAgrees, true);
});

test('leaderboard disagrees with local state: no GPU, no search; unknown standing only blocks the submit', async () => {
  const a = await run({ boardHasIncumbent: true }, { mode: 'auto' }); // local day 1, but the board lists ruv
  assert.equal(a.st.outcome, 'incumbent-mismatch');
  assert.deepEqual([a.calls.up.length, a.calls.search.length, a.calls.submit.length], [0, 0, 0]);
  assert.ok(a.st.notes.some(n => n.includes('disagrees with the public leaderboard')));
  const b = await run({ boardHasIncumbent: 'throw', statusThrows: true }, { mode: 'auto' });
  assert.equal(b.st.arena.hasIncumbent, null);
  assert.match(b.st.arena.error, /status: arena down; leaderboard: leaderboard unreachable/);
  assert.deepEqual(b.st.decision.reasons, ['leaderboardAgreesWithIncumbent']);
  assert.equal(b.calls.submit.length, 0);
  // adv 9: the board agrees (no entry) but the account's own GET /submissions shows a validated submission
  const c = await run({ latestValidatedId: 'metaharness-manual-1' }, { mode: 'auto' });
  assert.equal(c.st.outcome, 'incumbent-mismatch');
  assert.deepEqual([c.calls.up.length, c.calls.submit.length], [0, 0]);
});

test('adv 9: day N agrees only when the latest validated own submission IS the local incumbent', async () => {
  const env = setup({ poll: { attempts: 1 } });
  const a = await run({ statusSeq: ['validated'] }, { mode: 'auto', env });
  assert.equal(a.st.outcome, 'submitted-validated');
  const incId = readJson(join(env.stateDir, 'incumbent.json')).submissionId;
  const ok = await run({ noCandidate: true }, { mode: 'auto', env, date: '2026-10-10' });
  assert.equal(ok.st.incumbent.boardAgrees, true);
  assert.equal(ok.st.arena.latestValidatedId, incId);
  // the board lists ruv (any entry), but the newest validated own submission is not ours: mismatch, nothing rented
  const bad = await run({ latestValidatedId: 'metaharness-manual-2' }, { mode: 'auto', env, date: '2026-10-11' });
  assert.equal(bad.st.outcome, 'incumbent-mismatch');
  assert.deepEqual([bad.calls.up.length, bad.calls.submit.length], [0, 0]);
});

test('accepted but still validating: pending kept, incumbent unchanged; the next day reconciles and searches from it', async () => {
  const env = setup({ poll: { attempts: 1 } });
  const a = await run({ statusSeq: ['validating'] }, { mode: 'auto', env });
  assert.equal(a.st.outcome, 'submitted-pending');
  assert.equal(existsSync(join(env.stateDir, 'incumbent.json')), false);
  assert.equal(readJson(join(env.stateDir, 'pending-submission.json')).state, 'validating');
  const b = await run({ statusSeq: ['validated'], noCandidate: true }, { mode: 'auto', date: '2026-10-10', env });
  assert.equal(b.calls.submit.length, 0);
  assert.deepEqual(b.calls.search[0].incumbentGenome, candidateOf(baselineGenome()), 'day 2 searches from the validated submission');
  assert.equal(b.st.incumbent.day1, false);
  assert.equal(b.st.outcome, 'no-candidate', 'day N without a better candidate: no needs-human request');
  assert.equal(b.st.needsHuman, undefined);
});

const SINGLE_FAILURES = [
  ['darwin evidence is a dry run', { evidence: 'evaluator_dry_run_fake_rows_not_model_rollouts' }, 'darwinEvidenceIsScorecards'],
  ['gate refuses', { gatePromote: false }, 'gatePromote'],
  ['receipt does not verify', { verifyOk: false }, 'gateReceiptVerified'],
  ['receipt key not pinned', { pinned: false }, 'gatePublicKeyPinned'],
  ['receipt names another candidate card', { receiptCandidateDigest: '0'.repeat(64) }, 'gateCandidateDigestMatches'],
  ['receipt names another baseline card', { receiptBaselineDigest: '0'.repeat(64) }, 'gateBaselineDigestMatches'],
  ['gate.mjs cannot bind the request digest (today)', { binding: false }, 'requestDigestBoundInGateReceipt'],
  ['receipt binds a different request', { bindWrong: true }, 'requestDigestBoundInGateReceipt'],
  ['receipt paired digest is not ours', { pairedDigestWrong: true }, 'pairedEvidenceUsed'],
  ['receipt tested at another alpha split than preregistered', { receiptBudget: 1 }, 'gateConfigMatchesPlan'],
  ['receipt tested at another alpha than preregistered', { receiptAlpha: 0.5 }, 'gateConfigMatchesPlan'],
  ['receipt tested at another lambda than preregistered', { receiptLambda: 0.9 }, 'gateConfigMatchesPlan'],
  ['the gate pin rotated after the gate ran (re-verified at decision time)', { pinNow: () => 'MCowBQYDK2VwAyEA' + 'B'.repeat(44) }, 'gatePublicKeyPinned'],
  ['env lane worktree at another commit', { envCommit: 'f'.repeat(40) }, 'envLaneCommitPinned'],
  ['env lane worktree dirty', { envDirty: true }, 'envLaneCommitPinned'],
  ['image env source differs from what the confirmation measured', { imageEnvSourceSha: '9'.repeat(64) }, 'imageEnvSourceMatchesPlan'],
  ['own submissions list unreadable (latest validated unknown)', { ownListUnknown: true }, 'leaderboardAgreesWithIncumbent'],
  ['leaderboard standing unreadable', { boardHasIncumbent: 'throw' }, 'leaderboardAgreesWithIncumbent'],
  // Darwin's pairing refuses cards whose provenance differs, so no paired evidence exists either
  ['confirmation provenance differs from the plan', { cardProvenanceTweak: true }, ['confirmationProvenanceMatchesPlan', 'pairedEvidenceUsed']],
  ['confirmation cards came from dry-run rows', { cardsDryRun: true }, 'confirmationNotDryRun'],
  ['confirmation card measured other cells', { cardWrongCells: true }, 'confirmationCardsMatchGenomes'],
  ['anonymous pull failed', { failCheck: 'pull' }, 'imagePulledAnonymously'],
  ['openenv validate failed', { failCheck: 'openenv_validate' }, 'openenvValidatePassed'],
  ['schema differs', { failCheck: 'schema' }, 'schemaEqual'],
  ['limits violated', { failCheck: 'limits' }, 'limitsOk'],
  ['example replay failed', { failCheck: 'replay' }, 'exampleReplayAllTasksPassed'],
  ['replay skipped one task id', { replayDropTask: true }, 'exampleReplayAllTasksPassed'],
  ['checks ran on another image', { checksImage: 'ghcr.io/ruvnet/other@sha256:' + '3'.repeat(64) }, 'checksForThisRequest'],
  ['rendered tasks differ from the candidate', { mutateTasks: true }, 'requestRenderedForCandidate'],
  ['rendered image differs from config', { renderImage: 'ghcr.io/ruvnet/other@sha256:' + '4'.repeat(64) }, 'requestRenderedForCandidate'],
  ['slot taken between preflight and decision', { slotSeq: [true, false] }, 'slotFree'],
  ['slot unreadable at decision', { slotSeq: [true, 'throw'] }, 'slotFree'],
];

// every report-derived fact (incl. the env lane commit and the image env source) is gated on the WHOLE report being ok
const CHECK_FLAGS = ['envLaneCommitPinned', 'imageEnvSourceMatchesPlan', 'imagePulledAnonymously', 'openenvValidatePassed',
  'exampleReplayAllTasksPassed', 'schemaEqual', 'limitsOk'];
for (const [name, opts, reason] of SINGLE_FAILURES) {
  test(`auto mode, one failing condition blocks: ${name}`, async () => {
    const { st, calls } = await run(opts, { mode: 'auto' });
    assert.equal(calls.submit.length, 0, 'never POSTed');
    assert.equal(st.decision.submit, false);
    if (opts.failCheck) { // render-and-check's toDecisionFacts gates every check on the whole report being ok
      assert.ok(st.decision.reasons.includes(reason), `expected ${reason} in ${st.decision.reasons}`);
      assert.ok(st.decision.reasons.every(r => CHECK_FLAGS.includes(r)), String(st.decision.reasons));
    } else assert.deepEqual(st.decision.reasons, [reason].flat(), 'exactly this condition failed');
    assert.equal(calls.down.length, 1, 'gpu torn down exactly once');
    assert.ok(['skipped', 'needs-human'].includes(st.outcome), st.outcome);
  });
}

test('an unresolved submission from an earlier day blocks a new one (notAlreadySubmitted)', async () => {
  const env = setup({ poll: { attempts: 0 } });
  await run({ statusSeq: ['validating'] }, { mode: 'auto', env });
  const b = await run({ statusSeq: ['validating'] }, { mode: 'auto', date: '2026-10-10', env });
  assert.equal(b.calls.submit.length, 0);
  assert.ok(b.st.decision.reasons.includes('notAlreadySubmitted'));
});

test('day 1: Darwin cannot beat the v2 defaults -> needs-human request for them, never POSTed (auto mode)', async () => {
  const { st, calls, stateDir } = await run({ noCandidate: true }, { mode: 'auto' });
  assert.equal(st.outcome, 'needs-human');
  assert.equal(calls.submit.length, 0);
  assert.equal(calls.evaluate.length, 0, 'no candidate, no confirmation rollouts');
  assert.ok(st.decision.reasons.includes('candidatePresent'));
  const req = readJson(st.needsHuman.requestPath);
  assert.ok(st.needsHuman.requestPath.startsWith(join(stateDir, 'runs', DATE, 'needs-human')));
  assert.deepEqual(req.tasks.map(t => t.task_id), FAMILIES.map(f => `${f}-d2`));
  assert.ok(req.tasks.every(t => t.completion_tokens === 8192 && t.context_tokens === 16384));
  assert.match(st.needsHuman.submissionId, /^metaharness-darwin-2026-10-09-v2-[0-9a-f]{10}$/);
  assert.match(readFileSync(st.files.markdownPath, 'utf8'), /Needs-human request \(v2 defaults\)/);
});

test('day 1: a candidate the gate refuses -> needs-human for the v2 defaults plus the rendered candidate', async () => {
  const { st, calls } = await run({ gatePromote: false }, { mode: 'auto' });
  assert.equal(st.outcome, 'needs-human');
  assert.equal(calls.submit.length, 0);
  assert.equal(calls.render.length, 2);
  assert.equal(st.request.renderedFor, 'candidate');
  assert.equal(st.needsHuman.renderedFor, 'needs-human');
});

test('preregistration: plan hash journaled before any confirmation rollout; both arms share one fresh seed block', async () => {
  const { st, calls, stateDir } = await run();
  const journal = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const reg = journal.find(e => e.phase === 'confirm-plan' && e.event === 'registered');
  assert.equal(reg.planHash, st.confirmation.planHash);
  assert.equal(reg.planHash, canonicalDigest(readJson(join(stateDir, 'runs', DATE, 'confirm', 'plan.json'))));
  for (const c of calls.evaluate) assert.ok(c.journalAtCall.includes(reg.planHash), 'plan hash was on disk before the rollout started');
  assert.deepEqual(calls.evaluate.map(c => [c.variantId, c.seedBase, c.attempts]), [['incumbent', 2_028_100, 8], ['candidate', 2_028_100, 8]]);
  assert.equal(st.confirmation.preregistered, true);
  assert.equal(st.confirmation.power.reachable, false, 'reported: 8 attempts x 1 changed family cannot reach e >= 7/0.05');
  assert.deepEqual([st.confirmation.power.needed, st.confirmation.power.maxDiscordant], [13, 2]);
  assert.ok(st.notes.some(n => n.includes('cannot reach significance')));
});
