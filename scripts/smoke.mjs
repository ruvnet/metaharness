// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`PASS ${msg}`);
  } else {
    console.log(`FAIL ${msg}`);
    failed++;
  }
}

const pkg = JSON.parse(
  readFileSync(resolve(repoRoot, 'packages/kernel-js/package.json'), 'utf-8'),
);

try {
  const { loadKernel } = await import(
    resolve(repoRoot, 'packages/kernel-js/dist/index.js')
  );
  const k = await loadKernel();
  const info = k.kernelInfo();
  assert(typeof info.version === 'string' && info.version.length > 0,
    'kernelInfo.version is a non-empty string');
  assert(info.version === pkg.version,
    `kernelInfo.version ${info.version} matches package.json ${pkg.version}`);

  const bad = k.mcpValidate(JSON.stringify({ name: '', command: ['x'] }));
  assert(typeof bad === 'string' && bad.includes('empty'),
    'mcpValidate rejects empty name');

  const good = k.mcpValidate(JSON.stringify({ name: 'demo', command: ['npx', '-y', 'demo'] }));
  assert(good === null, 'mcpValidate accepts a well-formed stdio spec');

  console.log(`\nbackend: ${k.backend}`);
} catch (err) {
  console.error('smoke failed:', err);
  failed++;
}

process.exit(failed === 0 ? 0 : 1);
