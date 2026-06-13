// SPDX-License-Identifier: MIT
//
// Smoke test for examples/quickstart/quickstart.mjs.
//
// Catches the easy-to-miss break: example files that worked at write time
// but stopped working as APIs evolved. Treats the example AS code that
// must keep running, not as documentation that nobody verifies.

import { describe, it, expect } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execFile = promisify(execFileCb);

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'examples', 'quickstart', 'quickstart.mjs');

async function runQuickstart(args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await execFile('node', [SCRIPT, ...args], {
      cwd: ROOT,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('examples/quickstart/quickstart.mjs', () => {
  it('the script + README exist', () => {
    expect(existsSync(SCRIPT)).toBe(true);
    expect(existsSync(join(ROOT, 'examples', 'quickstart', 'README.md'))).toBe(true);
  });

  it('runs with default args (claude-code, minimal) and exits 0', async () => {
    const r = await runQuickstart();
    expect(r.code, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/Result: HEALTHY/);
    expect(r.stderr).toMatch(/DONE in/);
  }, 30_000);

  it('rejects invalid --host with exit 2', async () => {
    const r = await runQuickstart(['--host=not-a-host']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/invalid --host/);
  }, 30_000);

  it('runs for every supported host (smoke)', async () => {
    const hosts = ['claude-code', 'codex', 'pi-dev', 'hermes', 'openclaw', 'rvm'];
    for (const host of hosts) {
      const r = await runQuickstart([`--host=${host}`]);
      expect(r.code, `host=${host}:\n${r.stderr}`).toBe(0);
      expect(r.stderr).toContain(`host=${host}`);
    }
  }, 120_000);
});
