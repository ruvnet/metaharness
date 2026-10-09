// flywheel.mjs failure handling with full fakes: gpu down on every error path, safe resume, no second POST,
// lockfile, orphan-GPU sweep, redaction, slot/budget skips that never rent a GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFlywheel } from '../flywheel.mjs';
import { LockedError } from '../journal.mjs';
import { makeFakes, setup, START, startOf } from './fw-fakes.mjs';

const DATE = '2026-10-09';
const journalOf = stateDir => readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
// auto = config.json says auto (the --mode flag alone can only downgrade); --now is 10:17 Toronto on --date.
async function run(fakeOpts = {}, { mode = 'auto', date = DATE, env = setup(), fakes } = {}) {
  if (mode === 'auto') env.config.mode = 'auto';
  const f = fakes ?? makeFakes({ stateDirFn: () => env.stateDir, ...fakeOpts });
  const st = await runFlywheel({ config: env.config, date, now: startOf(date), mode, stateDir: env.stateDir, deps: f.deps });
  return { st, ...f, ...env };
}

const AFTER_UP = ['search', 'expectedProvenance', 'evaluate:incumbent', 'evaluate:candidate', 'render', 'gate', 'verify'];
for (const point of AFTER_UP) {
  test(`gpu down runs exactly once when ${point} throws; run ends in error, lock released, report written`, async () => {
    const { st, calls, stateDir } = await run({ throwAt: point });
    assert.equal(st.outcome, 'error');
    assert.match(st.error, new RegExp(`injected failure at ${point}`));
    assert.equal(calls.up.length, 1);
    assert.deepEqual(calls.down, [4243]);
    assert.equal(calls.submit.length, 0);
    assert.equal(existsSync(join(stateDir, 'flywheel.lock')), false);
    assert.equal(JSON.parse(readFileSync(st.files.statusPath, 'utf8')).outcome, 'error');
    const downs = journalOf(stateDir).filter(e => e.phase === 'gpu' && e.event === 'down');
    assert.equal(downs.length, 1);
    assert.equal(downs[0].confirmed, true);
  });
}

test('the rented endpoint is probed before the search: a bad endpoint never costs a search', async () => {
  const { st, calls, stateDir } = await run({ throwAt: 'expectedProvenance' });
  assert.equal(st.outcome, 'error');
  assert.deepEqual([calls.search.length, calls.down.length], [0, 1]);
  const ok = await run({}, { mode: 'dry-run' });
  assert.equal(ok.st.gpu.serverSha, 'c'.repeat(64));
  assert.ok(journalOf(ok.stateDir).some(e => e.event === 'endpoint-verified' && e.serverSha === 'c'.repeat(64)));
  assert.ok(!journalOf(stateDir).some(e => e.event === 'endpoint-verified'));
});

test('a resumed date whose stored incumbent went stale (pending got validated) is skipped, not searched', async () => {
  const env = setup({ poll: { attempts: 0 } });
  await run({ statusSeq: ['validating'] }, { env, date: '2026-10-09' });
  const crashed = await run({ statusSeq: ['validating'], throwAt: 'search' }, { env, date: '2026-10-10' });
  assert.equal(crashed.st.outcome, 'error');
  const resumed = await run({ statusSeq: ['validated'] }, { env, date: '2026-10-10' });
  assert.equal(resumed.st.outcome, 'incumbent-changed');
  assert.deepEqual([resumed.calls.up.length, resumed.calls.search.length, resumed.calls.submit.length], [0, 0, 0]);
  assert.ok(existsSync(join(env.stateDir, 'incumbent.json')), 'the validated submission did become the incumbent');
});

test('evaluator not runnable -> refused before renting; gpu.up failure (non-spend) -> error without a handle to tear down', async () => {
  const a = await run({ throwAt: 'ready' });
  assert.deepEqual([a.st.outcome, a.calls.up.length, a.calls.down.length], ['error', 0, 0]);
  const b = await run({ throwAt: 'up' });
  assert.deepEqual([b.st.outcome, b.calls.up.length, b.calls.down.length], ['error', 1, 0]);
});

test('a failing teardown is reported (not swallowed) and the next run destroys the orphan by id', async () => {
  const env = setup();
  const a = await run({ downThrows: true }, { env, mode: 'dry-run' });
  assert.equal(a.st.gpu.destroyed, false);
  assert.match(a.st.gpu.downError, /vast destroy failed/);
  assert.ok(a.st.notes.some(n => n.includes('NOT confirmed')));
  const b = await run({}, { env, mode: 'dry-run', date: '2026-10-10' });
  assert.deepEqual(b.calls.destroy, [4243], 'orphan from the earlier run destroyed in preflight');
  assert.ok(journalOf(env.stateDir).some(e => e.event === 'orphan-destroyed' && e.instanceId === 4243 && e.confirmed === true));
  const c = await run({}, { env, mode: 'dry-run', date: '2026-10-11' });
  assert.deepEqual(c.calls.destroy, [], 'a confirmed destroy is not repeated');
  // gpu.mjs journaled `created` but provisionGpu never returned (killed mid-boot): still swept by id.
  appendFileSync(join(env.stateDir, 'journal.jsonl'), `${JSON.stringify({ date: '2026-10-11', phase: 'gpu', event: 'gpu.created', instanceId: 5151 })}\n`);
  const d = await run({}, { env, mode: 'dry-run', date: '2026-10-12' });
  assert.deepEqual(d.calls.destroy, [5151]);
});

test('resume: a crash after search re-runs neither search nor the plan; GPU is rented again only for the confirmation', async () => {
  const env = setup();
  const a = await run({ throwAt: 'evaluate:candidate' }, { env, mode: 'dry-run' });
  assert.equal(a.st.outcome, 'error');
  const b = await run({}, { env, mode: 'dry-run' });
  assert.equal(b.st.outcome, 'skipped');
  assert.equal(b.calls.search.length, 0, 'search result resumed from the journal');
  assert.equal(b.calls.up.length, 1);
  assert.deepEqual(b.calls.up, [`fw-${DATE}-g2`], 'distinct GPU run id per rental');
  const j = journalOf(env.stateDir);
  assert.equal(j.filter(e => e.phase === 'confirm-plan' && e.event === 'registered').length, 1, 'one preregistered plan');
  assert.equal(b.st.confirmation.planHash, a.st.confirmation?.planHash ?? j.find(e => e.event === 'registered').planHash);
  const c = await run({}, { env, mode: 'dry-run' });
  assert.deepEqual([c.calls.up.length, c.calls.search.length, c.calls.evaluate.length], [0, 0, 0], 'fully resumed: no GPU at all');
});

test('idempotent submit: an unknown POST outcome is never re-POSTed; the rerun only reconciles', async () => {
  const env = setup();
  const a = await run({ receiptMode: 'crash-sending' }, { env });
  assert.equal(a.st.outcome, 'submit-unknown');
  assert.equal(a.calls.submit.length, 1);
  assert.ok(existsSync(join(env.stateDir, 'pending-submission.json')));
  const b = await run({ statusSeq: ['validated'] }, { env });
  assert.equal(b.calls.submit.length, 0, 'never a second POST for the same date');
  assert.ok(b.calls.getSubmission.length >= 1);
  assert.equal(b.st.outcome, 'submitted-validated');
  assert.ok(b.st.decision.reasons.includes('notAlreadySubmitted'));
  assert.ok(existsSync(join(env.stateDir, 'incumbent.json')));
});

test('a pending record whose POST provably never happened is cleared by the next run (no permanent block)', async () => {
  const env = setup({ poll: { attempts: 0 } });
  mkdirSync(env.stateDir, { recursive: true });
  writeFileSync(join(env.stateDir, 'pending-submission.json'), JSON.stringify({ date: '2026-10-08', submissionId: 'metaharness-darwin-x',
    requestSha256: 'a'.repeat(64), genome: {}, receiptPath: join(env.stateDir, 'runs', '2026-10-08', 'submit', 'arena-receipt.json'), state: 'sending' }));
  const r = await run({ statusSeq: [null], receiptMode: 'none' }, { env });
  assert.equal(existsSync(join(env.stateDir, 'pending-submission.json')), false);
  assert.ok(journalOf(env.stateDir).some(e => e.event === 'never-sent'));
  assert.equal(r.calls.submit.length, 1, 'the day is free to submit again');
  // ...but when arena-api.mjs had persisted post_attempted=true, an absent id stays pending (unknown, human reconciles).
  const env2 = setup({ poll: { attempts: 0 } });
  const receipt = join(env2.stateDir, 'runs', '2026-10-08', 'submit', 'arena-receipt.json');
  mkdirSync(join(env2.stateDir, 'runs', '2026-10-08', 'submit'), { recursive: true });
  writeFileSync(receipt, JSON.stringify({ post_attempted: true, state: 'unknown' }));
  writeFileSync(join(env2.stateDir, 'pending-submission.json'), JSON.stringify({ date: '2026-10-08', submissionId: 'metaharness-darwin-y',
    requestSha256: 'a'.repeat(64), genome: {}, receiptPath: receipt, state: 'sending' }));
  const r2 = await run({ statusSeq: [null] }, { env: env2 });
  assert.equal(r2.calls.submit.length, 0);
  assert.ok(r2.st.decision.reasons.includes('notAlreadySubmitted'));
});

test('evaluator.dryRun rehearsal never rents a GPU and can never submit', async () => {
  const env = setup();
  env.config.evaluator.dryRun = true;
  const r = await run({ evidence: 'evaluator_dry_run_fake_rows_not_model_rollouts', cardsDryRun: true }, { env });
  assert.deepEqual([r.calls.up.length, r.calls.precheck, r.calls.down.length, r.calls.submit.length], [0, 0, 0, 0]);
  assert.ok(r.st.decision.reasons.includes('confirmationNotDryRun'));
});

test('429 quota at submit -> slot-busy, quota remembered, incumbent unchanged', async () => {
  const env = setup();
  const r = await run({ submitResult: { state: 'refused', post_attempted: true, http_status: 429, error_code: 'SUBMISSION_QUOTA_EXCEEDED', retry_after_s: 3600 } }, { env });
  assert.equal(r.st.outcome, 'slot-busy');
  assert.deepEqual(JSON.parse(readFileSync(join(env.stateDir, 'quota.json'), 'utf8')).retryAfterS, 3600);
  assert.equal(existsSync(join(env.stateDir, 'incumbent.json')), false);
  assert.equal(existsSync(join(env.stateDir, 'pending-submission.json')), false, 'refused at once: nothing pending');
});

test('lock: a live holder refuses the run; a dead holder is reclaimed', async () => {
  const env = setup();
  mkdirSync(env.stateDir, { recursive: true });
  writeFileSync(join(env.stateDir, 'flywheel.lock'), JSON.stringify({ pid: process.pid, date: DATE }));
  const f = makeFakes({ pid: 999_999_1 });
  await assert.rejects(runFlywheel({ config: env.config, date: DATE, now: START, stateDir: env.stateDir, deps: f.deps }), LockedError);
  assert.equal(f.calls.up.length, 0);
  writeFileSync(join(env.stateDir, 'flywheel.lock'), JSON.stringify({ pid: 999_999_2, date: '2026-10-08' }));
  const r = await run({}, { env, mode: 'dry-run' });
  assert.equal(r.st.outcome, 'skipped');
  assert.equal(journalOf(env.stateDir).find(e => e.phase === 'run' && e.event === 'start').lockReclaimed.pid, 999_999_2);
});

test('slot busy at preflight: no GPU, no search; unless it frees within proceedIfFreeWithinS', async () => {
  const a = await run({ slotFree: false });
  assert.deepEqual([a.st.outcome, a.calls.up.length, a.calls.search.length, a.calls.precheck], ['slot-busy', 0, 0, 0]);
  const b = await run({ slotSeq: [false, true], freeAtMs: Date.parse(START) + 3600e3 });
  assert.equal(b.calls.up.length, 1, 'frees in 1 h < 6 h: proceed');
  assert.equal(b.st.outcome, 'submitted-validated');
  const c = await run({ slotSeq: ['throw'] });
  assert.equal(c.st.outcome, 'slot-busy', 'unreadable slot = busy (fail closed, nothing rented)');
});

test('spend refused (precheck or at rent time) -> budget-refused, no instance to tear down', async () => {
  const a = await run({ precheckRefuses: true });
  assert.deepEqual([a.st.outcome, a.calls.up.length, a.calls.down.length], ['budget-refused', 0, 0]);
  const b = await run({ upRefuses: true });
  assert.deepEqual([b.st.outcome, b.calls.up.length, b.calls.down.length], ['budget-refused', 1, 0]);
});

test('secrets in error text never reach the journal, status or report', async () => {
  const secret = 'hf_abcdefghijklmnopqrstu Bearer sekrit-123 "instance_api_key": "ia-9999"';
  const { st, stateDir } = await run({ throwAt: 'search', throwMessage: `boom ${secret}` });
  assert.equal(st.outcome, 'error');
  for (const text of [readFileSync(join(stateDir, 'journal.jsonl'), 'utf8'), readFileSync(st.files.statusPath, 'utf8'), readFileSync(st.files.markdownPath, 'utf8')]) {
    for (const s of ['abcdefghijklmnopqrstu', 'sekrit-123', 'ia-9999']) assert.ok(!text.includes(s), `leaked ${s}`);
  }
});

test('CLI: --date is required and strict; bad --mode and bad config are usage errors (exit 2), nothing wired', () => {
  const cli = new URL('../flywheel.mjs', import.meta.url).pathname;
  const env = setup();
  const runCli = (...a) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...a], { encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: env.home, XDG_CONFIG_HOME: join(env.home, 'cfg'), XDG_STATE_HOME: join(env.home, 'st') } });
  assert.equal(runCli().status, 2);
  assert.equal(runCli('--date', '2026-13-01').status, 2);
  assert.equal(runCli('--date', DATE, '--mode', 'yolo').status, 2);
  assert.equal(runCli('--date', DATE, '--bogus').status, 2);
  mkdirSync(join(env.home, 'cfg', 'arena-flywheel'), { recursive: true });
  writeFileSync(join(env.home, 'cfg', 'arena-flywheel', 'config.json'), '{"mode":"sure"}');
  const bad = runCli('--date', DATE);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /mode must be/);
  assert.equal(runCli('--help').status, 0);
});

test('a notify failure never changes the outcome; a corrupt journal fails closed before any rental', async () => {
  const a = await run({ throwAt: 'notify' }, { mode: 'dry-run' });
  assert.equal(a.st.outcome, 'skipped');
  const env = setup();
  mkdirSync(env.stateDir, { recursive: true });
  appendFileSync(join(env.stateDir, 'journal.jsonl'), '{not json\n');
  const b = await run({}, { env });
  assert.deepEqual([b.st.outcome, b.calls.up.length], ['error', 0]);
  assert.match(b.st.error, /journal_corrupt/);
});
