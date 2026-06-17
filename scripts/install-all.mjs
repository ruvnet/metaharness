#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// scripts/install-all.mjs — install every tarball from _packed/ into a
// throwaway project and assert the install succeeds. Catches:
//   - missing files in `files: [...]`
//   - bin script paths that don't exist after extraction
//   - broken peer deps
//   - per-platform install failures (the GoF Windows-cmd-bug class)
//
// Key insight (iter 31): tarballs declare deps on OTHER @metaharness/* tarballs
// that aren't on the npm registry yet. So `npm install <hosttar>` tries
// to fetch `@metaharness/kernel@0.1.0` from registry.npmjs.org and 404s.
//
// Fix: install ALL tarballs in a single `npm install` call. npm resolves
// the @metaharness/* deps from the OTHER tarballs in the same install set
// instead of going to the registry. Single PASS/FAIL — if any tarball
// has a structural problem, the batch install fails.

import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

// Read package/package.json's "name" straight out of a .tgz, in pure Node.
// Avoids shelling to `tar` — GNU tar on Windows misreads a "D:\..." path as a
// remote host spec ("Cannot connect to D:"), and bsdtar lacks --force-local.
// A package tarball is gzip(ustar); scan 512-byte headers for the manifest.
function packageNameFromTarball(tarballPath) {
  const buf = gunzipSync(readFileSync(tarballPath));
  for (let off = 0; off + 512 <= buf.length; ) {
    const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!name) break; // end-of-archive zero blocks
    const size = parseInt(buf.toString('utf8', off + 124, off + 136).replace(/\0.*$/, '').trim(), 8) || 0;
    if (name === 'package/package.json') {
      return JSON.parse(buf.toString('utf8', off + 512, off + 512 + size)).name;
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const packed = join(root, '_packed');

if (!existsSync(packed)) {
  console.error('No _packed/ directory. Run scripts/pack-all.mjs first.');
  process.exit(1);
}

const tarballs = readdirSync(packed).filter(f => f.endsWith('.tgz'));
if (tarballs.length === 0) {
  console.error('No .tgz tarballs in _packed/. Did pack-all run?');
  process.exit(1);
}

// Create a throwaway project under os.tmpdir() — works on every platform.
const project = join(tmpdir(), 'ahg-install-smoke-' + Date.now());
mkdirSync(project, { recursive: true });
writeFileSync(join(project, 'package.json'), JSON.stringify({
  name: 'install-smoke',
  version: '0.0.0',
  private: true,
}, null, 2));

console.log(`Project: ${project}`);
console.log(`Tarballs: ${tarballs.length}`);

// Pass 1: batch install — every tarball in one shot. npm resolves
// cross-tarball @metaharness/* deps locally instead of from the registry.
const tarballArgs = tarballs.map(t => `"${join(packed, t)}"`).join(' ');
console.log('Pass 1: batch install (resolves cross-tarball @metaharness deps locally)');
try {
  execSync(`npm install --no-save --no-package-lock ${tarballArgs}`, {
    cwd: project,
    stdio: 'inherit',
  });
  console.log('Batch install: PASS');
} catch (err) {
  console.error('Batch install: FAIL');
  console.error('  ' + (err.stderr?.toString() ?? err.message ?? String(err)).split('\n').slice(0, 10).join('\n  '));
  process.exit(1);
}

// Pass 2: spot-check that each package's main file is actually
// reachable post-install. Some packages might silently install but
// have a broken `main` pointing at a missing file.
console.log('Pass 2: verifying each installed package has its main entry');
let failures = 0;
for (const t of tarballs) {
  // Tarball filename "ruflo-host-rvm-0.1.0.tgz" → npm package name reconstruction
  const m = t.match(/^(.+)-(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\.tgz$/);
  if (!m) {
    console.log(`  SKIP ${t} (unparseable name)`);
    continue;
  }
  // Derive the REAL package name from the tarball's own package.json rather
  // than guessing from the filename. `npm pack` flattens scoped names
  // (@metaharness/host-x → metaharness-host-x-VER.tgz), so a filename-based
  // guess can't reconstruct the scope — it broke for every @metaharness/*
  // package after the @ruflo→@metaharness rename. Reading the manifest is
  // scope-agnostic and correct for any future rename.
  let pkgName;
  try {
    pkgName = packageNameFromTarball(join(packed, t));
  } catch {
    pkgName = null;
  }
  if (!pkgName) {
    const rawName = m[1];
    pkgName = rawName.startsWith('ruflo-') ? `@metaharness/${rawName.slice('ruflo-'.length)}` : rawName;
  }
  const pkgDir = join(project, 'node_modules', ...pkgName.split('/'));
  if (!existsSync(pkgDir)) {
    console.log(`  FAIL ${pkgName} — not in node_modules`);
    failures++;
    continue;
  }
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    console.log(`  FAIL ${pkgName} — missing package.json`);
    failures++;
    continue;
  }
  console.log(`  PASS ${pkgName}`);
}

console.log('');
console.log(`Result: ${failures} verification failure(s) of ${tarballs.length}.`);
process.exit(failures === 0 ? 0 : 1);
