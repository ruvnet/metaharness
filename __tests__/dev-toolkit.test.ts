// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execFile = promisify(execFileCb);
const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'dev-toolkit.mjs');

async function run(args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await execFile('node', [SCRIPT, ...args], { cwd: ROOT, windowsHide: true });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('scripts/dev-toolkit.mjs', () => {
  it('exists', () => expect(existsSync(SCRIPT)).toBe(true));

  it('default run exits 0 and lists all 4 sections', async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Entry points/);
    expect(r.stdout).toMatch(/Dev scripts/);
    expect(r.stdout).toMatch(/harness subcommands/);
    expect(r.stdout).toMatch(/CI matrix/);
  });

  it('lists every harness subcommand (currently 15)', async () => {
    // iter 69: refreshed from 12 → 15. mcp-scan + analyze-repo landed
    // in PR #1 (iter 55); diag landed in iter 66. Every dispatcher-
    // honoured subcommand MUST show up here or new contributors won't
    // discover the tool that solves their problem.
    const r = await run();
    const subs = [
      'sign', 'verify', 'doctor', 'federate', 'secrets', 'validate',
      'mcp', 'publish', 'upgrade', 'completions', 'sbom', 'audit',
      'mcp-scan', 'analyze-repo', 'diag',
    ];
    for (const s of subs) {
      expect(r.stdout, `missing subcommand: ${s}`).toContain(`harness ${s}`);
    }
  });

  it('lists every key entry point script', async () => {
    const r = await run();
    for (const s of ['healthcheck', 'preflight', 'release', 'sbom', 'audit-deps', 'bench-baseline']) {
      expect(r.stdout, `missing entry point: ${s}`).toContain(s);
    }
  });

  // iter 83 — runnable example demos in examples/ are part of new
  // contributor orientation. Pin all 4 so adding a 5th vertical example
  // can't silently drop one of the existing four.
  it('lists all 4 runnable example demos (iter 83)', async () => {
    const r = await run();
    expect(r.stdout).toMatch(/Runnable example demos \(examples\/\)/);
    for (const demo of ['quickstart', 'federation', 'host-tour', 'education']) {
      expect(r.stdout, `missing demo: ${demo}`).toContain(demo);
    }
    // Each demo's command line is shown as `$ node examples/<name>/<name>.mjs`
    for (const demo of ['quickstart', 'federation', 'host-tour', 'education']) {
      expect(r.stdout, `missing demo command: ${demo}`).toMatch(
        new RegExp(`node examples\\/${demo}\\/${demo}\\.mjs`),
      );
    }
  });

  it('--json emits parseable JSON with the expected shape', async () => {
    const r = await run(['--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed.scripts)).toBe(true);
    expect(Array.isArray(parsed.harnessSubcommands)).toBe(true);
    expect(Array.isArray(parsed.entryPoints)).toBe(true);
    // iter 83 — examples array surfaces in --json too
    expect(Array.isArray(parsed.examples), 'json missing examples array').toBe(true);
    expect(parsed.examples.length).toBe(4);
    expect(parsed.ci?.jobs?.length).toBeGreaterThanOrEqual(6);
  });

  it('--filter=release narrows to release-related entries', async () => {
    const r = await run(['--filter=release']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/release/);
    expect(r.stdout).not.toMatch(/harness mcp\b/);
  });

  it('--check-health passes on a healthy repo', async () => {
    const r = await run(['--check-health']);
    expect(r.code).toBe(0);
  });

  it('every script listed in dev-toolkit actually exists on disk', async () => {
    const r = await run(['--json']);
    const parsed = JSON.parse(r.stdout);
    for (const s of parsed.scripts) {
      expect(existsSync(join(ROOT, s.path)), `missing: ${s.path}`).toBe(true);
    }
  });
});
