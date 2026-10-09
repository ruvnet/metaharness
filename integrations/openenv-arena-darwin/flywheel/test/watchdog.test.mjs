// watchdog.sh against fake vastai + gcloud on PATH (real bash and jq). Nothing reaches Vast or Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWatchdog } from '../gpu.mjs';
import { assertCleanVastCalls, assertNoSecrets, makeShims } from './gpu-fakes/shims.mjs';

const WATCHDOG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'watchdog.sh');
const LABEL = 'arena-flywheel-t1';
const ROW = { id: 4242, actual_status: 'running', label: LABEL, jupyter_token: 'SENTINEL-JUPYTER-TOKEN-55aa01' };
const GONE = { instances: null };
const nowS = () => Math.floor(Date.now() / 1000);
const writeFileSync_ = (p, text) => { fs.writeFileSync(p, text); fs.chmodSync(p, 0o755); }; // an executable fake

function setup(t, scenario = {}, shimOpts = {}) {
  const shims = makeShims({ scenario: { show: [{ stdout: ROW }, { stdout: GONE }], destroy: [{ stdout: '' }], ...scenario }, ...shimOpts });
  t.after(() => shims.cleanup());
  const env = { PATH: shims.pathEnv, HOME: process.env.HOME, ARENA_FLYWHEEL_STATE_DIR: shims.stateDir,
    WATCHDOG_RETRY_S: '0', WATCHDOG_POLL_S: '1', WATCHDOG_ATTEMPTS: '5' };
  const run = (args, extraEnv = {}) => spawnSync('bash', [WATCHDOG, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60_000 });
  const read = (f) => (existsSync(path.join(shims.stateDir, f)) ? readFileSync(path.join(shims.stateDir, f), 'utf8') : '');
  return { shims, env, run, read };
}

test('argument and environment validation: exit 2, no gcloud and no vastai call', (t) => {
  const s = setup(t);
  const n = nowS();
  const badArgs = [[], ['4242'], ['4242', String(n)], ['4242', String(n), LABEL, 'extra'],
    ['0', String(n), LABEL], ['abc', String(n), LABEL], ['42;rm', String(n), LABEL], ['-1', String(n), LABEL], ['1234567890123', String(n), LABEL],
    ['4242', '-5', LABEL], ['4242', '123', LABEL], ['4242', `${n}x`, LABEL], ['4242', String(n + 2 * 86400), LABEL], ['4242', String(n - 2 * 86400), LABEL],
    ['4242', String(n), 'foo'], ['4242', String(n), 'arena-flywheel-$(id)'], ['4242', String(n), 'arena-flywheel-'], ['4242', String(n), `${LABEL} x`]];
  for (const a of badArgs) {
    const r = s.run(a);
    assert.equal(r.status, 2, `args ${JSON.stringify(a)}: ${r.stderr}`);
  }
  const badEnv = [{ WATCHDOG_ATTEMPTS: 'x' }, { WATCHDOG_ATTEMPTS: '0' }, { WATCHDOG_RETRY_S: '-1' }, { WATCHDOG_POLL_S: '0' },
    { ARENA_FLYWHEEL_STATE_DIR: 'relative/dir' }, { ARENA_FLYWHEEL_STATE_DIR: '/tmp/../etc' }, { PATH: '/usr/bin:/bin' }];
  for (const e of badEnv) assert.equal(s.run(['4242', String(n), LABEL], e).status, 2, JSON.stringify(e));
  assert.equal(s.shims.vastCalls().length, 0);
  assert.equal(s.shims.gcloudCalls().length, 0);
});

test('fires at the deadline: key fetched once at fire time, destroy by id, confirmed gone, exit 0', (t) => {
  const s = setup(t);
  const r = s.run(['4242', String(nowS()), LABEL]);
  assert.equal(r.status, 0, r.stderr);
  const calls = s.shims.vastCalls();
  assert.deepEqual(calls.map(c => c.cmd), ['show', 'destroy', 'show']);
  assert.deepEqual(calls[1].argv, ['destroy', 'instance', '4242', '-y', '--raw']);
  assertCleanVastCalls(assert, calls, { minimalEnv: false });
  assert.deepEqual(s.shims.gcloudCalls(), ['secrets versions access latest --secret=VAST_API_KEY --project=cognitum-20260110']);
  const log = s.read('watchdog.jsonl').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(log.map(e => e.phase), ['armed', 'fired', 'destroy_sent', 'destroyed_confirmed']);
  assert.equal(log[0].instanceId, 4242);
  assertNoSecrets(assert, r.stdout, r.stderr, s.read('watchdog.jsonl'));
});

test('destroy is retried until show confirms; HTTP errors on stderr are not success', (t) => {
  const s = setup(t, {
    show: [{ stdout: ROW }, { stdout: '', stderr: { error: true, status_code: 502, msg: 'bad gateway' } }, { stdout: ROW }, { stdout: GONE }],
    destroy: [{ stdout: '', stderr: { error: true, status_code: 503, msg: 'busy' } }, { stdout: '' }],
  });
  const r = s.run(['4242', String(nowS() - 60), LABEL]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.shims.vastCalls('destroy').length, 3);
  assert.match(s.read('watchdog.jsonl'), /"msg":"attempt 2 state=error"/);
});

test('never confirmed: exit 1, LEAK logged and recorded in watchdog-failed.jsonl after WATCHDOG_ATTEMPTS', (t) => {
  const s = setup(t, { show: [{ stdout: ROW }] });
  const r = s.run(['4242', String(nowS()), LABEL], { WATCHDOG_ATTEMPTS: '3' });
  assert.equal(r.status, 1);
  assert.equal(s.shims.vastCalls('destroy').length, 3);
  assert.equal(JSON.parse(s.read('watchdog-failed.jsonl')).reason, 'unconfirmed');
  assert.match(s.read('watchdog.jsonl'), /"phase":"LEAK"/);
});

test('label mismatch: refuses to destroy someone else\'s instance (exit 3)', (t) => {
  const s = setup(t, { show: [{ stdout: { ...ROW, label: 'manual-experiment' } }] });
  const r = s.run(['4242', String(nowS()), LABEL]);
  assert.equal(r.status, 3);
  assert.equal(s.shims.vastCalls('destroy').length, 0);
  assert.equal(JSON.parse(s.read('watchdog-failed.jsonl')).reason, 'label_mismatch');
});

test('gcloud key fetch fails: retried, no vastai call without a key, exit 1', (t) => {
  const s = setup(t, {}, { gcloud: 'fail' });
  const r = s.run(['4242', String(nowS()), LABEL], { WATCHDOG_ATTEMPTS: '2' });
  assert.equal(r.status, 1);
  assert.equal(s.shims.gcloudCalls().length, 2);
  assert.equal(s.shims.vastCalls().length, 0);
});

test('SIGTERM before the deadline: exit 0 and the key was never fetched', async (t) => {
  const s = setup(t);
  const child = spawn('bash', [WATCHDOG, '4242', String(nowS() + 600), LABEL], { env: s.env });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  await new Promise((resolve) => { const i = setInterval(() => { if (out.includes('armed')) { clearInterval(i); resolve(); } }, 20); });
  child.kill('SIGTERM');
  const code = await new Promise(r => child.on('close', r));
  assert.equal(code, 0);
  assert.equal(s.shims.gcloudCalls().length, 0);
  assert.equal(s.shims.vastCalls().length, 0);
  assert.match(s.read('watchdog.jsonl'), /"phase":"stopped"/);
});

test('a UTF-8 locale (what the user manager passes to the transient unit) does not break the key-shape check', (t) => {
  const s = setup(t);
  const r = s.run(['4242', String(nowS()), LABEL], { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(s.shims.vastCalls().map(c => c.cmd), ['show', 'destroy', 'show']);
});

test('label mode (armed before create): at the deadline it destroys every id carrying the label, done when none is left', (t) => {
  const s = setup(t, { showAll: [{ stdout: [ROW, { ...ROW, id: 5, label: 'someone-else' }] }, { stdout: [] }] });
  const r = s.run(['-', String(nowS()), LABEL]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.shims.vastCalls().map(c => c.cmd), ['showAll', 'destroy', 'showAll']);
  assert.deepEqual(s.shims.vastCalls('showAll')[0].argv.slice(0, 4), ['show', 'instances', '--label', LABEL]);
  assert.deepEqual(s.shims.vastCalls('destroy')[0].argv, ['destroy', 'instance', '4242', '-y', '--raw'], 'only OUR label, by id');
  const log = s.read('watchdog.jsonl').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(log.map(e => e.phase), ['armed', 'fired', 'destroy_sent', 'destroyed_confirmed']);
  assert.equal(log[0].instanceId, null);
  assertCleanVastCalls(assert, s.shims.vastCalls(), { minimalEnv: false });
});

test('label mode: nothing was created -> one lookup, exit 0; a failing lookup (HTTP error = empty stdout) is never "none left"', (t) => {
  const a = setup(t, { showAll: [{ stdout: [] }] });
  assert.equal(a.run(['-', String(nowS()), LABEL]).status, 0);
  assert.deepEqual(a.shims.vastCalls().map(c => c.cmd), ['showAll']);
  const b = setup(t, { showAll: [{ stdout: '', stderr: { error: true, status_code: 502, msg: 'bad gateway' } }, { stdout: [ROW] }, { stdout: [] }] });
  assert.equal(b.run(['-', String(nowS()), LABEL]).status, 0);
  assert.deepEqual(b.shims.vastCalls().map(c => c.cmd), ['showAll', 'showAll', 'destroy', 'showAll']);
  assert.match(b.read('watchdog.jsonl'), /"phase":"lookup_failed"/);
});

test('spend 2: a failing log sink (disk full) cannot stop the destroy once the watchdog has fired', (t) => {
  const s = setup(t);
  fs.mkdirSync(s.shims.stateDir, { recursive: true });
  fs.symlinkSync('/dev/full', path.join(s.shims.stateDir, 'watchdog.jsonl'));
  const r = s.run(['4242', String(nowS()), LABEL]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.shims.vastCalls().map(c => c.cmd), ['show', 'destroy', 'show']);
  assert.match(r.stdout, /destroyed_confirmed/);
});

test('spend 2: a hanging gcloud times out per call and is retried; giving up is a recorded LEAK (exit 1)', (t) => {
  const s = setup(t);
  writeFileSync_(path.join(s.shims.bin, 'gcloud'), `#!/bin/sh\necho "$*" >> '${s.shims.files.gcloud}'\nexec sleep 30\n`);
  const t0 = Date.now();
  const r = s.run(['4242', String(nowS()), LABEL], { WATCHDOG_KEY_TIMEOUT_S: '1', WATCHDOG_ATTEMPTS: '2' });
  assert.equal(r.status, 1);
  assert.ok(Date.now() - t0 < 15_000, 'bounded by the per-call timeout');
  assert.equal(s.shims.gcloudCalls().length, 2);
  assert.equal(s.read('watchdog.jsonl').match(/"phase":"key_fetch_failed"/g).length, 2);
  assert.equal(JSON.parse(s.read('watchdog-failed.jsonl')).reason, 'unconfirmed');
});

test('spend 2: retries end at WATCHDOG_GIVE_UP_AT even with attempts left (then systemd restarts it)', (t) => {
  const s = setup(t, { show: [{ stdout: ROW }] });
  const t0 = Date.now();
  const r = s.run(['4242', String(nowS()), LABEL], { WATCHDOG_ATTEMPTS: '999', WATCHDOG_RETRY_S: '1', WATCHDOG_GIVE_UP_AT: String(nowS() + 2) });
  assert.equal(r.status, 1);
  assert.ok(Date.now() - t0 < 20_000);
  assert.match(s.read('watchdog.jsonl'), /"phase":"LEAK"/);
});

test('spend 2: a TERM after the deadline is a recorded failure (exit 1), never a clean "stopped"', async (t) => {
  const s = setup(t);
  writeFileSync_(path.join(s.shims.bin, 'gcloud'), '#!/bin/sh\nexec sleep 30\n');
  const child = spawn('bash', [WATCHDOG, '4242', String(nowS()), LABEL], { env: { ...s.env, WATCHDOG_KEY_TIMEOUT_S: '20' }, detached: true, stdio: 'ignore' });
  for (let i = 0; i < 100 && !/"phase":"fired"/.test(s.read('watchdog.jsonl')); i++) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 200));
  process.kill(-child.pid, 'SIGTERM'); // like systemd at RuntimeMaxSec: TERM to the whole unit
  const code = await new Promise(r => child.on('close', r));
  assert.equal(code, 1);
  assert.match(s.read('watchdog.jsonl'), /"phase":"stopped_after_fire"/);
  assert.equal(JSON.parse(s.read('watchdog-failed.jsonl')).reason, 'terminated_after_fire');
});

test('launchWatchdog(systemd-run): transient user unit in its own cgroup, active until stopped (SYSTEMD_IT=1)',
  { skip: process.env.SYSTEMD_IT === '1' ? false : 'set SYSTEMD_IT=1 (creates a transient user unit)' }, async (t) => {
    const s = setup(t);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(s.shims.stateDir, { recursive: true });
    const id = 990000000 + (process.pid % 100000);
    const wd = await launchWatchdog({ instanceId: id, deadlineEpoch: nowS() + 600, label: LABEL, stateDir: s.shims.stateDir,
      launcher: 'systemd-run', pathEnv: s.shims.pathEnv, nowMs: Date.now() });
    t.after(() => wd.stop());
    assert.equal(wd.how, `systemd unit arena-flywheel-wd-${id}`);
    const active = () => spawnSync('systemctl', ['--user', 'is-active', `arena-flywheel-wd-${id}.service`], { encoding: 'utf8' }).stdout.trim();
    assert.equal(active(), 'active');
    const cg = spawnSync('systemctl', ['--user', 'show', '-p', 'ControlGroup', '--value', `arena-flywheel-wd-${id}.service`], { encoding: 'utf8' }).stdout.trim();
    assert.match(cg, new RegExp(`arena-flywheel-wd-${id}\\.service$`), 'own cgroup, not the caller\'s');
    const prop = p => spawnSync('systemctl', ['--user', 'show', '-p', p, '--value', `arena-flywheel-wd-${id}.service`], { encoding: 'utf8' }).stdout.trim();
    assert.equal(prop('Restart'), 'on-failure', 'a LEAK exit (1) or a timeout is retried by systemd');
    assert.match(prop('RestartPreventExitStatus'), /^2 3$/, 'bad arguments (2) and a foreign label (3) are final');
    // label mode, the way gpu.mjs arms it before create: unit named after the run, `-` for the id
    const lw = await launchWatchdog({ instanceId: null, deadlineEpoch: nowS() + 600, label: `arena-flywheel-it${process.pid % 100000}`,
      stateDir: s.shims.stateDir, launcher: 'systemd-run', pathEnv: s.shims.pathEnv, nowMs: Date.now() });
    t.after(() => lw.stop());
    assert.equal(lw.how, `systemd unit arena-flywheel-wd-it${process.pid % 100000}`);
    await lw.stop();
    await wd.stop();
    await new Promise(r => setTimeout(r, 300));
    assert.notEqual(active(), 'active');
    assert.equal(s.shims.gcloudCalls().length, 0, 'stopped before the deadline: key never fetched');
    assert.match(s.read('watchdog.jsonl'), /"phase":"armed"/);
  });

test('launchWatchdog(detached): real watchdog.sh survives in its own process group; a launch-time arg error is detected', async (t) => {
  const s = setup(t);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(s.shims.stateDir, { recursive: true });
  const wd = await launchWatchdog({ instanceId: 4242, deadlineEpoch: nowS() + 600, label: LABEL, stateDir: s.shims.stateDir,
    launcher: 'detached', pathEnv: s.shims.pathEnv, nowMs: Date.now() });
  assert.match(wd.how, /^detached pid \d+$/);
  const pid = Number(wd.how.split(' ').at(-1));
  assert.doesNotThrow(() => process.kill(pid, 0), 'watchdog alive');
  wd.stop();
  await new Promise(r => setTimeout(r, 300));
  assert.throws(() => process.kill(pid, 0), 'watchdog stopped');
  assert.equal(s.shims.gcloudCalls().length, 0);
  await assert.rejects(launchWatchdog({ instanceId: 4242, deadlineEpoch: nowS() + 3 * 86400, label: LABEL, stateDir: s.shims.stateDir,
    launcher: 'detached', pathEnv: s.shims.pathEnv, nowMs: Date.now() }), /exited at launch/);
});
