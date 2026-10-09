// Pure units: spend ledger + caps, offer selection, ports parsing, redaction, CLI guard rails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSpend, loadLedger, precheckCaps, SEED_USD, SpendRefused, summarize } from '../gpu-spend.mjs';
import { makeVastCli, parseSshEndpoint, parseSshPort, redact } from '../gpu-vast-cli.mjs';
import { GPU_DEFAULTS, selectOffer, validateGpuConfig, VLLM_IMAGE_LIST_DIGEST } from '../gpu.mjs';
import { sshTunnelArgs } from '../gpu-tunnel.mjs';
import { spawnSync } from 'node:child_process';
import { DUMMY_KEY } from './gpu-fakes/shims.mjs';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'gpu-spend-'));
const okSpend = { nowMs: NOW, plannedUsd: 6, dailyCapUsd: 12, totalCapUsd: 200, credit: 50 };

test('ledger: first use seeds 5.00 USD of prior spend; it counts toward the total, not the daily window', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'state', 'spend.jsonl');
    const rows = loadLedger(f, { nowIso: iso(NOW) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'seed');
    assert.equal(rows[0].usd, SEED_USD);
    assert.deepEqual(summarize(rows, NOW), { spentTotal: 5, spentDaily: 0, openRuns: 0 });
    assert.equal(loadLedger(f, { nowIso: iso(NOW) }).length, 1, 'never re-seeded');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('ledger: empty, non-JSON, negative, NaN-ish, orphan and duplicate rows refuse (fail closed)', () => {
  const d = tmp();
  const seed = JSON.stringify({ v: 1, type: 'seed', ts: iso(NOW), usd: 5 });
  const planned = (o = {}) => JSON.stringify({ v: 1, type: 'planned', ts: iso(NOW), runId: 'r1', usd: 6, dphTotal: 2, hours: 3, offerId: 1, ...o });
  const bad = {
    empty: '', notJson: `${seed}\n{oops`, negative: `${seed}\n${planned({ usd: -1 })}`, nanString: `${seed}\n${planned({ usd: 'NaN' })}`,
    nullUsd: `${seed}\n${planned({ usd: null })}`, badTs: `${seed}\n${planned({ ts: 'yesterday' })}`,
    orphan: `${seed}\n${JSON.stringify({ v: 1, type: 'settled', ts: iso(NOW), runId: 'zz', usd: 1, hours: 1 })}`,
    duplicate: `${seed}\n${planned()}\n${planned()}`, unknownType: `${seed}\n${JSON.stringify({ v: 1, type: 'refund', ts: iso(NOW), runId: 'r1' })}`,
    hugeExponent: `${seed}\n${planned().replace('"usd":6', '"usd":1e999')}`,
  };
  try {
    for (const [name, text] of Object.entries(bad)) {
      const f = path.join(d, `${name}.jsonl`);
      writeFileSync(f, text);
      assert.throws(() => loadLedger(f, { nowIso: iso(NOW) }), SpendRefused, name);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('caps: NaN, Infinity, negative, zero and missing values refuse', () => {
  const rows = [{ v: 1, type: 'seed', ts: iso(NOW), usd: 5 }];
  for (const v of [NaN, Infinity, -Infinity, -12, 0, undefined, null, '12']) {
    assert.throws(() => checkSpend({ ...okSpend, rows, dailyCapUsd: v }), SpendRefused, `daily ${v}`);
    assert.throws(() => checkSpend({ ...okSpend, rows, totalCapUsd: v }), SpendRefused, `total ${v}`);
    assert.throws(() => checkSpend({ ...okSpend, rows, plannedUsd: v }), SpendRefused, `planned ${v}`);
    assert.throws(() => precheckCaps({ rows, nowMs: NOW, dailyCapUsd: v, totalCapUsd: 200 }), SpendRefused, `pre ${v}`);
  }
  for (const v of [NaN, Infinity, -1, undefined, null, '50']) assert.throws(() => checkSpend({ ...okSpend, rows, credit: v }), SpendRefused, `credit ${v}`);
  assert.throws(() => checkSpend({ ...okSpend, rows, nowMs: NaN }), SpendRefused);
  assert.deepEqual(checkSpend({ ...okSpend, rows }), { spentTotal: 5, spentDaily: 0, openRuns: 0 });
});

test('caps: credit below plan, daily window and total cap each refuse; settled/cancelled runs count as such', () => {
  const rows = [
    { v: 1, type: 'seed', ts: iso(NOW - 30 * 86_400_000), usd: 5 },
    { v: 1, type: 'planned', ts: iso(NOW - 2 * 3_600_000), runId: 'a', usd: 7, dphTotal: 2, hours: 3.5, offerId: 1 },
    { v: 1, type: 'planned', ts: iso(NOW - 3 * 3_600_000), runId: 'b', usd: 7, dphTotal: 2, hours: 3.5, offerId: 2 },
    { v: 1, type: 'cancelled', ts: iso(NOW - 3 * 3_600_000), runId: 'b' },
    { v: 1, type: 'planned', ts: iso(NOW - 26 * 3_600_000), runId: 'c', usd: 9, dphTotal: 2, hours: 4.5, offerId: 3 },
    { v: 1, type: 'settled', ts: iso(NOW - 25 * 3_600_000), runId: 'c', usd: 2.5, hours: 1.25, instanceId: 9 },
  ];
  assert.deepEqual(summarize(rows, NOW), { spentTotal: 14.5, spentDaily: 7, openRuns: 1 });
  assert.throws(() => checkSpend({ ...okSpend, rows, plannedUsd: 4, credit: 3.99 }), /credit/);
  assert.throws(() => checkSpend({ ...okSpend, rows, plannedUsd: 5.01 }), /daily cap/);
  assert.doesNotThrow(() => checkSpend({ ...okSpend, rows, plannedUsd: 5 }));
  assert.throws(() => checkSpend({ ...okSpend, rows, plannedUsd: 1, totalCapUsd: 15 }), /total cap/);
});

test('selectOffer: cheapest offer that passes local checks (MB gpu_ram, one GPU, finite dph under the max)', () => {
  const c = validateGpuConfig({}, 't');
  const offers = [
    { id: 1, dph_total: 0.5, num_gpus: 1, gpu_ram: 49152 }, { id: 2, dph_total: 0.6, num_gpus: 2, gpu_ram: 81920 },
    { id: 3, dph_total: null, num_gpus: 1, gpu_ram: 81920 }, { id: 4, dph_total: -1, num_gpus: 1, gpu_ram: 81920 },
    { id: 5, dph_total: 9, num_gpus: 1, gpu_ram: 81920 }, { id: 6.5, dph_total: 1, num_gpus: 1, gpu_ram: 81920 },
    { id: 8, dph_total: 1.9, num_gpus: 1, gpu_ram: 81920 }, { id: 7, dph_total: 1.7, num_gpus: 1, gpu_ram: 97871 }, null,
  ];
  assert.equal(selectOffer(offers, c).id, 7);
  assert.equal(selectOffer(offers.slice(0, 6), c), null);
});

test('validateGpuConfig: defaults are sane; bad numbers, unpinned images and odd run ids refuse', () => {
  const c = validateGpuConfig({}, 'run-2026-10-09');
  assert.equal(c.image, `vllm/vllm-openai@${VLLM_IMAGE_LIST_DIGEST}`);
  assert.equal(c.label, 'arena-flywheel-run-2026-10-09');
  // the worst offer the defaults accept must still fit the default daily cap
  assert.ok(GPU_DEFAULTS.maxDphUsd * (c.maxGpuHours + c.graceHours) <= GPU_DEFAULTS.dailyCapUsd);
  for (const bad of [{ maxGpuHours: NaN }, { maxGpuHours: 13 }, { dailyCapUsd: -1 }, { totalCapUsd: Infinity }, { maxDphUsd: 0 },
    { graceHours: -0.1 }, { image: 'vllm/vllm-openai:latest' }, { image: `evil/vllm@${VLLM_IMAGE_LIST_DIGEST}` },
    { onstartCmd: 'a\nb' }, { watchdogLauncher: 'nohup' }, { destroyAttempts: 0 }, { localPort: 80 }]) {
    assert.throws(() => validateGpuConfig(bad, 'r1'), Error, JSON.stringify(bad));
  }
  for (const id of ['', 'a b', 'x;rm', 'a'.repeat(49)]) assert.throws(() => validateGpuConfig({}, id));
});

test('ports: object or JSON string, IPv4 HostIp only, integer 1..65535', () => {
  const obj = { '22/tcp': [{ HostIp: '::', HostPort: '1' }, { HostIp: '0.0.0.0', HostPort: '40022' }] };
  assert.equal(parseSshPort(obj), 40022);
  assert.equal(parseSshPort(JSON.stringify(obj)), 40022);
  for (const bad of [null, 'nope', {}, { '22/tcp': [{ HostIp: '0.0.0.0', HostPort: '0' }] },
    { '22/tcp': [{ HostIp: '0.0.0.0', HostPort: '70000' }] }, { '22/tcp': [{ HostIp: '0.0.0.0', HostPort: '22x' }] }]) {
    assert.equal(parseSshPort(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(parseSshEndpoint({ public_ipaddr: ' 203.0.113.5 ', ports: obj }), { host: '203.0.113.5', port: 40022 });
  assert.equal(parseSshEndpoint({ public_ipaddr: '999.1.1.1', ports: obj }), null);
  assert.equal(parseSshEndpoint({ public_ipaddr: 'evil.example', ports: obj }), null);
});

test('redact: literal secrets and known key shapes', () => {
  const s = redact(`k=${DUMMY_KEY} {"instance_api_key": "abc123"} Authorization: Bearer xyz.987 hf_abcdefghijklmnop jupyter_token=qq`, [DUMMY_KEY]);
  for (const leak of [DUMMY_KEY, 'abc123', 'xyz.987', 'hf_abcdefghijklmnop', '=qq']) assert.ok(!s.includes(leak), leak);
});

test('makeVastCli: refuses a malformed key and a non-local --url override before spawning anything', () => {
  assert.throws(() => makeVastCli({ key: 'short' }), /malformed API key/);
  assert.throws(() => makeVastCli({ key: 'has space in it 1234567890' }), /malformed/);
  assert.throws(() => makeVastCli({ key: DUMMY_KEY, url: 'https://evil.example' }), /local fake/);
  assert.throws(() => makeVastCli({ key: DUMMY_KEY, bin: 'definitely-not-a-binary', pathEnv: '/nonexistent' }), /not found/);
});

test('tunnel args are accepted by the installed OpenSSH (ssh -G resolves them without connecting)', () => {
  const d = tmp(); // ssh -G drops a missing -i file (falls back to defaults), so the key must exist
  const key = path.join(d, 'id_test');
  writeFileSync(key, 'x\n', { mode: 0o600 });
  const a = sshTunnelArgs({ host: '203.0.113.5', port: 40022, localPort: 18123, keyPath: key, knownHostsFile: '/k/kh' });
  const r = spawnSync('ssh', ['-G', ...a], { encoding: 'utf8' });
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  for (const line of ['user root', 'port 40022', 'batchmode yes', 'identitiesonly yes', 'identityagent none', 'exitonforwardfailure yes',
    'stricthostkeychecking accept-new', `identityfile ${key}`, 'userknownhostsfile /k/kh', 'localforward [127.0.0.1]:18123 [localhost]:8000']) {
    assert.ok(lines.includes(line), line);
  }
  assert.equal(lines.filter(l => l.startsWith('identityfile ')).length, 1, 'only our key, no default identities');
  assert.throws(() => sshTunnelArgs({ host: 'evil.example', port: 22, localPort: 1, keyPath: 'k', knownHostsFile: 'f' }), /IPv4/);
  assert.throws(() => sshTunnelArgs({ host: '1.2.3.4', port: 0, localPort: 1, keyPath: 'k', knownHostsFile: 'f' }), /range/);
});

test('ledger file is append-only JSONL with mode 0600', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'spend.jsonl');
    loadLedger(f, { nowIso: iso(NOW) });
    const st = readFileSync(f, 'utf8');
    assert.match(st, /^\{"v":1,"type":"seed"/);
    assert.equal(statSync(f).mode & 0o777, 0o600);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
