// Exact-artifact npm release: pack once, smoke-test the installed tarballs, publish
// those exact bytes with npm provenance, then verify the public bytes.
//
// RELEASE_PACKAGES selects the packages/<dir> set (space separated). It defaults to
// the Dream set so `dream-vX.Y.Z` tags keep their four-package behaviour; per-package
// tags (`<package>-vX.Y.Z`) pass a single directory from the release workflow.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { checkWasmInPack } from './wasm-artifacts.mjs';
const root = process.cwd();
const out = resolve('dist-release');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mode = process.argv[2] ?? 'pack';
const manifestPath = join(out, 'dream-artifacts.json');
export const DREAM_PACKAGES = ['sdk', 'flywheel', 'agntcy', 'create-agent-harness'];
const packages = (process.env.RELEASE_PACKAGES ?? DREAM_PACKAGES.join(' ')).split(/\s+/).filter(Boolean);
for (const dir of packages) assert.match(dir, /^[a-z0-9][a-z0-9._-]*$/, `invalid package directory: ${dir}`);
const entryOf = pkg => (pkg.main ?? './dist/index.js').replace(/^\.\//, '');
if (mode === 'pack') {
  mkdirSync(out, { recursive: true });
  const artifacts = packages.map(dir => {
    const pkg = JSON.parse(readFileSync(`packages/${dir}/package.json`, 'utf8'));
    assert.notEqual(pkg.private, true, `${pkg.name}: private packages are not released`);
    assert.equal(pkg.repository?.url, 'https://github.com/ruvnet/metaharness.git', `${pkg.name}: repository URL must match provenance`);
    assert.equal(pkg.repository?.directory, `packages/${dir}`, `${pkg.name}: wrong repository directory`);
    const [packed] = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', out], resolve('packages', dir)));
    assert(packed.files.some(f => f.path === entryOf(pkg)), `${pkg.name}: missing compiled entry ${entryOf(pkg)}`);
    // Fail the release when a declared wasm file is not in the tarball (horizon 0.2.1 shipped without it).
    checkWasmInPack(pkg, packed.files);
    return { name: pkg.name, version: pkg.version, file: packed.filename, sha256: hash(readFileSync(join(out, packed.filename))) };
  });
  writeFileSync(manifestPath, JSON.stringify({ sourceSha: run('git', ['rev-parse', 'HEAD']), artifacts }, null, 2) + '\n');
} else if (mode === 'smoke') {
  const { artifacts } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const names = new Set(artifacts.map(a => a.name));
  const dir = mkdtempSync(join(tmpdir(), 'release-installed-'));
  try {
    // AGNTCY's generated protobuf dependencies are served by the public Buf registry.
    writeFileSync(join(dir, '.npmrc'), '@buf:registry=https://buf.build/gen/npm/v1/\n');
    writeFileSync(join(dir, 'package.json'), '{"private":true,"type":"module"}\n');
    for (const a of artifacts) assert.equal(hash(readFileSync(join(out, a.file))), a.sha256);
    run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...artifacts.map(a => join(out, a.file))], dir);
    // Every released package must import from its installed tarball.
    const lines = ["import assert from 'node:assert/strict';"];
    for (const a of artifacts) lines.push(`await import(${JSON.stringify(a.name)});`);
    if (names.has('@metaharness/flywheel')) lines.push(`
      const { makeSigner, verifyReceipt, canon } = await import('@metaharness/flywheel');
      const receipt = makeSigner().sign({ primaryDelta: 0.5 });
      assert(verifyReceipt(JSON.parse(JSON.stringify(receipt))));
      assert.throws(() => canon(NaN), /non-finite/);
      const { createRequire } = await import('node:module');
      const cjs = createRequire(import.meta.url)('@metaharness/flywheel');
      assert(cjs.verifyReceipt(receipt));`);
    if (names.has('@metaharness/sdk')) lines.push(`
      const { defineHarness } = await import('@metaharness/sdk');
      assert.equal(defineHarness({name:'installed'}).name, 'installed');`);
    // Packages that ship wasm must answer from the wasm, not a fallback.
    if (names.has('@metaharness/horizon')) lines.push(`
      const { HorizonCore, CommandGuard } = await import('@metaharness/horizon');
      const guard = new CommandGuard(await HorizonCore.load());
      assert.equal(guard.classify('ls').verdict, 'allow');`);
    if (names.has('@metaharness/oo-agents')) lines.push(`
      const { CellVm } = await import('@metaharness/oo-agents');
      assert.equal(typeof (await CellVm.load()), 'object');`);
    if (names.has('@metaharness/kernel')) lines.push(`
      process.env.METAHARNESS_KERNEL_BACKEND = 'wasm';
      const { loadKernel } = await import('@metaharness/kernel');
      assert.equal((await loadKernel()).backend, 'wasm');
      delete process.env.METAHARNESS_KERNEL_BACKEND;`);
    if (names.has('@metaharness/agntcy')) lines.push(`
      const { oasfPublish } = await import('@metaharness/agntcy');
      assert.equal(typeof oasfPublish.publishToDirectory, 'function');`);
    writeFileSync(join(dir, 'smoke.mjs'), lines.join('\n'));
    run(process.execPath, ['smoke.mjs'], dir);
    if (names.has('metaharness')) {
      run(process.execPath, ['node_modules/metaharness/dist/bin.js', 'new', 'doctor', '--no-darwin'], dir);
      const policy = JSON.parse(readFileSync(join(dir, 'doctor/.harness/mcp-policy.json'), 'utf8'));
      assert.equal(policy.defaultDeny, true); assert.equal(policy.allowShell, false);
      run(process.execPath, ['node_modules/metaharness/dist/harness-bin.js', 'doctor', join(dir, 'doctor')], dir);
    }
    if (names.has('@metaharness/agntcy')) {
      // A consumer with no @buf registry line must still install the tarball and use
      // everything except Directory publishing (the SDK is an optional dependency).
      const bare = mkdtempSync(join(tmpdir(), 'release-agntcy-bare-'));
      try {
        writeFileSync(join(bare, 'package.json'), '{"private":true,"type":"module"}\n');
        const a = artifacts.find(x => x.name === '@metaharness/agntcy');
        run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(out, a.file)], bare);
        writeFileSync(join(bare, 'smoke.mjs'), `import assert from 'node:assert/strict';
          const { casa, oasfPublish } = await import('@metaharness/agntcy');
          assert(casa.isCasaEnvelope(casa.compileObjectiveToEnvelope('Review the open pull requests')));
          assert.equal(typeof oasfPublish.publishToDirectory, 'function');`);
        run(process.execPath, ['smoke.mjs'], bare);
      } finally { rmSync(bare, { recursive: true, force: true }); }
    }
    console.log(`Installed-artifact smoke passed for ${[...names].join(', ')}.`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
} else if (mode === 'publish') {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'publication requires GitHub Actions');
  assert.equal(process.env.GITHUB_WORKFLOW, 'Release', 'publication requires the Release workflow');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.sourceSha, run('git', ['rev-parse', 'HEAD']));
  for (const a of manifest.artifacts) {
    const path = join(out, a.file);
    assert.equal(hash(readFileSync(path)), a.sha256);
    const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(a.name)}/${a.version}`;
    let response = await fetch(metadataUrl);
    if (response.status === 404) {
      run(npm, ['publish', path, '--provenance', '--access', 'public', '--ignore-scripts']);
      // npm may stage the publish for several minutes, and the registry CDN caches the
      // 404s from this polling for up to 300 s, so poll for up to 15 minutes.
      for (let attempt = 0; attempt < 90; attempt++) {
        response = await fetch(metadataUrl, { headers: { 'cache-control': 'no-cache' } });
        if (response.ok) break;
        await new Promise(r => setTimeout(r, 10000));
      }
    }
    assert(response.ok, `${a.name}: registry metadata HTTP ${response.status}`);
    const metadata = await response.json();
    let download = await fetch(metadata.dist.tarball);
    for (let attempt = 0; !download.ok && attempt < 40; attempt++) {
      await new Promise(r => setTimeout(r, 15000));
      download = await fetch(metadata.dist.tarball, { headers: { 'cache-control': 'no-cache' } });
    }
    assert(download.ok, `${a.name}: tarball download failed (HTTP ${download.status})`);
    assert.equal(hash(Buffer.from(await download.arrayBuffer())), a.sha256, `${a.name}: public bytes differ`);
    console.log(`${a.name}@${a.version}: published bytes verified (${a.sha256})`);
  }
} else throw new Error(`Unknown mode: ${mode}`);
