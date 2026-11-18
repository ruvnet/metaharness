// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const fixture = name => fileURLToPath(new URL('./fixtures/' + name, import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8'});
const output = result => {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test('CLI imports both file formats, verifies an external pin, and refuses overwrites', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'artex-replay-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  for (const file of ['identity.json', 'findings.csv']) {
    const name = file.split('.')[0];
    const source = fixture(file);
    const manifest = fixture(name + '.manifest.json');
    const target = join(dir, name + '.json');
    const summary = output(run('replay', manifest, source, target, 'simulate'));
    const original = await readFile(target, 'utf8');
    const report = JSON.parse(original);
    assert.equal(summary.candidate.simulatedQuarantines, name === 'identity' ? 1 : 0);
    assert.equal(report.result.simulation.finalActive, 0);
    assert.equal(report.result.findings.length, name === 'findings' ? 1 : 0);
    assert.deepEqual(output(run('verify', manifest, source, target, summary.tailSha256)), {verified:true});
    assert.equal(run('verify', manifest, source, target, '0'.repeat(64)).status, 1);
    assert.equal(run('replay', manifest, source, target).status, 1);
    assert.equal(await readFile(target, 'utf8'), original);
    await writeFile(target, original.replace('{"version":1,', '{"version":0,"version":1,'));
    assert.deepEqual(JSON.parse(run('verify', manifest, source, target, summary.tailSha256).stdout), {verified:false});
    const {tailSha256, ...rest} = report.receipt;
    await writeFile(target, JSON.stringify({...report, receipt: {tailSha256, ...rest}}) + '\n');
    assert.deepEqual(JSON.parse(run('verify', manifest, source, target, summary.tailSha256).stdout), {verified:false});
    report.result.candidate.summary.alerts += 1;
    await writeFile(target, JSON.stringify(report));
    assert.equal(run('verify', manifest, source, target, summary.tailSha256).status, 1);
  }
  const modified = join(dir, 'substitution.json');
  await writeFile(modified, (await readFile(fixture('identity.json'), 'utf8')).replace('s01','s03'));
  const target = join(dir, 'refused.json');
  assert.equal(run('replay', fixture('identity.manifest.json'), modified, target).status, 1);
  await assert.rejects(readFile(target), { code: 'ENOENT' });
});

test('dispatch returns output without exiting and never echoes caller input', async () => {
  const { dispatch } = await import('./index.mjs');
  const help = await dispatch('help');
  assert.equal(help.code, 0);
  assert.match(help.lines[0], /defensive evidence replay/);
  const secret = join(tmpdir(), 'token=sk-live-should-not-appear');
  const bad = await dispatch('replay', [secret, secret, secret]);
  assert.equal(bad.code, 1);
  assert.deepEqual(bad.lines, []);
  assert.equal(bad.errors.length, 1);
  assert.ok(!bad.errors[0].includes('sk-live'));
  assert.equal((await dispatch('nonsense')).code, 1);
});

test('the bin runs when invoked through a symlink, as npm installs it', async t => {
  const { symlink } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'artex-bin-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const link = join(dir, 'artex-defense');
  await symlink(cli, link);
  const result = spawnSync(process.execPath, [link, 'help'], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /defensive evidence replay/);
});
