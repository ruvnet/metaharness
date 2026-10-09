// Opt-in (VASTAI_IT=1): the REAL vastai CLI (v1.6.0) against a local fake of the Vast REST API, so the parsers
// in gpu-vast-cli.mjs are checked against the CLI's actual output shapes, not only against our shim.
// Safety: --url is pinned to 127.0.0.1 (makeVastCli refuses anything else), VAST_API_KEY is a dummy (so the
// CLI never falls back to ~/.config/vastai/vast_api_key), VASTAI_NO_UPDATE_CHECK=1, and the fake asserts
// every request carries the dummy key.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeVastCli, parseSshEndpoint, resolveBin, VastError } from '../gpu-vast-cli.mjs';
import { assertNoSecrets, DUMMY_KEY, SENTINEL_IAK, SENTINEL_JUP } from './gpu-fakes/shims.mjs';

let haveCli = false;
try { resolveBin('vastai', process.env.PATH); haveCli = true; } catch { /* skip */ }
const skip = process.env.VASTAI_IT !== '1' ? 'set VASTAI_IT=1' : (!haveCli ? 'vastai not on PATH' : false);

const ROW = { id: 123, actual_status: 'running', label: 'arena-flywheel-it', dph_total: 1.234, public_ipaddr: '203.0.113.5',
  ports: { '22/tcp': [{ HostIp: '0.0.0.0', HostPort: '40022' }, { HostIp: '::', HostPort: '40022' }] },
  jupyter_token: SENTINEL_JUP, onstart: 'vllm serve x', extra_env: [['FOO', 'bar']], start_date: 1 };

test('real vastai CLI v1.6.0 vs local fake API', { skip }, async (t) => {
  let mode = 'ok';
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, authOk: req.headers.authorization === `Bearer ${DUMMY_KEY}` });
      const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const u = req.url;
      if (mode === '401') return send(401, { success: false, msg: 'Invalid user key' });
      if (mode === 'create-400' && u.startsWith('/api/v0/asks/')) return send(400, { success: false, msg: 'no such ask' });
      if (mode === 'create-false' && u.startsWith('/api/v0/asks/')) return send(200, { success: false, msg: 'nope', instance_api_key: SENTINEL_IAK });
      if (u.startsWith('/api/v0/users/current')) return send(200, { id: 1, credit: 42.5, balance: 0, api_key: 'SHOULD_BE_POPPED' });
      if (u.startsWith('/api/v0/bundles/')) return send(200, { offers: [{ id: 77, dph_total: 1.5, gpu_ram: 81920, num_gpus: 1 }] });
      if (u.startsWith('/api/v0/asks/')) return send(200, { success: true, new_contract: 123, instance_api_key: SENTINEL_IAK });
      if (u.startsWith('/api/v0/instances/123/ssh/')) return send(200, { success: true, msg: 'attached' });
      if (u.startsWith('/api/v0/instances/999/')) return send(200, { instances: null });
      if (u.startsWith('/api/v0/instances/123/') && req.method === 'GET') return send(200, { instances: ROW });
      if (u.startsWith('/api/v0/instances/123/') && req.method === 'DELETE') return send(200, { success: true });
      if (u.startsWith('/api/v1/instances/')) return send(200, { instances: [ROW, { ...ROW, id: 5, label: 'other' }], next_token: null });
      return send(404, { msg: 'nope' });
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vast-it-'));
  t.after(() => { srv.close(); rmSync(dir, { recursive: true, force: true }); });
  const pub = path.join(dir, 'k.pub');
  writeFileSync(pub, 'ssh-ed25519 AAAAC3NzaFAKE it@test\n');
  const cli = makeVastCli({ key: DUMMY_KEY, url: `http://127.0.0.1:${srv.address().port}` });

  assert.deepEqual(await cli.showUser(), { credit: 42.5 });
  const offers = await cli.searchOffers('gpu_ram>=78 num_gpus=1 reliability>0.98 inet_down>500 disk_space>=150 rentable=true cuda_vers>=13.0', { storageGb: 150 });
  assert.equal(offers[0].id, 77);
  const q = JSON.parse(seen.at(-1).body);
  assert.deepEqual([q.gpu_ram, q.allocated_storage, q.order], [{ gte: 78000 }, 150, [['dph_total', 'asc']]]);
  assert.ok(q.cuda_max_good, `cuda_vers alias -> cuda_max_good: ${JSON.stringify(q.cuda_max_good)}`);

  const spec = { image: 'vllm/vllm-openai@sha256:' + 'a'.repeat(64), diskGb: 150, label: 'arena-flywheel-it', onstartCmd: 'vllm serve x --port 8000' };
  assert.equal(await cli.createInstance(77, spec), 123);
  const put = JSON.parse(seen.at(-1).body);
  assert.deepEqual([put.image, put.disk, put.label, put.onstart, put.cancel_unavail], [spec.image, 150, spec.label, spec.onstartCmd, true]);

  assert.equal(await cli.attachSsh(123, pub), true);
  const row = await cli.showInstance(123);
  assert.deepEqual(parseSshEndpoint(row), { host: '203.0.113.5', port: 40022 });
  assert.equal(row.jupyter_token, undefined);
  assert.equal(await cli.showInstance(999), null);
  await cli.destroyOnce(123);
  assert.equal(seen.at(-1).method, 'DELETE');
  assert.deepEqual((await cli.showInstancesByLabel('arena-flywheel-it')).map(r => r.id), [123]);

  for (const [m, re, definite] of [['create-400', /http 400/, true], ['create-false', /rejected/, true]]) {
    mode = m;
    const e = await cli.createInstance(77, spec).catch(x => x);
    assert.ok(e instanceof VastError && re.test(e.message) && e.definite === definite, `${m}: ${e.message}`);
    assertNoSecrets(assert, e.message, e.stack);
  }
  mode = '401';
  const e401 = await cli.showUser().catch(x => x);
  assert.match(e401.message, /show user: http 401/);
  srv.close();
  await new Promise(r => setTimeout(r, 100));
  const eDown = await cli.showUser().catch(x => x);
  assert.equal(eDown.kind, 'transport');
  assert.ok(seen.length > 0 && seen.every(s => s.authOk), 'every request used the dummy key');
});
