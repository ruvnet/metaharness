// SPDX-License-Identifier: MIT
//
// Smoke test for examples/education/education.mjs (iter 82).
//
// Mirrors the iter-32 quickstart + iter-40 federation pattern: the
// runnable demo is CODE that must keep working, not docs that nobody
// verifies.

import { describe, it, expect } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execFile = promisify(execFileCb);

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'examples', 'education', 'education.mjs');

async function runEdu(args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await execFile('node', [SCRIPT, ...args], {
      cwd: ROOT,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('examples/education/education.mjs', () => {
  it('the script + README exist', () => {
    expect(existsSync(SCRIPT)).toBe(true);
    expect(existsSync(join(ROOT, 'examples', 'education', 'README.md'))).toBe(true);
  });

  it('scaffolds + validates the iter-80 vertical end-to-end on claude-code (default)', async () => {
    const r = await runEdu();
    expect(r.code, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/vertical:education/);
    expect(r.stderr).toMatch(/\[3\/3\] validate → HEALTHY/);
  }, 60_000);

  it('surfaces all 4 expected agents (tutor / explainer / quiz-master / grader)', async () => {
    const r = await runEdu();
    expect(r.code).toBe(0);
    // Order-independent: each must appear in the agents: line.
    for (const agent of ['tutor', 'explainer', 'quiz-master', 'grader']) {
      expect(r.stderr, `missing agent: ${agent}`).toContain(agent);
    }
  }, 60_000);

  it('surfaces the 2 iter-80 commands (teach-next skill + mastery-report command)', async () => {
    const r = await runEdu();
    expect(r.code).toBe(0);
    // teach-next is a skill, mastery-report is a command — the demo
    // surfaces both. Pin the names that appear in the shape printout.
    expect(r.stderr).toContain('teach-next');
    expect(r.stderr).toContain('mastery-report');
  }, 60_000);

  it('rejects unsupported --host with exit 2', async () => {
    const r = await runEdu(['--host=invalid-host']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unsupported/);
  }, 30_000);

  it('works on a non-default host (codex)', async () => {
    const r = await runEdu(['--host=codex']);
    expect(r.code, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/HEALTHY/);
  }, 60_000);
});
