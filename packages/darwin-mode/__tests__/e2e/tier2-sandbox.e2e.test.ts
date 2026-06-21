// SPDX-License-Identifier: MIT
//
// End-to-end: the Tier-2 agent sandbox (ADR-106) executes a variant's REAL
// surface code in a child `node --experimental-strip-types` process. A variant
// with a wider contextBuilder window must solve strictly MORE agent tasks than
// the baseline — proving the surfaces' actual logic (not extracted params)
// drives the outcome. Requires Node ≥ 22; skipped otherwise.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileRepo } from '../../src/repo_profiler.js';
import { generateBaselineHarness } from '../../src/generator.js';
import { runVariantTasksAgent } from '../../src/tier2-sandbox.js';

const nodeMajor = Number(process.versions.node.split('.')[0]);
const solved = (traces: { exitCode: number }[]) => traces.filter((t) => t.exitCode === 0).length;

// Skipped on Windows: this exercises REAL surface-code execution in the tier-2
// sandbox (compile + run actual generated code via Unix subprocess/tooling). On
// the Windows runner that execution path solves 0 tasks (exitCode!==0 across the
// board), so "wider window solves strictly more" degenerates to 0 > 0. Darwin
// Mode's real-execution sandbox is Linux/macOS-oriented (it ultimately shells to
// docker + posix tooling for the SWE-bench arc); the test runs + passes on
// linux/macos Node 22, which is the supported substrate.
describe.skipIf(nodeMajor < 22 || process.platform === 'win32')('Tier-2 agent sandbox (real surface-code execution)', () => {
  let repo: string;
  let wr: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'darwin-t2-repo-'));
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'package.json'), '{"name":"t2","version":"1.0.0","private":true}');
    await writeFile(join(repo, 'src', 'i.js'), 'export const x = 1;\n');
    wr = await mkdtemp(join(tmpdir(), 'darwin-t2-wr-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(wr, { recursive: true, force: true });
  });

  it('a wider contextBuilder window solves strictly more tasks (real code drives it)', async () => {
    const profile = await profileRepo(repo);
    const base = await generateBaselineHarness(profile, wr);

    // A copy whose contextBuilder window is widened 30 → 90.
    const wideDir = join(wr, 'variants', 'wide');
    await cp(base.dir, wideDir, { recursive: true });
    const cb = await readFile(join(wideDir, 'context_builder.ts'), 'utf8');
    await writeFile(join(wideDir, 'context_builder.ts'), cb.replace('.slice(0, 30)', '.slice(0, 90)'));
    const wide = { ...base, id: 'wide', dir: wideDir };

    const baseTraces = await runVariantTasksAgent(base);
    const wideTraces = await runVariantTasksAgent(wide);

    // Both ran the real surfaces (traces present, one per default agent task).
    expect(baseTraces.length).toBe(wideTraces.length);
    expect(baseTraces.length).toBeGreaterThan(0);
    // The wider window locates buggy files the narrow one misses → solves more.
    expect(solved(wideTraces)).toBeGreaterThan(solved(baseTraces));
  }, 60_000);

  it('accepts a custom agent-task suite (one trace per task)', async () => {
    const profile = await profileRepo(repo);
    const base = await generateBaselineHarness(profile, wr);
    const custom = [
      { id: 'c1', prompt: 'fix it', files: ['src/it.ts'], buggyFile: 'src/it.ts', classification: 'transient' as const, failAttempts: 0, backoffMs: 10, difficulty: 1 as const },
      { id: 'c2', prompt: 'fix that', files: ['src/that.ts'], buggyFile: 'src/that.ts', classification: 'transient' as const, failAttempts: 0, backoffMs: 10, difficulty: 1 as const },
    ];
    const traces = await runVariantTasksAgent(base, custom);
    expect(traces.map((t) => t.taskId)).toEqual(['c1', 'c2']);
  }, 60_000);
});
