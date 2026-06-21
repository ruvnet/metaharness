// SPDX-License-Identifier: MIT
//
// Tests for sandbox.ts — network-isolated sandboxed execution.
//
// Load-bearing properties:
//   * buildSandboxArgv() is pure and wraps the command in `unshare -rn` exactly
//     when sandboxing is reported available, and passes it through otherwise.
//   * sandboxAvailable() always returns a boolean and never throws.
//   * When unshare is actually present (skipIf otherwise), a child's network
//     attempt FAILS inside the sandbox (no exfiltration / phone-home), while a
//     pure-compute child still succeeds — proving network-only isolation.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sandboxAvailable,
  buildSandboxArgv,
  runSandboxed,
} from '../src/sandbox.js';

describe('buildSandboxArgv (pure)', () => {
  it('wraps in `unshare -rn` when available', () => {
    expect(buildSandboxArgv('python3', ['x.py'], true)).toEqual({
      cmd: 'unshare',
      argv: ['-rn', 'python3', 'x.py'],
    });
  });

  it('passes the command through when not available', () => {
    expect(buildSandboxArgv('python3', ['x.py'], false)).toEqual({
      cmd: 'python3',
      argv: ['x.py'],
    });
  });

  it('preserves multiple args in order', () => {
    expect(buildSandboxArgv('node', ['-e', 'console.log(1)'], true)).toEqual({
      cmd: 'unshare',
      argv: ['-rn', 'node', '-e', 'console.log(1)'],
    });
  });
});

describe('sandboxAvailable', () => {
  it('returns a boolean and never throws', () => {
    let result: boolean | undefined;
    expect(() => {
      result = sandboxAvailable();
    }).not.toThrow();
    expect(typeof result).toBe('boolean');
  });
});

describe.skipIf(!sandboxAvailable())('runSandboxed network isolation', () => {
  it('blocks network access inside the sandbox', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-net-'));
    const file = join(dir, 'phonehome.py');
    try {
      writeFileSync(
        file,
        [
          'import urllib.request',
          "urllib.request.urlopen('https://pypi.org', timeout=4)",
          "print('OK')",
        ].join('\n'),
      );

      const res = runSandboxed('python3', [file], { timeoutMs: 10000 });

      // The network attempt must fail: no OK printed, and ok reflects failure.
      expect(res.stdout).not.toContain('OK');
      expect(res.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still allows pure compute inside the sandbox', () => {
    const res = runSandboxed('python3', ['-c', 'print(1+1)'], {
      timeoutMs: 10000,
    });
    expect(res.ok).toBe(true);
    expect(res.stdout.trim()).toBe('2');
  });
});
