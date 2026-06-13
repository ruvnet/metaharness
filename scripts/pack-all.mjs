#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// scripts/pack-all.mjs — npm-pack every published package into ./_packed/.
// Used by the cross-platform pack+install smoke job.

import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dst = join(root, '_packed');
mkdirSync(dst, { recursive: true });

const packages = readdirSync(join(root, 'packages'));
let count = 0;
for (const name of packages) {
  const pj = join(root, 'packages', name, 'package.json');
  if (!existsSync(pj)) continue;
  const pkg = JSON.parse(readFileSync(pj, 'utf-8'));
  if (pkg.private) {
    console.log(`skip private: ${pkg.name}`);
    continue;
  }
  console.log(`pack: ${pkg.name}`);
  const out = execSync('npm pack --json', { cwd: join(root, 'packages', name) }).toString();
  // npm pack --json emits an array containing { filename }.
  const arr = JSON.parse(out);
  for (const entry of arr) {
    const src = join(root, 'packages', name, entry.filename);
    const finalPath = join(dst, entry.filename);
    renameSync(src, finalPath);
    count++;
  }
}
console.log(`Packed ${count} tarball(s) into ${dst}`);
