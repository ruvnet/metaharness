// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoProfile } from '../src/types.js';
import { generateBaselineHarness } from '../src/generator.js';
import { FILE_BY_SURFACE, inspectVariant } from '../src/safety.js';
import type { HarnessVariant } from '../src/types.js';

const profile: RepoProfile = {
  root: '/repo',
  packageManager: 'pnpm',
  testCommand: 'pnpm test',
  sourceFiles: ['src/index.ts', 'src/safety.ts'],
  riskFiles: ['deploy.json'],
  summary: '2 files, pnpm package manager, test via "pnpm test", 1 risk file(s)',
};

describe('generateBaselineHarness', () => {
  let workRoot: string;
  let baseline: HarnessVariant;

  beforeAll(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'darwin-gen-'));
    baseline = await generateBaselineHarness(profile, workRoot);
  });

  afterAll(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  it('returns a well-formed baseline descriptor', () => {
    expect(baseline.id).toBe('baseline');
    expect(baseline.parentId).toBeNull();
    expect(baseline.generation).toBe(0);
    expect(baseline.mutationSurface).toBe('planner');
    expect(baseline.mutationSummary).toBe('baseline generated from repo profile');
    expect(baseline.dir).toBe(join(workRoot, 'variants', 'baseline'));
    expect(() => new Date(baseline.createdAt).toISOString()).not.toThrow();
  });

  it('writes all seven approved mutation-surface files', async () => {
    for (const name of Object.values(FILE_BY_SURFACE)) {
      const s = await stat(join(baseline.dir, name));
      expect(s.isFile()).toBe(true);
    }
  });

  it('produces a variant that passes inspectVariant with ZERO findings', async () => {
    const findings = await inspectVariant(baseline.dir);
    expect(findings).toEqual([]);
  });
});
