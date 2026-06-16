#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Topologically-ordered workspace build. `npm run -ws --if-present build`
// runs in undefined order — when `host-rvm` builds BEFORE `kernel-js` has
// produced its `dist/index.d.ts`, tsc fails with "Cannot find module
// '@metaharness/kernel'". This script fixes the order:
//
//   1. @metaharness/kernel        (everyone depends on it)
//   2. @metaharness/vertical-base (vertical-trading depends on it)
//   3. SDK + host adapters + create-agent-harness (parallel-safe)
//   4. vertical-trading + bench

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const PHASES = [
  // Phase 1: kernel-js — everything imports from it. router and harness are
  // dependency-free (no internal imports) so they build here too.
  ['kernel-js', 'router', 'harness'],
  // Phase 2: vertical-base — vertical-trading imports from it
  ['vertical-base'],
  // Phase 3: hosts + sdk + cli — all depend on kernel-js
  [
    'host-claude-code',
    'host-codex',
    'host-pi-dev',
    'host-hermes',
    'host-openclaw',
    'host-rvm',
    'host-copilot',         // iter 127 (ADR-032)
    'host-opencode',        // iter 128 (ADR-036)
    'host-github-actions',  // iter 146 (ADR-033)
    'sdk',
    'create-agent-harness',
  ],
  // Phase 4: vertical-trading (depends on vertical-base) + bench
  // (depends on EVERY host adapter for the cross-host benchmark in
  // iter 39's host-bench.ts).
  ['vertical-trading', 'bench'],
];

const ROOT = process.cwd();
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function runOne(pkg) {
  const cwd = `${ROOT}/packages/${pkg}`;
  // Use cmd.exe on Windows to invoke .cmd shims safely (no shell:true =
  // no DEP0190 warning). On POSIX, execFile npm directly.
  const args = ['run', '--if-present', 'build'];
  const [bin, finalArgs] = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', 'npm', ...args]]
    : ['npm', args];
  try {
    const r = await execFile(bin, finalArgs, {
      cwd,
      maxBuffer: 1024 * 1024 * 32,
      windowsHide: true,
    });
    if (r.stdout.trim()) process.stdout.write(`[${pkg}] ${r.stdout}`);
    return { pkg, ok: true };
  } catch (e) {
    process.stderr.write(`\n[${pkg}] FAILED\n${e.stdout ?? ''}${e.stderr ?? ''}\n`);
    return { pkg, ok: false };
  }
}

async function main() {
  const t0 = process.hrtime.bigint();
  for (const [i, phase] of PHASES.entries()) {
    process.stderr.write(`\n[build-ordered] phase ${i + 1}/${PHASES.length}: ${phase.join(', ')}\n`);
    const results = await Promise.all(phase.map(runOne));
    const failed = results.filter(r => !r.ok);
    if (failed.length > 0) {
      process.stderr.write(`\n[build-ordered] phase ${i + 1} failed: ${failed.map(r => r.pkg).join(', ')}\n`);
      process.exit(1);
    }
  }
  const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
  process.stderr.write(`\n[build-ordered] DONE in ${ms}ms\n`);
}

main().catch(err => {
  process.stderr.write(`[build-ordered] unexpected: ${err?.stack ?? err}\n`);
  process.exit(1);
});
