// Exact-artifact release for the Dream integration's public packages.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const root = process.cwd();
const out = resolve('dist-release');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mode = process.argv[2] ?? 'pack';
const manifestPath = join(out, 'dream-artifacts.json');
const packages = ['sdk', 'flywheel', 'agntcy', 'create-agent-harness'];
if (mode === 'pack') {
  mkdirSync(out, { recursive: true });
  const artifacts = packages.map(dir => {
    const pkg = JSON.parse(readFileSync(`packages/${dir}/package.json`, 'utf8'));
    assert.equal(pkg.repository?.url, 'https://github.com/ruvnet/metaharness.git', `${pkg.name}: repository URL must match provenance`);
    assert.equal(pkg.repository?.directory, `packages/${dir}`, `${pkg.name}: wrong repository directory`);
    const [packed] = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', out], resolve('packages', dir)));
    assert(packed.files.some(f => f.path === 'dist/index.js'), `${pkg.name}: missing compiled entry`);
    return { name: pkg.name, version: pkg.version, file: packed.filename, sha256: hash(readFileSync(join(out, packed.filename))) };
  });
  writeFileSync(manifestPath, JSON.stringify({ sourceSha: run('git', ['rev-parse', 'HEAD']), artifacts }, null, 2) + '\n');
} else if (mode === 'smoke') {
  const { artifacts } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'dream-installed-'));
  try {
    // AGNTCY's generated protobuf dependencies are served by the public Buf registry.
    writeFileSync(join(dir, '.npmrc'), '@buf:registry=https://buf.build/gen/npm/v1/\n');
    writeFileSync(join(dir, 'package.json'), '{"private":true,"type":"module"}\n');
    for (const a of artifacts) assert.equal(hash(readFileSync(join(out, a.file))), a.sha256);
    run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...artifacts.map(a => join(out, a.file))], dir);
    const smoke = `import assert from 'node:assert/strict';
      import { makeSigner, verifyReceipt, canon } from '@metaharness/flywheel';
      import { defineHarness } from '@metaharness/sdk';
      import { oasfPublish } from '@metaharness/agntcy';
      assert.equal(typeof oasfPublish.publishToDirectory, 'function');
      const receipt = makeSigner().sign({ primaryDelta: 0.5 });
      assert(verifyReceipt(JSON.parse(JSON.stringify(receipt))));
      assert.throws(() => canon(NaN), /non-finite/);
      assert.equal(defineHarness({name:'installed'}).name, 'installed');
      const { createRequire } = await import('node:module');
      const cjs = createRequire(import.meta.url)('@metaharness/flywheel');
      assert(cjs.verifyReceipt(receipt));`;
    writeFileSync(join(dir, 'smoke.mjs'), smoke);
    run(process.execPath, ['smoke.mjs'], dir);
    run(process.execPath, ['node_modules/metaharness/dist/bin.js', 'new', 'doctor', '--no-darwin'], dir);
    const policy = JSON.parse(readFileSync(join(dir, 'doctor/.harness/mcp-policy.json'), 'utf8'));
    assert.equal(policy.defaultDeny, true); assert.equal(policy.allowShell, false);
    run(process.execPath, ['node_modules/metaharness/dist/harness-bin.js', 'doctor', join(dir, 'doctor')], dir);
    console.log('Installed ESM/CJS receipt, SDK, CLI scaffold, MCP policy and doctor smoke passed.');
  } finally { rmSync(dir, { recursive: true, force: true }); }
} else if (mode === 'publish') {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'publication requires GitHub Actions');
  assert.equal(process.env.GITHUB_WORKFLOW, 'Dream release', 'publication requires Dream release workflow');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.sourceSha, run('git', ['rev-parse', 'HEAD']));
  for (const a of manifest.artifacts) {
    const path = join(out, a.file);
    assert.equal(hash(readFileSync(path)), a.sha256);
    const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(a.name)}/${a.version}`;
    let response = await fetch(metadataUrl);
    if (response.status === 404) {
      run(npm, ['publish', path, '--provenance', '--access', 'public', '--ignore-scripts']);
      for (let attempt = 0; attempt < 12; attempt++) {
        response = await fetch(metadataUrl);
        if (response.ok) break;
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    assert(response.ok, `${a.name}: registry metadata HTTP ${response.status}`);
    const metadata = await response.json();
    const download = await fetch(metadata.dist.tarball);
    assert(download.ok, `${a.name}: tarball download failed`);
    assert.equal(hash(Buffer.from(await download.arrayBuffer())), a.sha256, `${a.name}: public bytes differ`);
    console.log(`${a.name}@${a.version}: published bytes verified (${a.sha256})`);
  }
} else throw new Error(`Unknown mode: ${mode}`);
