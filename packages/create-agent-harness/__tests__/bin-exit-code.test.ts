// SPDX-License-Identifier: MIT
//
// #73 regression guard — `metaharness`'s bin.js must propagate main()'s exit
// code. Before this fix, bin.js discarded main()'s return value, so EVERY
// subcommand exited 0 — a failed command looked green in CI/scripts.
//
// These tests spawn the built dist/bin.js as a real process and assert the
// process exit code. Cases 1, 3 and 4 would FAIL against the pre-fix bin.js
// (which always exited 0); they pass once the code is propagated. Case 2 pins
// that a genuinely-successful flow, and the bare help/usage banner, stay 0 —
// so the fix does not turn a passing invocation into a spurious non-zero.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const BIN = join(__dirname, '..', 'dist', 'bin.js');

function run(args: string[], cwd?: string): number {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    // Never inherit — keep the test output clean and deterministic.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // spawnSync returns status === null if the child was killed by a signal;
  // treat that as a hard failure so the assertion is meaningful.
  return r.status ?? -1;
}

describe('#73 — bin.js propagates main() exit code', () => {
  it('exits NON-ZERO when a delegated sub-dispatch fails (from-repo missing args)', () => {
    // `from-repo` with no url/name prints its usage and main() returns 2.
    // Pre-fix this exited 0 (the bug this test pins).
    expect(run(['from-repo'])).not.toBe(0);
  });

  it('exits NON-ZERO on an unknown --host (validation failure)', () => {
    // Fails validation and returns before any scaffold write — no side effects.
    expect(run(['some-name', '--host', 'definitely-not-a-host'])).not.toBe(0);
  });

  it('exits NON-ZERO when `analyze` is given a non-existent path', () => {
    expect(run(['analyze', '/nonexistent-path-for-73-test-xyz'])).not.toBe(0);
  });

  it('exits 0 on a successful passing flow (--list)', () => {
    expect(run(['--list'])).toBe(0);
  });

  it('exits 0 for bare `metaharness` (help/usage banner)', () => {
    expect(run([])).toBe(0);
  });
});
