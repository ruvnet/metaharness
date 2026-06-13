#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// scripts/install-all.mjs — install every tarball from _packed/ into a
// throwaway project and assert the install succeeds. Catches:
//   - missing files in `files: [...]`
//   - bin script paths that don't exist after extraction
//   - broken peer deps
//   - per-platform install failures (the GoF Windows-cmd-bug class)

import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
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

let failures = 0;
for (const t of tarballs) {
  const tarballPath = join(packed, t);
  process.stdout.write(`install ${t}... `);
  try {
    execSync(`npm install --no-save "${tarballPath}"`, { cwd: project, stdio: 'pipe' });
    console.log('PASS');
  } catch (err) {
    console.log('FAIL');
    console.log('  ' + (err.stderr?.toString() ?? err.message ?? String(err)).split('\n').slice(0, 5).join('\n  '));
    failures++;
  }
}

console.log('');
console.log(`Result: ${failures} failure(s) of ${tarballs.length}.`);
process.exit(failures === 0 ? 0 : 1);
