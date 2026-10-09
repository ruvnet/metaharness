// systemd units, run-tick.sh and install.sh. Nothing touches the real user manager: install.sh runs with a
// temporary HOME and a fake systemctl/loginctl that only log argv. systemd-analyze is the real (read-only) binary.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync,
  statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../flywheel-config.mjs';

const FLY = join(dirname(fileURLToPath(import.meta.url)), '..');
const UNITS = join(FLY, 'systemd');
const tmp = mkdtempSync(join(tmpdir(), 'arena-fw-install-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const hasAnalyze = sh('systemd-analyze', ['--version']).status === 0;

describe('unit files', () => {
  const service = readFileSync(join(UNITS, 'arena-flywheel.service'), 'utf8');
  const timer = readFileSync(join(UNITS, 'arena-flywheel.timer'), 'utf8');
  const directives = text => text.split('\n').filter(l => /^[A-Za-z]+=/.test(l));
  test('systemd-analyze --user verify accepts both units with no output', { skip: !hasAnalyze }, () => {
    const r = sh('systemd-analyze', ['--user', 'verify', join(UNITS, 'arena-flywheel.service'), join(UNITS, 'arena-flywheel.timer')]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(`${r.stdout}${r.stderr}`.trim(), '');
  });
  test('timer: daily 10:17 America/Toronto, 10 min jitter, persistent; the calendar spec parses to 10:17 local', { skip: !hasAnalyze }, () => {
    const d = directives(timer);
    for (const want of ['OnCalendar=*-*-* 10:17:00 America/Toronto', 'RandomizedDelaySec=10m', 'Persistent=true', 'Unit=arena-flywheel.service']) {
      assert.ok(d.includes(want), want);
    }
    const r = sh('systemd-analyze', ['calendar', '--iterations=2', '*-*-* 10:17:00 America/Toronto'], { env: { ...process.env, TZ: 'America/Toronto' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Next elapse: \w{3} \d{4}-\d{2}-\d{2} 10:17:00 E[DS]T/);
  });
  test('service: oneshot, never restarted, 8h start timeout, graceful mixed kill, no ProtectSystem/ProtectHome', () => {
    const d = directives(service);
    for (const want of ['Type=oneshot', 'Restart=no', 'TimeoutStartSec=8h', 'KillMode=mixed', 'TimeoutStopSec=10min',
      'StateDirectory=arena-flywheel', 'ConfigurationDirectory=arena-flywheel', 'UMask=0077', 'NoNewPrivileges=yes',
      'RequiresMountsFor=%h/.cache/huggingface /var/lib/containerd']) assert.ok(d.includes(want), want);
    assert.ok(!d.some(l => /^(ProtectSystem|ProtectHome|ReadWritePaths|PrivateTmp)=/.test(l)));
    assert.ok(!/network-online/.test(d.join('\n')), 'the user manager has no network-online.target');
    assert.ok(d.includes('ExecStart=%h/metaharness/integrations/openenv-arena-darwin/flywheel/systemd/run-tick.sh'));
    assert.ok(statSync(join(UNITS, 'run-tick.sh')).mode & 0o100, 'run-tick.sh must be executable');
    const post = d.find(l => l.startsWith('ExecStopPost='));
    assert.match(post, /^ExecStopPost=-/, 'the summary must never fail the unit');
    assert.match(post, /report\.mjs --format md/);
    assert.doesNotMatch(service, /post-report/, 'the flywheel unit never posts');
    assert.ok(d.includes('LimitCORE=0'), 'no core file in the repo working directory');
  });
  test('recovery units: verify cleanly; hourly + after boot; serialised with ticks; can only sweep (recover.mjs)', { skip: !hasAnalyze }, () => {
    const rs = join(UNITS, 'arena-flywheel-recover.service'), rt = join(UNITS, 'arena-flywheel-recover.timer');
    const r = sh('systemd-analyze', ['--user', 'verify', rs, rt]);
    assert.equal(`${r.stdout}${r.stderr}`.trim(), '');
    const ds = directives(readFileSync(rs, 'utf8')), dt = directives(readFileSync(rt, 'utf8'));
    for (const want of ['OnBootSec=5min', 'OnUnitActiveSec=1h', 'Unit=arena-flywheel-recover.service']) assert.ok(dt.includes(want), want);
    for (const want of ['Type=oneshot', 'Restart=no', 'UMask=0077', 'NoNewPrivileges=yes', 'LimitCORE=0']) assert.ok(ds.includes(want), want);
    const exec = ds.find(l => l.startsWith('ExecStart='));
    assert.match(exec, /^ExecStart=\/usr\/bin\/flock -n -E 0 %S\/arena-flywheel\/tick\.flock \/usr\/bin\/node .*\/flywheel\/recover\.mjs --state-dir %S\/arena-flywheel$/);
    const src = readFileSync(join(FLY, 'recover.mjs'), 'utf8');
    for (const forbidden of [/arena-api/, /provisionGpu/, /render-and-check/, /finish\.mjs/, /decide\.mjs/, /wire\.mjs/]) assert.doesNotMatch(src, forbidden);
  });
});

describe('run-tick.sh', () => {
  const base = join(tmp, 'tick');
  const conf = join(base, 'conf'), state = join(base, 'state');
  mkdirSync(conf, { recursive: true });
  writeFileSync(join(conf, 'config.json'), '{"mode":"dry-run"}');
  writeFileSync(join(base, 'token'), 'hf_dummy_not_a_real_token');
  const record = join(base, 'entry-record.json');
  const entry = join(base, 'entry.mjs');
  writeFileSync(entry, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ARENA_FLYWHEEL_') || k === 'VASTAI_NO_UPDATE_CHECK')) }));
process.exit(7);\n`);
  const env = (over = {}) => ({ PATH: process.env.PATH, HOME: base, NODE: process.execPath, NM_ONLINE: 'true',
    CONFIGURATION_DIRECTORY: conf, STATE_DIRECTORY: state, HF_TOKEN_PATH: join(base, 'token'), ARENA_FLYWHEEL_ENTRY: entry, ...over });
  const tick = over => { rmSync(record, { force: true }); return sh(join(UNITS, 'run-tick.sh'), [], { env: env(over) }); };

  test('execs the orchestrator with config, state dir, shell timestamps and the Toronto date; returns its exit code', () => {
    const r = tick();
    assert.equal(r.status, 7, r.stderr);
    const got = JSON.parse(readFileSync(record, 'utf8'));
    const i = k => got.argv[got.argv.indexOf(k) + 1];
    assert.equal(got.argv[0], '--config');
    assert.equal(i('--config'), join(conf, 'config.json'));
    assert.equal(i('--state-dir'), state);
    assert.match(i('--now'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(i('--date'), sh('date', ['+%F'], { env: { TZ: 'America/Toronto' } }).stdout.trim());
    assert.deepEqual(got.env, { ARENA_FLYWHEEL_CONFIG: i('--config'), ARENA_FLYWHEEL_STATE_DIR: state, ARENA_FLYWHEEL_STARTED_AT: i('--now'),
      ARENA_FLYWHEEL_RUN_DATE: i('--date'), ARENA_FLYWHEEL_ENTRY: entry, VASTAI_NO_UPDATE_CHECK: '1' });
    assert.equal(statSync(state).mode & 0o777, 0o700);
  });
  for (const [name, over, msg] of [
    ['missing entry', { ARENA_FLYWHEEL_ENTRY: join(base, 'nope.mjs') }, /orchestrator entry missing/],
    ['missing config', { CONFIGURATION_DIRECTORY: join(base, 'noconf') }, /config missing/],
    ['missing token file', { HF_TOKEN_PATH: join(base, 'no-token') }, /HF token file missing or empty/],
    ['empty token file', { HF_TOKEN_PATH: '/dev/null' }, /HF token file missing or empty/],
    ['network down', { NM_ONLINE: 'false' }, /network not online/],
  ]) {
    test(`fails closed without starting the orchestrator: ${name}`, () => {
      const r = tick(over);
      assert.equal(r.status, 1);
      assert.match(r.stderr, msg);
      assert.match(r.stderr, /FAIL-CLOSED/);
      assert.ok(!existsSync(record));
    });
  }
  test('a second concurrent tick is refused by the flock once the wait runs out (and never touches journal.mjs flywheel.lock)', async () => {
    mkdirSync(state, { recursive: true });
    const holder = spawn('flock', [join(state, 'tick.flock'), 'sleep', '10'], { stdio: 'ignore' });
    try {
      await new Promise(r => setTimeout(r, 300));
      const r = tick({ ARENA_FLYWHEEL_FLOCK_WAIT_S: '1' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /another tick \(or a recovery sweep\) holds/);
      assert.ok(!existsSync(join(state, 'flywheel.lock')));
    } finally { holder.kill('SIGKILL'); }
  });
  test('a short holder (the hourly recovery sweep) is waited for, not a lost day', async () => {
    mkdirSync(state, { recursive: true });
    const holder = spawn('flock', [join(state, 'tick.flock'), 'sleep', '1'], { stdio: 'ignore' });
    try {
      await new Promise(r => setTimeout(r, 300));
      const r = tick({ ARENA_FLYWHEEL_FLOCK_WAIT_S: '30' });
      assert.equal(r.status, 7, r.stderr);
      assert.ok(existsSync(record), 'the orchestrator ran after the holder released the lock');
    } finally { holder.kill('SIGKILL'); }
  });
  test('the token file is never read, only tested for existence', () => {
    const src = readFileSync(join(UNITS, 'run-tick.sh'), 'utf8');
    assert.doesNotMatch(src.split('\n').filter(l => !l.trim().startsWith('#')).join('\n'), /(cat|read|<)\s*"?\$TOKEN_FILE/);
  });
});

describe('install.sh', () => {
  const home = join(tmp, 'home');
  const fly = join(home, 'metaharness', 'integrations', 'openenv-arena-darwin', 'flywheel');
  const bin = join(tmp, 'bin');
  const log = join(tmp, 'systemctl.log');
  mkdirSync(join(fly, 'systemd'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const f of ['install.sh', 'report.mjs']) copyFileSync(join(FLY, f), join(fly, f));
  for (const f of ['arena-flywheel.service', 'arena-flywheel.timer', 'arena-flywheel-recover.service', 'arena-flywheel-recover.timer',
    'run-tick.sh']) copyFileSync(join(UNITS, f), join(fly, 'systemd', f));
  chmodSync(join(fly, 'install.sh'), 0o755);
  chmodSync(join(fly, 'systemd', 'run-tick.sh'), 0o755);
  writeFileSync(join(fly, 'flywheel.mjs'), '// stub orchestrator entry\n');
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\ncase "$*" in *is-active*) exit 3;; esac\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'loginctl'), '#!/bin/sh\necho yes\n', { mode: 0o755 });
  const unitDir = join(home, '.config', 'systemd', 'user');
  const conf = join(home, '.config', 'arena-flywheel', 'config.json');
  const env = (over = {}) => {
    // XDG_RUNTIME_DIR only lets `systemd-analyze --user verify` initialise; systemctl itself is always the fake.
    const e = { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      SYSTEMCTL: join(bin, 'systemctl'), LOGINCTL: join(bin, 'loginctl'), ...over };
    delete e.XDG_CONFIG_HOME; delete e.XDG_STATE_HOME;
    return e;
  };
  const install = (args = [], over = {}) => { rmSync(log, { force: true }); return sh(join(fly, 'install.sh'), args, { env: env(over) }); };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);

  test('installs: seeds a dry-run config 0600, links both units, reloads and enables --now ONLY the timer', { skip: !hasAnalyze }, () => {
    const r = install();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const c = JSON.parse(readFileSync(conf, 'utf8'));
    assert.equal(c.mode, 'dry-run');
    assert.equal(c.notify.postEnabled, false);
    assert.equal(c.schedule.onCalendar, '*-*-* 10:17:00 America/Toronto');
    assert.equal(statSync(conf).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(conf)).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, '.local', 'state', 'arena-flywheel')).mode & 0o777, 0o700);
    for (const u of ['arena-flywheel.service', 'arena-flywheel.timer', 'arena-flywheel-recover.service', 'arena-flywheel-recover.timer']) {
      assert.ok(lstatSync(join(unitDir, u)).isSymbolicLink());
      assert.equal(readlinkSync(join(unitDir, u)), join(fly, 'systemd', u));
    }
    // The seed must pass the orchestrator's own strict validator, or every tick would exit 2 on day one.
    const loaded = loadConfig(conf, { home });
    assert.equal(loaded.mode, 'dry-run');
    assert.equal(loaded.confirmation.attempts, 8);
    assert.deepEqual(loaded.notify, { postEnabled: false, slackChannel: '' });
    const cl = calls();
    assert.deepEqual(cl.slice(0, 3), ['--user daemon-reload', '--user enable --now arena-flywheel.timer',
      '--user enable --now arena-flywheel-recover.timer']);
    assert.ok(!cl.some(l => /\b(start|restart)\b/.test(l) || /enable.*arena-flywheel\.service/.test(l)), cl.join('\n'));
    assert.match(r.stdout, /mode: dry-run/);
  });
  test('idempotent: a second run keeps an existing config byte-for-byte and warns loudly about auto mode', { skip: !hasAnalyze }, () => {
    const mine = '{ "mode": "auto", "darwin": { "generations": 5 } }\n';
    writeFileSync(conf, mine);
    const r = install();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(conf, 'utf8'), mine);
    assert.match(r.stdout, /config exists, left unchanged/);
    assert.match(r.stderr, /mode is AUTO/);
    assert.ok(lstatSync(join(unitDir, 'arena-flywheel.timer')).isSymbolicLink());
  });
  test('refuses an unusable config, a foreign unit file, a missing orchestrator, or another checkout', { skip: !hasAnalyze }, () => {
    writeFileSync(conf, '{"mode":"yolo"}');
    assert.equal(install().status, 1);
    writeFileSync(conf, '{"mode":"dry-run"}');
    unlinkSync(join(unitDir, 'arena-flywheel.timer'));
    writeFileSync(join(unitDir, 'arena-flywheel.timer'), '[Timer]\n');
    const foreign = install();
    assert.equal(foreign.status, 1);
    assert.match(foreign.stderr, /refusing to replace/);
    assert.equal(readFileSync(join(unitDir, 'arena-flywheel.timer'), 'utf8'), '[Timer]\n');
    unlinkSync(join(unitDir, 'arena-flywheel.timer'));
    unlinkSync(join(fly, 'flywheel.mjs'));
    const noEntry = install();
    assert.equal(noEntry.status, 1);
    assert.match(noEntry.stderr, /does not exist yet/);
    assert.deepEqual(calls(), []);
    writeFileSync(join(fly, 'flywheel.mjs'), '// stub\n');
    const other = install([], { HOME: join(tmp, 'elsewhere') });
    assert.equal(other.status, 1);
    assert.match(other.stderr, /hard-code/);
  });
  test('any systemd-analyze verify output fails the install before anything is linked', () => {
    writeFileSync(join(bin, 'fake-analyze'), '#!/bin/sh\necho "arena-flywheel.service:3: Unknown key"\nexit 0\n', { mode: 0o755 });
    const r = install([], { SYSTEMD_ANALYZE: join(bin, 'fake-analyze') });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /reported problems/);
    assert.deepEqual(calls(), []);
  });
  test('--uninstall disables the timer, removes only our links, keeps config and state', { skip: !hasAnalyze }, () => {
    assert.equal(install().status, 0);
    const r = install(['--uninstall']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(unitDir, 'arena-flywheel.service')) && !existsSync(join(unitDir, 'arena-flywheel.timer')));
    assert.ok(existsSync(conf));
    assert.ok(existsSync(join(home, '.local', 'state', 'arena-flywheel')));
    assert.ok(calls().includes('--user disable --now arena-flywheel.timer'));
    assert.ok(calls().includes('--user disable --now arena-flywheel-recover.timer'));
    assert.ok(!existsSync(join(unitDir, 'arena-flywheel-recover.service')) && !existsSync(join(unitDir, 'arena-flywheel-recover.timer')));
    assert.ok(!calls().some(l => /\bstop arena-flywheel\.service/.test(l)), 'a running tick is never stopped by uninstall');
  });
  test('rejects unknown arguments; --verify only verifies', { skip: !hasAnalyze }, () => {
    assert.equal(install(['--force']).status, 1);
    const v = install(['--verify']);
    assert.equal(v.status, 0, v.stderr);
    assert.match(v.stdout, /units verified/);
    assert.deepEqual(calls(), []);
  });
});
