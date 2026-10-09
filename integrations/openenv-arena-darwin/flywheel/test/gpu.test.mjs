// provisionGpu / destroyConfirmed against a fake vastai, gcloud and ssh on PATH. No network, no GPU, no money.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { destroyConfirmed, provisionGpu, recoverStaleRuns, VLLM_IMAGE_LIST_DIGEST } from '../gpu.mjs';
import { makeVastCli } from '../gpu-vast-cli.mjs';
import { SpendRefused } from '../gpu-spend.mjs';
import { assertCleanVastCalls, assertNoSecrets, DUMMY_KEY, makeShims, SENTINEL_IAK, SENTINEL_JUP } from './gpu-fakes/shims.mjs';

const T0 = Date.parse('2026-10-09T12:00:00Z');
const ROW = { id: 4242, actual_status: 'running', intended_status: 'running', label: 'arena-flywheel-t1', dph_total: 1.6,
  public_ipaddr: '203.0.113.5', ports: { '22/tcp': [{ HostIp: '0.0.0.0', HostPort: '40022' }, { HostIp: '::', HostPort: '40022' }] },
  jupyter_token: SENTINEL_JUP, onstart: 'vllm serve ...', extra_env: { A: 'b' }, start_date: 1 };
const GONE = { instances: null };
const base = () => ({
  user: [{ stdout: { id: 1, credit: 50, email: 'x@example.invalid' } }],
  search: [{ stdout: [{ id: 77, dph_total: 1.6, num_gpus: 1, gpu_ram: 81920 }, { id: 78, dph_total: 9, num_gpus: 1, gpu_ram: 81920 }] }],
  create: [{ stdout: { success: true, new_contract: 4242, instance_api_key: SENTINEL_IAK } }],
  attach: [{ stdout: "{'success': True, 'msg': 'attached'}\n" }],
  show: [{ stdout: { ...ROW, actual_status: 'loading', public_ipaddr: null, ports: null } }, { stdout: ROW }, { stdout: GONE }],
  destroy: [{ stdout: '' }],
  showAll: [{ stdout: [] }],
});

function harness(t, scenarioPatch = {}, shimOpts = {}) {
  const shims = makeShims({ scenario: { ...base(), ...scenarioPatch }, ...shimOpts });
  t.after(() => shims.cleanup());
  let clock = T0;
  const events = [];
  const launches = [];
  const opts = {
    runId: 't1', stateDir: shims.stateDir, pathEnv: shims.pathEnv, installTraps: false,
    now: () => clock,
    // fake clock; short waits (tunnel settle) are real so child processes get time to start or die
    sleep: async (ms) => { clock += ms; await new Promise(r => setTimeout(r, ms <= 500 ? ms : 20)); },
    journal: (e) => events.push(e),
    launch: async (a) => { launches.push({ ...a, stopped: false }); const l = launches.at(-1); return { how: 'fake', stop: () => { l.stopped = true; } }; },
    config: { sshKeyPath: shims.keyPath, destroyBackoffSec: 1, tunnelSettleSec: 0.2 },
  };
  const ledger = () => (existsSync(path.join(shims.stateDir, 'spend.jsonl'))
    ? readFileSync(path.join(shims.stateDir, 'spend.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const leakCheck = (...extra) => assertNoSecrets(assert, JSON.stringify(events), JSON.stringify(ledger()), ...extra);
  return { shims, opts, events, launches, ledger, leakCheck };
}

test('NaN / negative / Infinity caps and hours refuse before any gcloud or vastai call', async (t) => {
  for (const bad of [{ dailyCapUsd: NaN }, { totalCapUsd: -200 }, { dailyCapUsd: Infinity }, { maxGpuHours: -1 }, { maxGpuHours: NaN }, { maxDphUsd: -3 }]) {
    const h = harness(t);
    await assert.rejects(provisionGpu({ ...h.opts, config: { ...h.opts.config, ...bad } }), SpendRefused, JSON.stringify(bad));
    assert.equal(h.shims.vastCalls().length, 0);
    assert.equal(h.shims.gcloudCalls().length, 0);
  }
});

test('corrupt ledger refuses before any call; an exhausted daily cap refuses before any call', async (t) => {
  const h = harness(t);
  mkdirSync(h.shims.stateDir, { recursive: true });
  writeFileSync(path.join(h.shims.stateDir, 'spend.jsonl'), '{"v":1,"type":"seed","ts":"2026-10-01T00:00:00Z","usd":-5}\n');
  await assert.rejects(provisionGpu(h.opts), SpendRefused);
  writeFileSync(path.join(h.shims.stateDir, 'spend.jsonl'), [
    { v: 1, type: 'seed', ts: '2026-10-01T00:00:00Z', usd: 5 },
    { v: 1, type: 'planned', ts: new Date(T0 - 3_600_000).toISOString(), runId: 'earlier', usd: 12, dphTotal: 3, hours: 4, offerId: 1 },
  ].map(r => JSON.stringify(r)).join('\n'));
  await assert.rejects(provisionGpu(h.opts), /daily cap already reached/);
  assert.equal(h.shims.vastCalls().length, 0);
  assert.equal(h.shims.gcloudCalls().length, 0);
});

test('credit too low (or missing) refuses: no create, no planned row', async (t) => {
  for (const user of [{ stdout: { credit: 1.0 } }, { stdout: { balance: 99 } }, { stdout: { credit: 'lots' } }]) {
    const h = harness(t, { user: [user] });
    await assert.rejects(provisionGpu(h.opts), /credit/);
    assert.deepEqual(h.shims.vastCalls().map(c => c.cmd), ['user', 'search']);
    assert.deepEqual(h.ledger().map(r => r.type), ['seed']);
    assertCleanVastCalls(assert, h.shims.vastCalls());
  }
});

test('Secret Manager fetch fails: refuse before any vastai call; gcloud stderr is not echoed', async (t) => {
  const h = harness(t, {}, { gcloud: 'fail' });
  const err = await provisionGpu(h.opts).catch(e => e);
  assert.equal(err.message, 'VAST_API_KEY fetch from Secret Manager failed');
  assert.equal(h.shims.gcloudCalls().length, 1);
  assert.equal(h.shims.vastCalls().length, 0);
  assert.deepEqual(h.ledger().map(r => r.type), ['seed']);
});

test('show user HTTP error (exit 0, empty stdout, JSON on stderr) is a failure, not success', async (t) => {
  const h = harness(t, { user: [{ stdout: '', stderr: { error: true, status_code: 401, msg: `Invalid user key ${DUMMY_KEY}` } }] });
  const err = await provisionGpu(h.opts).catch(e => e);
  assert.match(err.message, /show user: http 401/);
  assertNoSecrets(assert, err.message, err.stack);
  assert.deepEqual(h.shims.vastCalls().map(c => c.cmd), ['user']);
});

test('definite create failure: nothing destroyed, run cancelled in the ledger, nothing leaked', async (t) => {
  const cases = [
    { stdout: { success: false, msg: 'no such ask', instance_api_key: SENTINEL_IAK } },
    { stdout: '', stderr: { error: true, status_code: 400, msg: `bad request instance_api_key=${SENTINEL_IAK}` } },
  ];
  for (const create of cases) {
    const h = harness(t, { create: [create] });
    const err = await provisionGpu(h.opts).catch(e => e);
    assert.ok(err instanceof Error);
    const cmds = h.shims.vastCalls().map(c => c.cmd);
    assert.deepEqual(cmds, ['user', 'search', 'create']);
    assert.deepEqual(h.ledger().map(r => r.type), ['seed', 'planned', 'cancelled']);
    assert.deepEqual(h.launches.map(l => [l.instanceId, l.stopped]), [[null, true]], 'label watchdog armed before create, stopped after the rejection');
    h.leakCheck(err.message, err.stack);
    assertCleanVastCalls(assert, h.shims.vastCalls());
  }
});

test('ambiguous create (transport failure): label rechecked for ambiguousRecheckSec; none found -> plan stays charged, label watchdog stays armed', async (t) => {
  const h = harness(t, { create: [{ stdout: `{"success": true, "instance_api_key": "${SENTINEL_IAK}"`, stderr: `Traceback ... ${SENTINEL_IAK}\n`, exit: 1 }] });
  const err = await provisionGpu(h.opts).catch(e => e);
  assert.match(err.message, /create instance: transport/);
  const cmds = h.shims.vastCalls().map(c => c.cmd);
  assert.deepEqual(cmds.slice(0, 3), ['user', 'search', 'create']);
  assert.equal(h.shims.vastCalls('showAll').length, 9, 'lookups at 0, 30, ..., 240 s (a fresh instance can take minutes to be listed)');
  assert.deepEqual(h.shims.vastCalls('showAll')[0].argv.slice(0, 4), ['show', 'instances', '--label', 'arena-flywheel-t1']);
  assert.deepEqual(h.ledger().map(r => r.type), ['seed', 'planned']);
  assert.deepEqual(h.launches.map(l => [l.instanceId, l.label, l.stopped]), [[null, 'arena-flywheel-t1', false]],
    'the label-mode watchdog was armed before create and is left to find it at the deadline');
  h.leakCheck(err.message, err.stack);
});

test('ambiguous create, the instance shows up on the 3rd lookup: destroyed, settled at its real cost, watchdog stopped', async (t) => {
  const h = harness(t, { create: [{ stdout: '', stderr: { error: true, status_code: 504, msg: 'gateway timeout' } }],
    showAll: [{ stdout: [] }, { stdout: [] }, { stdout: [ROW] }], show: [{ stdout: GONE }] });
  await assert.rejects(provisionGpu(h.opts), /create instance: http 504/);
  assert.equal(h.shims.vastCalls('showAll').length, 3);
  assert.deepEqual(h.shims.vastCalls('destroy').map(c => c.argv[2]), ['4242']);
  const rows = h.ledger();
  assert.deepEqual(rows.map(r => r.type), ['seed', 'planned', 'settled']);
  assert.equal(rows[2].ambiguous, true);
  assert.ok(rows[2].usd >= rows[1].usd, 'never below the plan');
  assert.equal(h.launches[0].stopped, true);
});

test('ambiguous create where the instance did get created: found by label and destroyed', async (t) => {
  const h = harness(t, { create: [{ stdout: 'garbage', exit: 0 }], showAll: [{ stdout: [ROW, { ...ROW, id: 5, label: 'someone-else' }] }], show: [{ stdout: GONE }] });
  await assert.rejects(provisionGpu(h.opts), /create instance: parse/);
  const destroys = h.shims.vastCalls('destroy');
  assert.equal(destroys.length, 1);
  assert.equal(destroys[0].argv[2], '4242');
  assert.ok(destroys[0].argv.includes('-y'));
  assert.ok(h.events.some(e => e.phase === 'gpu.orphan_destroyed' && e.confirmed === true));
});

test('happy path: pinned image, watchdog first, tunnel + /v1/models, then a confirmed teardown settles the ledger', async (t) => {
  const h = harness(t);
  const gpu = await provisionGpu(h.opts);
  assert.match(gpu.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.equal(gpu.instanceId, 4242);
  assert.equal(gpu.dphTotal, 1.6);
  assert.equal(gpu.plannedUsd, 5.2);
  const models = await (await fetch(`${gpu.baseUrl}/models`)).json();
  assert.equal(models.data[0].id, 'qwen38');

  const create = h.shims.vastCalls('create')[0].argv;
  assert.equal(create[create.indexOf('--image') + 1], `vllm/vllm-openai@${VLLM_IMAGE_LIST_DIGEST}`);
  assert.equal(create[create.indexOf('--label') + 1], 'arena-flywheel-t1');
  assert.match(create[create.indexOf('--onstart-cmd') + 1], /^vllm serve Qwen\/Qwen3\.8-27B .*--served-model-name qwen38 --reasoning-parser qwen3$/);
  for (const f of ['--ssh', '--direct', '--cancel-unavail']) assert.ok(create.includes(f), f);
  assert.equal(create[create.indexOf('--disk') + 1], '150');
  const search = h.shims.vastCalls('search')[0].argv;
  assert.equal(search[search.indexOf('--storage') + 1], '150', '--storage must equal --disk');
  assert.match(search[2], /cuda_vers>=13\.0/);
  assert.deepEqual(h.shims.vastCalls('attach')[0].argv.slice(0, 4), ['attach', 'ssh', '4242', `${h.shims.keyPath}.pub`]);

  assert.equal(h.launches.length, 1);
  assert.deepEqual([h.launches[0].instanceId, h.launches[0].label], [null, 'arena-flywheel-t1'], 'label mode: armed before the id exists');
  assert.equal(h.launches[0].deadlineEpoch, Math.ceil((T0 + 3 * 3_600_000) / 1000), 'deadline = create + maxGpuHours');
  const order = h.events.map(e => e.phase);
  assert.ok(order.indexOf('gpu.watchdog_started') < order.indexOf('gpu.created'), 'watchdog BEFORE create: no instance ever exists without one');
  assert.ok(order.indexOf('gpu.spend_ok') < order.indexOf('gpu.watchdog_started'));

  const ssh = h.shims.sshCalls()[0].argv;
  for (const f of ['IdentitiesOnly=yes', 'BatchMode=yes', 'ExitOnForwardFailure=yes', 'StrictHostKeyChecking=accept-new']) assert.ok(ssh.includes(f), f);
  assert.deepEqual([ssh[ssh.indexOf('-i') + 1], ssh[ssh.indexOf('-p') + 1], ssh.at(-1)], [h.shims.keyPath, '40022', 'root@203.0.113.5']);
  assert.deepEqual(h.shims.sshCalls()[0].envKeys.filter(k => !['PATH', 'HOME', 'PWD', 'SHLVL', '_'].includes(k)), []);

  const res = await gpu.teardown();
  assert.equal(res.confirmed, true);
  assert.equal(await gpu.teardown(), res, 'idempotent');
  assert.equal(h.launches[0].stopped, true, 'watchdog stopped only after a confirmed destroy');
  const types = h.ledger().map(r => r.type);
  assert.deepEqual(types, ['seed', 'planned', 'settled']);
  const settled = h.ledger()[2];
  assert.ok(settled.usd > 0 && settled.usd < 5.2 && settled.instanceId === 4242);
  await assert.rejects(fetch(`${gpu.baseUrl}/models`, { signal: AbortSignal.timeout(2000) }), 'tunnel closed');
  assertCleanVastCalls(assert, h.shims.vastCalls());
  assert.equal(h.shims.gcloudCalls().length, 1);
  assert.match(h.shims.gcloudCalls()[0], /^secrets versions access latest --secret=VAST_API_KEY --project=cognitum-20260110$/);
  h.leakCheck();
});

test('failure after create (attach never succeeds): instance destroyed and confirmed, error rethrown', async (t) => {
  const h = harness(t, { attach: [{ stdout: '', stderr: { error: true, status_code: 500, msg: 'boom' } }], show: [{ stdout: ROW }, { stdout: GONE }] });
  await assert.rejects(provisionGpu(h.opts), /attach ssh: http 500/);
  assert.equal(h.shims.vastCalls('attach').length, 5);
  assert.equal(h.shims.vastCalls('destroy').length, 2, 'first confirm still showed the row');
  assert.deepEqual(h.ledger().map(r => r.type), ['seed', 'planned', 'settled']);
  assert.equal(h.launches[0].stopped, true);
});

test('watchdog launch failure (e.g. no user bus): refused BEFORE create, nothing rented, run cancelled', async (t) => {
  const h = harness(t, { show: [{ stdout: GONE }] });
  await assert.rejects(provisionGpu({ ...h.opts, launch: async () => { throw new Error('watchdog unit not active'); } }), /watchdog unit not active/);
  assert.deepEqual(h.shims.vastCalls().map(c => c.cmd), ['user', 'search'], 'no create, no destroy needed');
  assert.deepEqual(h.ledger().map(r => r.type), ['seed', 'planned', 'cancelled']);
});

test('destroy is retried until show instance confirms the instance is gone', async (t) => {
  const h = harness(t, {
    destroy: [{ stdout: '', stderr: { error: true, status_code: 503, msg: 'busy' } }, { stdout: '' }],
    show: [{ stdout: ROW }, { stdout: ROW }, { stdout: GONE }],
  });
  const cli = makeVastCli({ key: DUMMY_KEY, pathEnv: h.shims.pathEnv });
  const d = await destroyConfirmed(cli, 4242, { attempts: 6, backoffMs: 1, journal: e => h.events.push(e) });
  assert.deepEqual(d, { confirmed: true, destroyCalls: 3 });
  assert.ok(h.events.some(e => e.phase === 'gpu.destroy_error'));
  assertCleanVastCalls(assert, h.shims.vastCalls());
});

test('destroy that never confirms: teardown reports unconfirmed, keeps the plan charged and leaves the watchdog running', async (t) => {
  const h = harness(t, { show: [{ stdout: { ...ROW, actual_status: 'loading', ports: null } }, { stdout: ROW }] });
  const gpu = await provisionGpu({ ...h.opts, config: { ...h.opts.config, destroyAttempts: 3 } });
  assert.deepEqual(await gpu.teardown(), { confirmed: false });
  assert.equal(h.shims.vastCalls('destroy').length, 3);
  assert.deepEqual(h.ledger().map(r => r.type), ['seed', 'planned']);
  assert.equal(h.launches[0].stopped, false);
  assert.ok(h.events.some(e => e.phase === 'gpu.destroy_unconfirmed'));
});

test('ssh refused at first: tunnel retried; boot timeout destroys', async (t) => {
  const h = harness(t, {}, { ssh: 'fail' });
  await assert.rejects(provisionGpu({ ...h.opts, config: { ...h.opts.config, modelTimeoutMin: 1, pollSec: 15 } }), /modelTimeoutMin/);
  assert.ok(h.shims.sshCalls().length >= 2, 'tunnel retried');
  assert.ok(h.events.some(e => e.phase === 'gpu.tunnel_retry'));
  assert.ok(h.events.some(e => e.phase === 'gpu.destroyed'));
  // boot polls at +0/15/30/45/60 s see 'loading'; +75 s > 1 min -> timeout; teardown's first confirm sees GONE
  const loading = { stdout: { ...ROW, actual_status: 'loading' } };
  const h2 = harness(t, { show: [loading, loading, loading, loading, loading, { stdout: GONE }] });
  await assert.rejects(provisionGpu({ ...h2.opts, config: { ...h2.opts.config, bootTimeoutMin: 1 } }), /bootTimeoutMin/);
  assert.equal(h2.shims.vastCalls('show').length, 6);
  assert.equal(h2.shims.vastCalls('destroy').length, 1);
  assert.ok(h2.events.some(e => e.phase === 'gpu.destroyed'));
});

test('stale open runs (reboot / SIGKILL) are swept by label and closed at their REAL cost; live-window runs are untouched', async (t) => {
  const h = harness(t, {
    showAll: [{ stdout: [{ ...ROW, id: 5151, label: 'arena-flywheel-old1' }, { ...ROW, id: 6, label: 'arena-flywheel-fresh' }] }],
    show: [{ stdout: GONE }, { stdout: { ...ROW, actual_status: 'loading' } }, { stdout: ROW }, { stdout: GONE }],
  });
  mkdirSync(h.shims.stateDir, { recursive: true });
  writeFileSync(path.join(h.shims.stateDir, 'spend.jsonl'), [
    { v: 1, type: 'seed', ts: '2026-10-01T00:00:00Z', usd: 5 },
    { v: 1, type: 'planned', ts: new Date(T0 - 4 * 3_600_000).toISOString(), runId: 'old1', usd: 4, dphTotal: 1.23, hours: 3.25, offerId: 1 },
    { v: 1, type: 'planned', ts: new Date(T0 - 1 * 3_600_000).toISOString(), runId: 'fresh', usd: 1, dphTotal: 0.3, hours: 3.25, offerId: 2 },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  const gpu = await provisionGpu(h.opts);
  await gpu.teardown();
  const lookups = h.shims.vastCalls('showAll').map(c => c.argv[3]);
  assert.deepEqual(lookups, ['arena-flywheel-old1'], 'only the stale run is looked up');
  assert.deepEqual(h.shims.vastCalls('destroy').map(c => c.argv[2]), ['5151', '4242']);
  const old = h.ledger().find(r => r.runId === 'old1' && r.type === 'settled');
  assert.deepEqual([old.usd, old.hours, old.swept, old.found], [4.92, 4, true, 1], 'found alive 4 h after planned at 1.23 USD/h: 4.92, not the 4.00 plan');
  assert.equal(h.ledger().filter(r => r.runId === 'fresh').length, 1, 'fresh run left open');
});

test('a stale orphan is swept even when the caps then refuse the new rental', async (t) => {
  const h = harness(t, { showAll: [{ stdout: [{ ...ROW, id: 5151, label: 'arena-flywheel-old1' }] }], show: [{ stdout: GONE }] });
  mkdirSync(h.shims.stateDir, { recursive: true });
  writeFileSync(path.join(h.shims.stateDir, 'spend.jsonl'), [
    { v: 1, type: 'seed', ts: '2026-10-01T00:00:00Z', usd: 5 },
    { v: 1, type: 'planned', ts: new Date(T0 - 4 * 3_600_000).toISOString(), runId: 'old1', usd: 12, dphTotal: 3.69, hours: 3.25, offerId: 1 },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  await assert.rejects(provisionGpu(h.opts), /daily cap already reached/);
  assert.deepEqual(h.shims.vastCalls().map(c => c.cmd), ['showAll', 'destroy', 'show']);
  assert.ok(h.ledger().some(r => r.runId === 'old1' && r.type === 'settled' && r.swept));
  assert.deepEqual(await recoverStaleRuns({ stateDir: h.shims.stateDir, pathEnv: h.shims.pathEnv, now: () => T0 }), [], 'nothing left');
});

test('a runId already in the ledger is refused before any call (a duplicate row would brick the ledger)', async (t) => {
  const h = harness(t);
  const first = await provisionGpu(h.opts);
  await first.teardown();
  const n = h.shims.vastCalls().length;
  await assert.rejects(provisionGpu(h.opts), /runId already in the spend ledger/);
  assert.equal(h.shims.vastCalls().length, n);
});

test('signal traps are installed during provisioning and removed by teardown', async (t) => {
  const h = harness(t);
  const before = process.listenerCount('SIGTERM');
  const gpu = await provisionGpu({ ...h.opts, installTraps: true });
  assert.equal(process.listenerCount('SIGTERM'), before + 1);
  await gpu.teardown();
  assert.equal(process.listenerCount('SIGTERM'), before);
});
