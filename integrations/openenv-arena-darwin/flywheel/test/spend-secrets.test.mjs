// Regressions for the secrets-and-spend review (spend 1-7) and the recovery-only unit. Fake vastai/gcloud/systemd-run on
// PATH; nothing reaches Vast, Google, a real GPU or the user manager.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { darwinChildEnv, makeDarwinSteps } from '../darwin-steps.mjs';
import { defaultConfig } from '../flywheel-config.mjs';
import { destroyInstance, launchWatchdog, provisionGpu, recoverStaleRuns, WATCHDOG_PATH } from '../gpu.mjs';
import { checkSpend, loadLedger, rentalsJournaled, SpendRefused } from '../gpu-spend.mjs';
import { recover } from '../recover.mjs';
import { DUMMY_KEY, makeShims, SENTINEL_IAK } from './gpu-fakes/shims.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse('2026-10-09T12:00:00Z');
const H = 3_600_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJsonl = p => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const writeLedger = (dir, rows) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'spend.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n'); };
const SEED = { v: 1, type: 'seed', ts: '2026-10-01T00:00:00Z', usd: 5 };

test('spend 1: SIGTERM while `create` is in flight: the create is awaited, the instance destroyed BY ID, the run settled', async (t) => {
  const s = makeShims({ scenario: { user: [{ stdout: { credit: 50 } }], search: [{ stdout: [{ id: 77, dph_total: 3.5, num_gpus: 1, gpu_ram: 81920 }] }],
    create: [{ stdout: { success: true, new_contract: 4242, instance_api_key: SENTINEL_IAK } }], show: [{ stdout: { instances: null } }],
    destroy: [{ stdout: '' }], showAll: [{ stdout: [] }] } });
  t.after(() => s.cleanup());
  const marker = join(s.dir, 'create-started'); // the wrapped fake `create instance` marks its start, then takes 3 s
  const real = readFileSync(join(s.bin, 'vastai'), 'utf8').split('\n').find(l => l.startsWith('exec '));
  writeFileSync(join(s.bin, 'vastai'), `#!/bin/sh\nif [ "$1 $2" = "create instance" ]; then : > '${marker}'; sleep 3; fi\n${real}\n`);
  const log = join(s.dir, 'events.jsonl');
  const child = spawn(process.execPath, [join(HERE, 'gpu-fakes', 'provision-child.mjs'), s.stateDir, s.pathEnv, s.keyPath, log], { stdio: 'ignore' });
  const exited = new Promise(r => child.on('exit', (code, signal) => r({ code, signal })));
  for (let i = 0; i < 100 && !existsSync(marker); i++) await sleep(50);
  assert.ok(existsSync(marker), 'create is in flight');
  child.kill('SIGTERM'); // what systemd sends on stop/shutdown (KillMode=mixed: the main process only)
  assert.deepEqual(await exited, { code: 143, signal: null });
  assert.deepEqual(s.vastCalls().map(c => c.cmd), ['user', 'search', 'create', 'destroy', 'show']);
  assert.equal(s.vastCalls('destroy')[0].argv[2], '4242');
  const ledger = readJsonl(join(s.stateDir, 'spend.jsonl'));
  assert.deepEqual(ledger.map(r => r.type), ['seed', 'planned', 'settled']);
  assert.equal(ledger[2].instanceId, 4242);
  const ev = readJsonl(log).map(e => e.phase);
  assert.ok(ev.indexOf('WATCHDOG_LAUNCHED') >= 0 && ev.indexOf('WATCHDOG_LAUNCHED') < ev.indexOf('gpu.created'), ev.join(','));
  assert.equal(readJsonl(log).find(e => e.phase === 'WATCHDOG_LAUNCHED').instanceId, null, 'label mode');
  assert.ok(ev.includes('WATCHDOG_STOPPED') && ev.includes('gpu.destroyed') && !ev.includes('PROVISION_RETURNED'), ev.join(','));
});

test('spend 3: an orphan destroyed by id settles its ledger run at its real duration (once)', async (t) => {
  const s = makeShims({ scenario: { destroy: [{ stdout: '' }], show: [{ stdout: { instances: null } }] } });
  t.after(() => s.cleanup());
  writeLedger(s.stateDir, [SEED, { v: 1, type: 'planned', ts: new Date(T0 - 22 * H).toISOString(), runId: 'fw-2026-10-08-g1', usd: 11.375, dphTotal: 3.5, hours: 3.25, offerId: 1 }]);
  const opts = { runId: 'fw-2026-10-08-g1', stateDir: s.stateDir, pathEnv: s.pathEnv, getKey: async () => DUMMY_KEY, now: () => T0, sleep: async () => {}, backoffMs: 1 };
  const r = await destroyInstance(4242, opts);
  assert.equal(r.confirmed, true);
  const rows = loadLedger(join(s.stateDir, 'spend.jsonl'), { seedIfMissing: false });
  assert.deepEqual([rows.at(-1).type, rows.at(-1).usd, rows.at(-1).hours, rows.at(-1).orphan], ['settled', 77, 22, true], '22 h x 3.5, not the 11.375 plan');
  await destroyInstance(4242, opts);
  assert.equal(loadLedger(join(s.stateDir, 'spend.jsonl'), { seedIfMissing: false }).length, 3, 'never a second terminal row');
});

test('spend 3: a stale run the watchdog already destroyed is settled until the watchdog confirmed it, not at its plan', async (t) => {
  const s = makeShims({ scenario: { showAll: [{ stdout: [] }] } });
  t.after(() => s.cleanup());
  const planned = T0 - 10 * H;
  writeLedger(s.stateDir, [SEED, { v: 1, type: 'planned', ts: new Date(planned).toISOString(), runId: 'old2', usd: 11.375, dphTotal: 3.5, hours: 3.25, offerId: 1 }]);
  writeFileSync(join(s.stateDir, 'watchdog.jsonl'), `${JSON.stringify({ at: (planned + 5 * H) / 1000, phase: 'destroyed_confirmed', label: 'arena-flywheel-old2' })}\n`);
  const out = await recoverStaleRuns({ stateDir: s.stateDir, pathEnv: s.pathEnv, getKey: async () => DUMMY_KEY, now: () => T0, sleep: async () => {} });
  assert.deepEqual(out, [{ runId: 'old2', found: 0, closed: true }]);
  const last = loadLedger(join(s.stateDir, 'spend.jsonl'), { seedIfMissing: false }).at(-1);
  assert.deepEqual([last.usd, last.hours, last.swept], [17.5, 5, true]);
});

test('spend 4: an inherited provider key never reaches the rented GPU host; children get a random per-run key and no HF credentials', async (t) => {
  const inherited = { PATH: process.env.PATH, HOME: '/home/x', ARENA_MODEL_API_KEY: 'sk-or-v1-SENTINEL-REAL-PROVIDER-KEY', OPENAI_API_KEY: 'sk-1',
    OPENROUTER_API_KEY: 'or-1', AWS_SECRET_ACCESS_KEY: 'a', GITHUB_TOKEN: 'g', HF_TOKEN_PATH: '/x/token', HF_HOME: '/real/hf', DARWIN_ARENA_CACHE_DIR: '/c' };
  const a = darwinChildEnv(inherited), b = darwinChildEnv(inherited);
  assert.match(a.ARENA_MODEL_API_KEY, /^[0-9a-f]{32}$/);
  assert.notEqual(a.ARENA_MODEL_API_KEY, b.ARENA_MODEL_API_KEY, 'fresh per run');
  for (const k of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'HF_TOKEN_PATH']) assert.equal(a[k], undefined, k);
  assert.notEqual(a.HF_HOME, '/real/hf');
  assert.equal(a.HF_HUB_OFFLINE, '1');
  assert.deepEqual([a.PATH, a.HOME, a.DARWIN_ARENA_CACHE_DIR], [inherited.PATH, '/home/x', '/c']);
  // the endpoint probe (lib/provenance.mjs) is what the rented host sees first
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(req.headers.authorization); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"qwen38"}]}'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const d = mkdtempSync(join(tmpdir(), 'fw-key-'));
  mkdirSync(join(d, 'env', 'arena_env'), { recursive: true });
  for (const f of ['tasks.py', 'environment.py']) writeFileSync(join(d, 'env', 'arena_env', f), '#\n');
  writeFileSync(join(d, 'runner.py'), '#\n'); writeFileSync(join(d, 'tok.json'), '{}');
  const c = defaultConfig(d);
  Object.assign(c.evaluator, { envDir: join(d, 'env'), python: '/usr/bin/python3', tokenizerJson: join(d, 'tok.json'), tokenizerSha256: 'a'.repeat(64), runner: join(d, 'runner.py'), cacheDir: join(d, 'cache') });
  const steps = await makeDarwinSteps(c, { env: inherited });
  await steps.expectedProvenance({ seedBase: 700000, attempts: 4, baseUrl: `http://127.0.0.1:${srv.address().port}/v1` });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^Bearer [0-9a-f]{32}$/);
  assert.ok(!seen[0].includes('SENTINEL'));
});

test('spend 5: a deleted ledger is never re-seeded once a rental is journaled (the caps cannot be reset)', async (t) => {
  const fresh = mkdtempSync(join(tmpdir(), 'fw-ledger-'));
  assert.equal(rentalsJournaled(fresh), false);
  assert.equal(loadLedger(join(fresh, 'spend.jsonl'), { nowIso: new Date(T0).toISOString(), seedIfMissing: !rentalsJournaled(fresh) }).length, 1, 'first ever use seeds');
  const s = makeShims({ scenario: {} });
  t.after(() => s.cleanup());
  mkdirSync(s.stateDir, { recursive: true });
  writeFileSync(join(s.stateDir, 'journal.jsonl'), `${JSON.stringify({ date: '2026-10-08', phase: 'gpu', event: 'gpu.spend_ok', plannedUsd: 11.375 })}\n`);
  assert.equal(rentalsJournaled(s.stateDir), true);
  assert.throws(() => loadLedger(join(s.stateDir, 'spend.jsonl'), { nowIso: new Date(T0).toISOString(), seedIfMissing: !rentalsJournaled(s.stateDir) }),
    /ledger missing \(rentals are journaled/);
  await assert.rejects(provisionGpu({ runId: 'g1', stateDir: s.stateDir, pathEnv: s.pathEnv, getKey: async () => DUMMY_KEY, installTraps: false,
    now: () => T0, config: { sshKeyPath: s.keyPath } }), SpendRefused);
  assert.deepEqual([s.vastCalls().length, existsSync(join(s.stateDir, 'spend.jsonl'))], [0, false]);
  writeFileSync(join(s.stateDir, 'journal.jsonl'), '{not json\n');
  assert.equal(rentalsJournaled(s.stateDir), true, 'an unreadable journal fails closed');
});

test('spend 6: the daily cap is the Toronto calendar day of each run: deterministic under timer jitter', () => {
  const day1 = [SEED, { v: 1, type: 'planned', ts: '2026-10-09T14:24:00Z', runId: 'd1', usd: 11.375, dphTotal: 3.5, hours: 3.25, offerId: 1 },
    { v: 1, type: 'settled', ts: '2026-10-09T16:54:00Z', runId: 'd1', usd: 8.75, hours: 2.5 }];
  const spend = nowIso => checkSpend({ rows: day1, nowMs: Date.parse(nowIso), plannedUsd: 11.375, dailyCapUsd: 12, totalCapUsd: 200, credit: 100 });
  for (const at of ['2026-10-10T14:19:00Z', '2026-10-10T14:26:00Z']) assert.equal(spend(at).spentDaily, 0, `day 2 at ${at}: same answer either side of the jitter`);
  assert.throws(() => spend('2026-10-09T20:00:00Z'), /daily cap: 8\.75 \+ 11\.38 > 12/, 'a second rental the same Toronto day is refused');
  assert.throws(() => spend('2026-10-10T03:30:00Z'), /daily cap/, '23:30 Toronto is still 2026-10-09');
});

test('spend 7: launchWatchdog(systemd-run) never passes an empty bus address; label mode; restarts on failure', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-sdrun-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'systemd-run'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/argv'\nenv > '${dir}/env'\n`); chmodSync(join(bin, 'systemd-run'), 0o755);
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\necho active\n'); chmodSync(join(bin, 'systemctl'), 0o755);
  const saved = process.env.DBUS_SESSION_BUS_ADDRESS;
  delete process.env.DBUS_SESSION_BUS_ADDRESS;
  t.after(() => { if (saved !== undefined) process.env.DBUS_SESSION_BUS_ADDRESS = saved; });
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const wd = await launchWatchdog({ instanceId: null, deadlineEpoch: deadline, label: 'arena-flywheel-t1', stateDir: dir, launcher: 'systemd-run',
    pathEnv: `${bin}:${process.env.PATH}`, nowMs: Date.now(), sleep: async () => {} });
  assert.equal(wd.how, 'systemd unit arena-flywheel-wd-t1');
  const argv = readFileSync(join(dir, 'argv'), 'utf8').trim().split('\n');
  for (const a of ['--unit=arena-flywheel-wd-t1', '--property=Restart=on-failure', '--property=RestartPreventExitStatus=2 3']) assert.ok(argv.includes(a), a);
  assert.deepEqual(argv.slice(-4), [WATCHDOG_PATH, '-', String(deadline), 'arena-flywheel-t1']);
  assert.ok(!/^DBUS_SESSION_BUS_ADDRESS=/m.test(readFileSync(join(dir, 'env'), 'utf8')), 'no empty bus address');
});

test('recovery unit (recover.mjs): sweeps orphans by id under the lock, records them closed, and skips while a run holds the lock', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'fw-recover-'));
  writeFileSync(join(stateDir, 'journal.jsonl'), `${JSON.stringify({ date: '2026-10-08', phase: 'gpu', event: 'up', instanceId: 5151, runId: 'fw-2026-10-08-g1' })}\n`);
  const calls = [];
  const gpu = { destroy: async (id, o) => { calls.push([id, o.runId]); return { confirmed: true }; }, recover: async () => [] };
  const r = await recover({ stateDir, now: '2026-10-09T15:00:00Z', gpu });
  assert.deepEqual(calls, [[5151, 'fw-2026-10-08-g1']]);
  assert.ok(r.notes.some(n => n.includes('5151')));
  const j = readJsonl(join(stateDir, 'journal.jsonl'));
  assert.ok(j.some(e => e.event === 'orphan-destroyed' && e.confirmed === true && e.date === '2026-10-09'));
  assert.ok(j.some(e => e.phase === 'recover' && e.event === 'done'));
  await recover({ stateDir, now: '2026-10-09T16:00:00Z', gpu });
  assert.equal(calls.length, 1, 'a confirmed destroy is not repeated');
  writeFileSync(join(stateDir, 'flywheel.lock'), JSON.stringify({ pid: process.pid, date: '2026-10-09' }));
  assert.deepEqual(await recover({ stateDir, now: '2026-10-09T17:00:00Z', gpu, pid: 123456789 }), { skipped: 'a flywheel run holds the lock' });
});
