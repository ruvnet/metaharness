// config.policy "daily-best" with full fakes (no GPU, network, docker or token): a promoted candidate is submitted as
// today; otherwise the arena-validated incumbent's request is re-drawn (fresh submission_id, every check again today);
// day 1 stays needs-human; every single failing condition blocks; dry-run never POSTs; a re-draw never changes the
// incumbent genome; "gate-only" (the default) is unchanged on the same scenarios.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { baselineGenome, genomeToCells } from '../../lib/cells.mjs';
import { canonicalDigest, canonicalJson } from '../canonical-json.mjs';
import { DECISION_KEYS, REDRAW_REQUEST_KEYS } from '../decide.mjs';
import { loadConfig } from '../flywheel-config.mjs';
import { runFlywheel } from '../flywheel.mjs';
import { loadIncumbent, recordRedraw, recordRedrawRejected, requestBodyDigest, storeRequest, writeIncumbent } from '../incumbent.mjs';
import { redrawFacts } from '../recheck.mjs';
import { renderMarkdown, renderSlack } from '../report.mjs';
import { candidateOf, ENV_COMMIT, makeFakes, setup, startOf } from './fw-fakes.mjs';

const D1 = '2026-10-09', D2 = '2026-10-10', D3 = '2026-10-11', D4 = '2026-10-12', D5 = '2026-10-13', D6 = '2026-10-14';
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const journalOf = stateDir => readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const OTHER_IMAGE = 'ghcr.io/ruvnet/metaharness-arena@sha256:' + '7'.repeat(64);
const REPORT = new URL('../report.mjs', import.meta.url).pathname;

/** One tick. auto = config.json says auto (the --mode flag alone can only downgrade); the fake clock follows `date`. */
async function run(fakeOpts = {}, { mode = 'auto', date = D1, now, env = setup(), policy = 'daily-best' } = {}) {
  env.config.policy = policy;
  if (mode === 'auto') env.config.mode = 'auto';
  const f = makeFakes({ stateDirFn: () => env.stateDir, start: startOf(date), ...fakeOpts });
  const st = await runFlywheel({ config: env.config, date, now: now ?? startOf(date), mode, stateDir: env.stateDir, deps: f.deps });
  return { st, ...f, ...env };
}

let TEMPLATE = null;
/** A fresh env whose state holds day 1: a promoted candidate, POSTed and validated (incumbent.json = that candidate). */
async function dayN() {
  if (!TEMPLATE) {
    const env = setup({ poll: { attempts: 1 } });
    const r = await run({ statusSeq: ['validated'] }, { env });
    assert.equal(r.st.outcome, 'submitted-validated');
    TEMPLATE = { stateDir: env.stateDir, posted: r.calls.submit[0].request };
  }
  const env = setup({ poll: { attempts: 1 } });
  cpSync(TEMPLATE.stateDir, env.stateDir, { recursive: true });
  return { env, posted: TEMPLATE.posted, incumbent: readJson(join(env.stateDir, 'incumbent.json')) };
}

test('config: policy defaults to gate-only; daily-best is accepted in dry-run and auto; unknown values are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-policy-'));
  const write = obj => { const p = join(dir, `${Math.random()}.json`); writeFileSync(p, JSON.stringify(obj)); return p; };
  assert.equal(loadConfig(join(dir, 'missing.json'), { home: dir }).policy, 'gate-only');
  assert.deepEqual(['mode', 'policy'].map(k => loadConfig(write({ policy: 'daily-best' }), { home: dir })[k]), ['dry-run', 'daily-best']);
  assert.equal(loadConfig(write({ policy: 'daily-best', mode: 'auto', checks: { expectEnvCommit: ENV_COMMIT } }), { home: dir }).mode, 'auto');
  for (const policy of ['daily', 'best', 'gate', 'Daily-Best', 'auto', '', null, 1, true, ['daily-best'], { daily: 1 }]) {
    assert.throws(() => loadConfig(write({ policy }), { home: dir }), /policy must be one of "gate-only", "daily-best"/, JSON.stringify(policy));
  }
  // the policy never relaxes the mode rules: auto still needs the pinned env lane commit
  assert.throws(() => loadConfig(write({ policy: 'daily-best', mode: 'auto' }), { home: dir }), /mode "auto" requires checks\.expectEnvCommit/);
});

test('incumbent records: the body digest ignores only submission_id and name; a re-draw moves the pointer, never the genome', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-redraw-rec-'));
  const req = { submission_id: 'a', name: 'n', image: 'i', tasks: [{ task_id: 't' }] };
  assert.equal(requestBodyDigest(req), requestBodyDigest({ ...req, submission_id: 'b', name: 'other' }));
  for (const o of [{ image: 'j' }, { extra: 1 }, { tasks: [] }]) assert.notEqual(requestBodyDigest(req), requestBodyDigest({ ...req, ...o }));
  for (const bad of [null, [], 'x']) assert.throws(() => requestBodyDigest(bad));
  const g = candidateOf(baselineGenome());
  const rec = o => ({ genome: g, submissionId: 's2', requestSha256: 'b'.repeat(64), requestBodySha256: 'c'.repeat(64), date: D2, state: 'validated', ...o });
  assert.throws(() => recordRedraw(dir, rec()), /never replaces the incumbent genome/, 'no validated incumbent (day 1): nothing to re-draw');
  writeIncumbent(dir, { genome: g, submissionId: 's1', requestSha256: 'a'.repeat(64), requestBodySha256: 'c'.repeat(64), date: D1, state: 'validated' });
  const first = readFileSync(join(dir, 'incumbent.json'), 'utf8');
  assert.throws(() => recordRedraw(dir, rec({ genome: baselineGenome() })), /never replaces the incumbent genome/);
  assert.throws(() => recordRedraw(dir, rec({ state: 'validating' })), /validated/);
  assert.equal(readFileSync(join(dir, 'incumbent.json'), 'utf8'), first, 'nothing written on a refusal');
  recordRedraw(dir, rec());
  recordRedraw(dir, rec({ submissionId: 's3', date: D3 }));
  const now = readJson(join(dir, 'incumbent.json'));
  assert.deepEqual([now.submissionId, now.date, now.genomeDigest, now.lastKind, now.state], ['s3', D3, canonicalDigest(g), 'incumbent-redraw', 'validated']);
  assert.deepEqual(now.genome, g);
  assert.deepEqual(now.genomeFrom, { submissionId: 's1', date: D1 }, 'the submission that set the genome survives re-draws');
  assert.equal(loadIncumbent(dir, { baselineGenome, genomeToCells }).submissionId, 's3');
  // a rejected re-draw adds only lastRejected; a later validated record (writeIncumbent / recordRedraw) is written fresh
  assert.equal(recordRedrawRejected(mkdtempSync(join(tmpdir(), 'fw-rej-')), { submissionId: 's4', date: D3 }), null, 'no incumbent: nothing to block');
  recordRedrawRejected(dir, { submissionId: 's4', date: D3, errorOrigin: 'author', requestBodySha256: 'c'.repeat(64) });
  const { lastRejected, ...rest } = readJson(join(dir, 'incumbent.json'));
  assert.deepEqual(lastRejected, { submissionId: 's4', date: D3, errorOrigin: 'author', requestBodySha256: 'c'.repeat(64) });
  assert.deepEqual(rest, now, 'nothing else changed');
  writeIncumbent(dir, { genome: baselineGenome(), submissionId: 's5', requestSha256: 'd'.repeat(64), requestName: 'n5', date: D3, state: 'validated' });
  assert.equal('lastRejected' in readJson(join(dir, 'incumbent.json')), false, 'a validated promoted candidate clears it');
});

test('daily-best, promoted candidate: submitted as kind "promoted" exactly as under gate-only; labelled in journal and report', async () => {
  const env = setup({ poll: { attempts: 1 } });
  const r = await run({ statusSeq: ['validated'] }, { env });
  assert.deepEqual(r.st.decision, { submit: true, reasons: [], kind: 'promoted' });
  assert.deepEqual([r.st.outcome, r.st.policy, r.st.redraw, r.calls.submit.length], ['submitted-validated', 'daily-best', undefined, 1]);
  const posted = r.calls.submit[0].request;
  assert.equal(posted.tasks.find(t => t.task_id.startsWith('software_change')).task_id, 'software_change-d3', 'the candidate');
  const inc = readJson(join(env.stateDir, 'incumbent.json'));
  assert.deepEqual(inc.genome, candidateOf(baselineGenome()), 'a promoted candidate replaces the incumbent genome once validated');
  assert.equal(inc.requestBodySha256, requestBodyDigest(posted), 'what a later re-draw must reproduce');
  assert.deepEqual([inc.requestSha256, inc.requestName], [canonicalDigest(posted), posted.name], 'the POSTed bytes, rebuildable from the body');
  const j = journalOf(env.stateDir);
  const decided = j.find(e => e.phase === 'decide' && e.event === 'done');
  assert.deepEqual([decided.policy, decided.kind, j.find(e => e.event === 'intent').kind], ['daily-best', 'promoted', 'promoted']);
  assert.ok(j.some(e => e.phase === 'incumbent' && e.event === 'updated'));
  const md = readFileSync(r.st.files.markdownPath, 'utf8');
  assert.match(md, /- Policy: `daily-best`/);
  assert.match(md, /Kind: \*\*promoted\*\*/);
  assert.match(renderMarkdown(readJson(r.st.files.statusPath)), /SUBMITTED-VALIDATED, promoted candidate/);
});

test('daily-best, day N, gate refuses: the validated incumbent is re-drawn (fresh id, same body); only the pointer moves', async () => {
  const { env, posted, incumbent: before } = await dayN();
  const r = await run({ gatePromote: false, statusSeq: ['validated'] }, { env, date: D2 });
  assert.deepEqual(r.st.decision, { submit: true, reasons: [], kind: 'incumbent-redraw' });
  assert.equal(r.st.outcome, 'submitted-validated');
  assert.equal(r.calls.submit.length, 1);
  const sub = r.calls.submit[0];
  assert.equal(sub.approvedSha256, canonicalDigest(sub.request), 'POSTs exactly the approved bytes');
  assert.equal(sub.approvedSha256, r.st.redraw.requestSha256, 'the re-draw request, not the candidate one');
  assert.match(sub.request.submission_id, /^metaharness-darwin-2026-10-10-redraw-[0-9a-f]{10}$/);
  assert.notEqual(sub.request.submission_id, before.submissionId, 'a fresh id, never the validated one');
  assert.notEqual(sub.request.submission_id, r.st.request.submissionId, 'distinct from the same-day candidate id');
  assert.equal(sub.request.name, `${posted.name} (incumbent re-draw)`, 'the validated name plus the re-draw suffix');
  assert.equal(requestBodyDigest(sub.request), requestBodyDigest(posted), 'the validated request again, apart from id and name');
  assert.deepEqual({ ...sub.request, submission_id: posted.submission_id, name: posted.name }, posted, 'the stored body itself, not a re-render');
  assert.ok(r.calls.render.some(c => c.outDir.includes('/incumbent-redraw/')), 'rendered and checked today');
  const after = readJson(join(env.stateDir, 'incumbent.json'));
  assert.deepEqual([after.genome, after.genomeDigest], [before.genome, before.genomeDigest], 'a re-draw never replaces the incumbent genome');
  assert.deepEqual([after.submissionId, after.date, after.lastKind], [sub.request.submission_id, D2, 'incumbent-redraw']);
  assert.deepEqual(after.genomeFrom, { submissionId: before.submissionId, date: D1 });
  assert.deepEqual([after.requestSha256, after.requestName, after.requestBodySha256],
    [sub.approvedSha256, sub.request.name, requestBodyDigest(sub.request)], 'the next re-draw is bound to exactly these POSTed bytes');
  assert.deepEqual(after.storedRequest, { path: `validated-requests/${sub.approvedSha256}.json`, sha256: sub.approvedSha256 }, 'and its stored copy moved with it');
  assert.equal(readFileSync(join(env.stateDir, after.storedRequest.path), 'utf8'), canonicalJson(sub.request), 'the exact POSTed bytes');
  const j = journalOf(env.stateDir).filter(e => e.date === D2);
  assert.ok(j.some(e => e.phase === 'incumbent' && e.event === 'redraw-recorded'));
  assert.ok(!j.some(e => e.phase === 'incumbent' && e.event === 'updated'));
  const decided = j.find(e => e.phase === 'decide' && e.event === 'done');
  assert.deepEqual([decided.kind, j.find(e => e.event === 'intent').kind], ['incumbent-redraw', 'incumbent-redraw']);
  assert.equal(decided.requestSha256, r.st.redraw.requestSha256, 'the journal names the re-draw request, not the candidate one');
  assert.notEqual(decided.requestSha256, r.st.request.requestSha256);
  assert.equal(readJson(join(r.runDir ?? join(env.stateDir, 'runs', D2), 'phases', 'render-incumbent-redraw.json')).renderedFor, 'incumbent-redraw');
  // every report says what it is: another draw of the same request, not an improvement, and not a gate promotion
  const md = readFileSync(r.st.files.markdownPath, 'utf8');
  assert.match(md, /Kind: \*\*incumbent-redraw\*\* \(incumbent re-draw: .*selection on noise, not an improvement\)/);
  assert.match(md, /## Incumbent re-draw request/);
  const status = readJson(r.st.files.statusPath);
  const short = renderMarkdown(status);
  for (const t of [short, renderSlack(status)]) {
    assert.match(t, /SUBMITTED-VALIDATED, incumbent re-draw/);
    assert.match(t, /selection on noise, not an improvement/);
  }
  assert.match(short, /Re-draw request: metaharness-darwin-2026-10-10-redraw-/);
  assert.match(short, /Arena-validated incumbent, re-drawn unchanged \(no gate: not an improvement\) \| PASS/);
  assert.doesNotMatch(short, /Gate promotes/, 'a re-draw is never presented as a gate promotion');
  // the public-post path: post-report.sh posts only what `report.mjs --strict` prints (it refuses on any redaction)
  const cli = spawnSync(process.execPath, [REPORT, '--status', r.st.files.statusPath, '--strict', '--format', 'both', '--today', D2],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: env.home } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.match(/selection on noise, not an improvement/g)?.length, 2, 'markdown and Slack both state the kind');
  // next day: the board agrees with the moved pointer, the search starts from the SAME genome, and dry-run never POSTs
  const n = await run({ noCandidate: true }, { env, date: D3, mode: 'dry-run' });
  assert.equal(n.st.incumbent.boardAgrees, true);
  assert.deepEqual(n.calls.search[0].incumbentGenome, before.genome);
  assert.deepEqual(n.st.decision, { submit: false, reasons: ['modeAuto'], kind: 'incumbent-redraw' });
  assert.deepEqual([n.st.wouldSubmitInAuto, n.calls.submit.length, n.st.outcome], [true, 0, 'no-candidate']);
  assert.match(n.st.redraw.submissionId, /-2026-10-11-redraw-/);
  assert.equal(n.st.redraw.name, `${posted.name} (incumbent re-draw)`, 'a re-drawn re-draw never accumulates suffixes');
});

test('daily-best, day N without any candidate (auto): the incumbent is re-drawn', async () => {
  const { env, posted } = await dayN();
  const r = await run({ noCandidate: true, statusSeq: ['validating'] }, { env, date: D2 });
  assert.deepEqual([r.st.decision.kind, r.st.decision.submit, r.st.outcome], ['incumbent-redraw', true, 'submitted-pending']);
  assert.equal(requestBodyDigest(r.calls.submit[0].request), requestBodyDigest(posted));
  assert.equal(readJson(join(env.stateDir, 'pending-submission.json')).kind, 'incumbent-redraw');
  const before = readJson(join(TEMPLATE.stateDir, 'incumbent.json'));
  assert.equal(readJson(join(env.stateDir, 'incumbent.json')).submissionId, before.submissionId, 'unchanged until validated');
  // the next tick reconciles it in preflight: pointer moved, genome kept, and the board agrees with the moved pointer
  const n = await run({ noCandidate: true, statusSeq: ['validated'] }, { env, date: D3, mode: 'dry-run' });
  const after = readJson(join(env.stateDir, 'incumbent.json'));
  assert.deepEqual([after.submissionId, after.genomeDigest], [r.calls.submit[0].request.submission_id, before.genomeDigest]);
  assert.ok(journalOf(env.stateDir).some(e => e.date === D3 && e.event === 'redraw-recorded'));
  assert.deepEqual([n.st.incumbent.boardAgrees, n.st.decision.reasons], [true, ['modeAuto']]);
});

test('daily-best, gate promoted but its receipt does not verify: not a promoted candidate -> the incumbent is re-drawn', async () => {
  const { env } = await dayN();
  const r = await run({ verifyOk: false, statusSeq: ['validated'] }, { env, date: D2 });
  assert.deepEqual(r.st.decision, { submit: true, reasons: [], kind: 'incumbent-redraw' });
  assert.equal(r.calls.submit[0].approvedSha256, r.st.redraw.requestSha256);
});

test('daily-best, promoted at gate time but the receipt no longer verifies at decision time: nothing re-checked to send -> needs-human', async () => {
  const { env } = await dayN();
  const r = await run({ verifySeq: [true, false] }, { env, date: D2 });
  assert.deepEqual([r.st.gate.verified, r.st.gate.atDecision.verified, r.st.redraw], [true, false, undefined]);
  assert.equal(r.st.decision.kind, 'incumbent-redraw');
  assert.ok(r.st.decision.reasons.includes('requestRenderedForIncumbent'), String(r.st.decision.reasons));
  assert.deepEqual([r.calls.submit.length, r.st.outcome], [0, 'needs-human']);
});

test('daily-best, day 1 without a promoted candidate: no validated incumbent request exists -> needs-human, never POSTed', async () => {
  for (const opts of [{ noCandidate: true }, { gatePromote: false }]) {
    const r = await run(opts);
    assert.deepEqual([r.st.outcome, r.calls.submit.length, r.st.redraw], ['needs-human', 0, undefined], JSON.stringify(opts));
    assert.ok(r.st.needsHuman.requestPath, 'the v2-defaults request is rendered for a human, as under gate-only');
    assert.equal(r.st.decision.kind, 'incumbent-redraw');
    assert.ok(r.st.decision.reasons.includes('incumbentValidated'), String(r.st.decision.reasons));
  }
});

test('daily-best: a promoted candidate whose other conditions fail blocks; the day never falls through to a re-draw', async () => {
  for (const [opts, reason] of [[{ binding: false }, 'requestDigestBoundInGateReceipt'], [{ receiptAlpha: 0.5 }, 'gateConfigMatchesPlan']]) {
    const { env } = await dayN();
    const r = await run(opts, { env, date: D2 });
    assert.deepEqual(r.st.decision, { submit: false, reasons: [reason], kind: 'promoted' });
    assert.deepEqual([r.st.redraw, r.calls.submit.length, r.st.outcome], [undefined, 0, 'skipped']);
  }
});

const CHECK_FLAGS = ['envLaneCommitPinned', 'imagePulledAnonymously', 'openenvValidatePassed', 'exampleReplayAllTasksPassed', 'schemaEqual', 'limitsOk'];
const REDRAW_FAILURES = [
  ['anonymous pull failed', { failCheck: 'pull' }, 'imagePulledAnonymously'],
  ['openenv validate failed', { failCheck: 'openenv_validate' }, 'openenvValidatePassed'],
  ['schema differs', { failCheck: 'schema' }, 'schemaEqual'],
  ['limits violated', { failCheck: 'limits' }, 'limitsOk'],
  ['example replay failed', { failCheck: 'replay' }, 'exampleReplayAllTasksPassed'],
  ['replay skipped one task id', { replayDropTask: true }, 'exampleReplayAllTasksPassed'],
  ['checks ran on another image', { checksImage: OTHER_IMAGE }, 'checksForThisRequest'],
  ['env lane worktree at another commit', { envCommit: 'f'.repeat(40) }, 'envLaneCommitPinned'],
  ['env lane worktree dirty', { envDirty: true }, 'envLaneCommitPinned'],
  ['check report dated yesterday', { checkedAt: `${D1}T15:00:00.000Z` }, 'redrawCheckedToday'],
  ['re-draw tasks on disk differ from the stored request', { mutateTasks: true }, 'redrawIsIncumbentRequest'],
  ['re-draw image on disk differs from the stored request\'s', { renderImage: OTHER_IMAGE }, ['requestRenderedForIncumbent', 'redrawIsIncumbentRequest']],
  ['incumbent record without a body digest (hand-written)', { rec: r => { delete r.requestBodySha256; } }, ['storedRequestIntact', 'redrawIsIncumbentRequest']],
  ['incumbent record without the POSTed name', { rec: r => { delete r.requestName; } }, ['storedRequestIntact', 'redrawIsIncumbentRequest']],
  ['incumbent record names the digest of other bytes', { rec: r => { r.requestSha256 = 'e'.repeat(64); } }, ['storedRequestIntact', 'redrawIsIncumbentRequest']],
  ['the arena rejected this body since (author origin)', { rec: r => { r.lastRejected = { submissionId: 'x', date: D1, errorOrigin: 'author',
    requestBodySha256: r.requestBodySha256 }; } }, 'incumbentBodyNotRejected'],
  ['incumbent.json says validating, not validated', { rec: r => { r.state = 'validating'; } }, 'incumbentValidated'],
  ['darwin evidence is a dry run', { evidence: 'evaluator_dry_run_fake_rows_not_model_rollouts' }, 'redrawNotRehearsal'],
  ['own submissions list unreadable', { ownListUnknown: true }, 'leaderboardAgreesWithIncumbent'],
  ['leaderboard unreadable', { boardHasIncumbent: 'throw' }, 'leaderboardAgreesWithIncumbent'],
  ['slot taken between preflight and decision', { slotSeq: [true, false] }, 'slotFree'],
  ['slot unreadable at decision', { slotSeq: [true, 'throw'] }, 'slotFree'],
];
for (const [name, { cfg, rec, ...opts }, reason] of REDRAW_FAILURES) {
  test(`daily-best day N (auto), one failing re-draw condition blocks: ${name}`, async () => {
    const { env } = await dayN();
    cfg?.(env.config);
    if (rec) { const p = join(env.stateDir, 'incumbent.json'), r = readJson(p); rec(r); writeFileSync(p, JSON.stringify(r)); }
    const r = await run({ gatePromote: false, ...opts }, { env, date: D2 });
    assert.equal(r.calls.submit.length, 0, 'never POSTed');
    assert.equal(r.st.decision.kind, 'incumbent-redraw');
    assert.equal(r.st.decision.submit, false);
    if (opts.failCheck) { // render-and-check's toDecisionFacts gates every check on the whole report being ok
      assert.ok(r.st.decision.reasons.includes(reason), String(r.st.decision.reasons));
      assert.ok(r.st.decision.reasons.every(k => CHECK_FLAGS.includes(k)), String(r.st.decision.reasons));
    } else assert.deepEqual(r.st.decision.reasons, [reason].flat(), 'exactly this condition failed');
    const noRequest = r.st.decision.reasons.some(k => REDRAW_REQUEST_KEYS.includes(k));
    assert.equal(r.st.outcome, noRequest ? 'needs-human' : 'skipped', 'no valid incumbent request -> a human decides');
    assert.equal(r.calls.down.length, 1, 'gpu torn down exactly once');
  });
}

test('daily-best: a re-draw is never submitted on resumed or pre-dated checks', async () => {
  const { env } = await dayN();
  const a = await run({ gatePromote: false }, { env, date: D2, mode: 'dry-run' }); // renders + checks the re-draw on D2
  assert.deepEqual(a.st.decision.reasons, ['modeAuto']);
  const b = await run({ gatePromote: false }, { env, date: D2, now: startOf(D3) }); // the same date, a day later, auto
  assert.deepEqual([b.calls.render.length, b.calls.submit.length], [0, 0], 'everything resumed, nothing POSTed');
  assert.deepEqual(b.st.decision.reasons, ['redrawCheckedToday', 'runDateIsToday']);
  // --date D3 run while the clock still said D2 (checks dated D2), resumed on D3 in auto: the stale checks block
  const { env: env2 } = await dayN();
  const c = await run({ gatePromote: false, start: startOf(D2) }, { env: env2, date: D3, now: startOf(D2), mode: 'dry-run' });
  assert.ok(c.st.decision.reasons.includes('runDateIsToday'));
  const d = await run({ gatePromote: false }, { env: env2, date: D3 });
  assert.deepEqual([d.calls.render.length, d.calls.submit.length], [0, 0]);
  assert.deepEqual(d.st.decision.reasons, ['redrawCheckedToday']);
});

test('daily-best: a validated re-draw whose genome is no longer the incumbent\'s is not recorded (fail closed, noted)', async () => {
  const { env } = await dayN();
  env.config.poll.attempts = 0;
  const a = await run({ gatePromote: false, statusSeq: ['validating'] }, { env, date: D2 });
  assert.equal(a.st.outcome, 'submitted-pending');
  writeIncumbent(env.stateDir, { genome: baselineGenome(), submissionId: 'human-reconciled', requestSha256: 'a'.repeat(64), date: D2, state: 'validated' });
  const b = await run({ statusSeq: ['validated'], noCandidate: true }, { env, date: D3, mode: 'dry-run' });
  assert.equal(readJson(join(env.stateDir, 'incumbent.json')).submissionId, 'human-reconciled', 'the human record is untouched');
  assert.ok(journalOf(env.stateDir).some(e => e.date === D3 && e.phase === 'incumbent' && e.event === 'unchanged' && /never replaces/.test(e.reason)));
  assert.ok(b.st.notes.some(n => n.includes('was not recorded')), String(b.st.notes));
  assert.equal(b.calls.submit.length, 0);
});

test('gate-only (default) on the same day-N scenario: no re-draw, no policy/kind fields; decision and journal exactly as before', async () => {
  const { env } = await dayN();
  const r = await run({ gatePromote: false }, { env, date: D2, policy: 'gate-only' });
  assert.deepEqual(r.st.decision, { submit: false, reasons: ['gatePromote'] });
  assert.deepEqual([r.calls.submit.length, r.st.outcome, r.calls.render.length], [0, 'skipped', 1]);
  for (const k of ['policy', 'redraw']) assert.equal(k in r.st, false, k);
  assert.deepEqual(Object.keys(r.st.flags), [...DECISION_KEYS]);
  const j = journalOf(env.stateDir).filter(e => e.date === D2);
  assert.deepEqual(Object.keys(j.find(e => e.phase === 'decide' && e.event === 'done')).sort(),
    ['date', 'event', 'phase', 'planHash', 'reasons', 'requestSha256', 'submit', 'ts', 'wouldSubmitInAuto']);
  assert.deepEqual(Object.keys(j.find(e => e.phase === 'run' && e.event === 'start')).sort(), ['date', 'event', 'lockReclaimed', 'mode', 'phase', 'startedAt', 'ts']);
  const md = readFileSync(r.st.files.markdownPath, 'utf8');
  assert.doesNotMatch(md, /Policy:|Kind:|re-draw/);
  // and day 1 without a win is needs-human under gate-only too (unchanged)
  const d1 = await run({ noCandidate: true }, { policy: 'gate-only' });
  assert.deepEqual([d1.st.outcome, d1.st.decision.kind, d1.calls.submit.length], ['needs-human', undefined, 0]);
});

// ---- review findings: rerun labels, rejections, stale --now, hand-reconciled records, moved pointers, on-disk re-reads ----
const incPath = env => join(env.stateDir, 'incumbent.json');
const cliReport = (statusPath, env, date) => spawnSync(process.execPath, [REPORT, '--status', statusPath, '--strict', '--format', 'both', '--today', date],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: env.home } });

test('daily-best: a same-date rerun never relabels a POSTed re-draw as a promoted candidate (reports, notify, CLI)', async () => {
  const { env } = await dayN();
  const a = await run({ verifySeq: [false, false], statusSeq: ['validating'] }, { env, date: D2 }); // receipt unverifiable -> re-draw POSTed
  assert.deepEqual([a.st.decision.kind, a.calls.submit.length], ['incumbent-redraw', 1]);
  const b = await run({ statusSeq: ['validated'] }, { env, date: D2 }); // same date: the receipt verifies now -> recomputed kind 'promoted'
  assert.deepEqual([b.st.decision.kind, b.st.decision.reasons, b.calls.submit.length, b.calls.render.length], ['promoted', ['notAlreadySubmitted'], 0, 0]);
  assert.deepEqual([b.st.outcome, b.st.submission.kind, b.calls.notify[0].kind], ['submitted-validated', 'incumbent-redraw', 'incumbent-redraw']);
  assert.ok(b.st.notes.some(n => n.includes('as kind incumbent-redraw')), String(b.st.notes));
  assert.equal(b.st.redraw.submissionId, a.calls.submit[0].request.submission_id, 'the POSTed re-draw request is in the report');
  const status = readJson(b.st.files.statusPath);
  for (const t of [renderMarkdown(status), renderSlack(status)]) {
    assert.match(t, /SUBMITTED-VALIDATED, incumbent re-draw/);
    assert.doesNotMatch(t, /promoted candidate/);
  }
  assert.match(readFileSync(b.st.files.markdownPath, 'utf8'), /Kind: \*\*incumbent-redraw\*\*/);
  const cli = cliReport(b.st.files.statusPath, env, D2);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /SUBMITTED-VALIDATED, incumbent re-draw/);
  assert.doesNotMatch(cli.stdout, /promoted candidate/);
  assert.equal(readJson(incPath(env)).lastKind, 'incumbent-redraw');
});

test('daily-best: a re-draw rejected by the arena (author or unknown origin) is never POSTed again without a human', async () => {
  for (const errorOrigin of ['author', undefined]) {
    const { env, incumbent: before } = await dayN();
    const a = await run({ gatePromote: false, statusSeq: ['rejected'], errorOrigin }, { env, date: D2 });
    assert.equal(a.st.outcome, 'submitted-rejected');
    const { lastRejected, ...rest } = readJson(incPath(env));
    assert.deepEqual(lastRejected, { submissionId: a.calls.submit[0].request.submission_id, date: D2, errorOrigin: errorOrigin ?? null,
      requestBodySha256: before.requestBodySha256 });
    assert.deepEqual(rest, before, 'genome and pointer unchanged');
    for (const date of [D3, D4]) {
      const n = await run({ gatePromote: false }, { env, date });
      assert.deepEqual(n.st.decision, { submit: false, reasons: ['incumbentBodyNotRejected'], kind: 'incumbent-redraw' }, `${errorOrigin} ${date}`);
      assert.deepEqual([n.calls.submit.length, n.st.outcome], [0, 'needs-human']);
    }
    if (errorOrigin) continue;
    // a promoted candidate validated later writes a fresh record: re-draws of the NEW incumbent resume
    const p = await run({ statusSeq: ['validated'] }, { env, date: D5 });
    assert.deepEqual([p.st.decision.kind, p.st.outcome, 'lastRejected' in readJson(incPath(env))], ['promoted', 'submitted-validated', false]);
    const q = await run({ gatePromote: false, statusSeq: ['validated'] }, { env, date: D6 });
    assert.deepEqual([q.st.decision, q.calls.submit.length], [{ submit: true, reasons: [], kind: 'incumbent-redraw' }, 1]);
    assert.equal(requestBodyDigest(q.calls.submit[0].request), requestBodyDigest(p.calls.submit[0].request));
  }
  // platform origin: the arena returns the slot; nothing is recorded and the next day re-draws again
  const { env } = await dayN();
  await run({ gatePromote: false, statusSeq: ['rejected'], errorOrigin: 'platform' }, { env, date: D2 });
  assert.equal('lastRejected' in readJson(incPath(env)), false);
  const n = await run({ gatePromote: false, statusSeq: ['validated'] }, { env, date: D3 });
  assert.deepEqual([n.st.decision.submit, n.calls.submit.length], [true, 1]);
});

test('daily-best: checks from an earlier day are never POSTed, even under a stale --now that matches them', async () => {
  const { env } = await dayN();
  const a = await run({ gatePromote: false }, { env, date: D2, mode: 'dry-run' }); // re-draw rendered + checked on D2
  assert.deepEqual(a.st.decision.reasons, ['modeAuto']);
  const b = await run({ gatePromote: false, start: startOf(D4) }, { env, date: D2, now: startOf(D2) }); // clock D4, --now D2, auto
  assert.deepEqual([b.calls.render.length, b.calls.submit.length, b.st.outcome], [0, 0, 'needs-human']);
  assert.deepEqual(b.st.decision.reasons, ['redrawCheckedToday']);
});

test('daily-best: config.image and task limits changed since validation: the STORED request is re-drawn unchanged (noted, not blocked)', async () => {
  for (const cfg of [c => { c.image = OTHER_IMAGE; }, c => { c.submission.taskLimits = { ...c.submission.taskLimits, rollout_wall_s: 1700 }; }]) {
    const { env, posted } = await dayN();
    cfg(env.config);
    const r = await run({ gatePromote: false, statusSeq: ['validated'] }, { env, date: D2 });
    assert.deepEqual([r.st.decision, r.calls.submit.length], [{ submit: true, reasons: [], kind: 'incumbent-redraw' }, 1], String(cfg));
    const sub = r.calls.submit[0].request;
    assert.deepEqual({ ...sub, submission_id: posted.submission_id, name: posted.name }, posted, 'the validated body, not today\'s config');
    assert.equal(r.calls.render.find(c => c.outDir.includes('/incumbent-redraw/')).image, posted.image, 'every check ran on the stored image');
    const imageNote = r.st.notes.some(n => n.includes('config.image is') && n.includes('not blocking'));
    assert.equal(imageNote, env.config.image !== posted.image, String(r.st.notes));
    if (env.config.image !== posted.image) assert.match(readFileSync(r.st.files.markdownPath, 'utf8'), /config\.image `[^`]+` differs: not blocking/);
  }
});

test('daily-best: a hand-written record is not enough; the stored exact request is what makes a re-draw possible', async () => {
  const { env, incumbent } = await dayN(); // a hand-edited body digest no longer matches the stored copy
  writeFileSync(incPath(env), JSON.stringify({ ...incumbent, requestBodySha256: 'c'.repeat(64) }));
  const b = await run({ gatePromote: false }, { env, date: D2 });
  assert.deepEqual([b.st.decision.reasons, b.calls.submit.length, b.st.outcome], [['storedRequestIntact', 'redrawIsIncumbentRequest'], 0, 'needs-human']);
  // every field rebuilt by hand from the exact request.json, but no stored copy: nothing to re-submit -> a human decides
  const { env: env2, posted } = await dayN();
  const fields = { submissionId: posted.submission_id, requestSha256: canonicalDigest(posted), requestBodySha256: requestBodyDigest(posted),
    requestName: posted.name, date: D1, state: 'validated' };
  writeIncumbent(env2.stateDir, { genome: candidateOf(baselineGenome()), ...fields });
  const no = await run({ gatePromote: false }, { env: env2, date: D2 });
  assert.equal(no.st.redraw.ok, false);
  assert.match(no.st.redraw.reasons[0], /^stored_request_unusable:stored_request_record_invalid/);
  assert.ok(no.st.decision.reasons.includes('storedRequestIntact'), String(no.st.decision.reasons));
  assert.deepEqual([no.calls.submit.length, no.st.outcome], [0, 'needs-human']);
  // with the immutable stored copy of exactly those bytes it re-draws again
  const { env: env3 } = await dayN();
  writeIncumbent(env3.stateDir, { genome: candidateOf(baselineGenome()), ...fields, storedRequest: storeRequest(env3.stateDir, posted, canonicalDigest(posted)) });
  const ok = await run({ gatePromote: false, statusSeq: ['validated'] }, { env: env3, date: D2 });
  assert.deepEqual([ok.st.decision.submit, ok.calls.submit.length], [true, 1]);
});

test('daily-best: a re-draw validated after this date first ran moves the pointer -> incumbent-changed, then the next date re-draws', async () => {
  const { env } = await dayN();
  env.config.poll.attempts = 0;
  const a = await run({ gatePromote: false, statusSeq: ['validating'] }, { env, date: D2 });
  assert.equal(a.st.outcome, 'submitted-pending');
  const b = await run({ noCandidate: true, statusSeq: ['validating'] }, { env, date: D3 });
  assert.deepEqual([b.st.decision.reasons, b.calls.submit.length], [['notAlreadySubmitted'], 0]);
  const c = await run({ noCandidate: true, statusSeq: ['validated'] }, { env, date: D3 }); // D2's re-draw validated meanwhile
  assert.deepEqual([c.st.outcome, c.calls.submit.length, c.st.decision], ['incumbent-changed', 0, undefined]);
  assert.equal(readJson(incPath(env)).submissionId, a.calls.submit[0].request.submission_id);
  const d = await run({ noCandidate: true, statusSeq: ['validated'] }, { env, date: D4 });
  assert.deepEqual([d.st.decision.submit, d.calls.submit.length], [true, 1]);
});

test('daily-best: the decision re-reads the re-draw\'s files and incumbent.json on disk; edits after the checks block (no POST)', async () => {
  const CHECKS = ['envLaneCommitPinned', 'imagePulledAnonymously', 'openenvValidatePassed', 'exampleReplayAllTasksPassed', 'schemaEqual', 'limitsOk'];
  const edit = (p, f) => { const v = readJson(p); f(v); writeFileSync(p, JSON.stringify(v)); };
  const cases = [
    ['presubmit-check.json now reports a failure', (d) => edit(join(d, 'presubmit-check.json'), r => { r.ok = false; r.reasons = ['schema_failed']; r.checks.schema.ok = false; }), CHECKS],
    ['request.json name edited', (d) => edit(join(d, 'request.json'), r => { r.name += ' x'; }), ['requestRenderedForIncumbent', 'requestDigestValid', 'checksForThisRequest']],
    ['incumbent.json no longer says validated', (_d, env) => edit(incPath(env), r => { r.state = 'validating'; }), ['incumbentValidated']],
  ];
  for (const [name, tamper, reasons] of cases) {
    const { env } = await dayN();
    const a = await run({ gatePromote: false }, { env, date: D2, mode: 'dry-run' });
    assert.deepEqual(a.st.decision.reasons, ['modeAuto'], name);
    tamper(dirname(a.st.redraw.requestPath), env);
    const b = await run({ gatePromote: false }, { env, date: D2 });
    assert.deepEqual([b.calls.render.length, b.calls.submit.length, b.st.outcome, b.st.decision.reasons], [0, 0, 'needs-human', reasons], name);
  }
  const { env } = await dayN(); // incumbent.json's pointer edited between the runs: the date is skipped before any decision
  await run({ gatePromote: false }, { env, date: D2, mode: 'dry-run' });
  edit(incPath(env), r => { r.submissionId = 'hand-edited'; });
  const c = await run({ gatePromote: false }, { env, date: D2 });
  assert.deepEqual([c.st.outcome, c.calls.submit.length], ['incumbent-changed', 0]);
});

test('redrawFacts: request, stored copy, id and record digests come from disk and the re-draw itself, never from the stored result', async () => {
  const { env, incumbent, posted } = await dayN();
  const r = await run({ gatePromote: false }, { env, date: D2, mode: 'dry-run' });
  const x = { deps: makeFakes({ start: startOf(D2) }).deps, config: env.config, stateDir: env.stateDir };
  const inc = loadIncumbent(env.stateDir, { baselineGenome, genomeToCells });
  const facts = (redraw = r.st.redraw) => redrawFacts(x, { redraw });
  const good = facts();
  assert.deepEqual([good.request.sha256, good.request.submissionId, good.request.asValidatedSha256, good.request.source, good.clockToday, good.evaluatorDryRun],
    [r.st.redraw.requestSha256, r.st.redraw.submissionId, incumbent.requestSha256, 'stored-request', D2, false]);
  assert.deepEqual([good.request.expectedImage, good.request.name, good.request.expectedName], [posted.image, `${posted.name} (incumbent re-draw)`,
    `${posted.name} (incumbent re-draw)`]);
  assert.deepEqual(good.incumbentRecord, { state: 'validated', hasGenome: true, genomeDigest: inc.genomeDigest, submissionId: incumbent.submissionId,
    requestSha256: incumbent.requestSha256, requestBodySha256: incumbent.requestBodySha256, requestName: incumbent.requestName, lastRejected: null });
  assert.deepEqual(good.storedRequest, { fileOk: true, problem: null, recordedSha256: incumbent.requestSha256, fileSha256: incumbent.requestSha256,
    canonicalSha256: incumbent.requestSha256, canonical: true, submissionId: posted.submission_id, name: posted.name,
    bodySha256: incumbent.requestBodySha256, image: posted.image });
  assert.equal(facts({ ...r.st.redraw, submissionId: 'metaharness-darwin-other' }).request.submissionId, null, 'the id on disk is the rendered one');
  assert.equal(facts({ ...r.st.redraw, requestSha256: 'e'.repeat(64) }).request.sha256, null, 'the digest of the file on disk');
  writeFileSync(incPath(env), JSON.stringify({ ...incumbent, genomeDigest: 'f'.repeat(64) }));
  assert.equal(facts().incumbentRecord.genomeDigest, null, 'a record whose digest is not its genome\'s');
  writeFileSync(incPath(env), JSON.stringify({ ...incumbent, requestName: undefined }));
  assert.equal(facts().request.asValidatedSha256, null, 'a record without the POSTed name cannot be rebuilt');
  writeFileSync(incPath(env), JSON.stringify({ ...incumbent, storedRequest: { ...incumbent.storedRequest, path: '../elsewhere.json' } }));
  assert.deepEqual([facts().storedRequest.fileOk, facts().storedRequest.problem, facts().request.expectedImage],
    [false, 'stored_request_path_not_content_addressed', null], 'a recorded path is never trusted');
});
