// SPDX-License-Identifier: MIT
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evolve } from '../src/evolve.js';
import type { EvolutionConfig } from '../src/types.js';
import type { CodeGenerator } from '../src/mutator.js';
import { SimMemory } from '../src/sim-memory.js';
import type { SimScope } from '../src/sim-memory.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const scope: SimScope = {
  ownerId: 'test-owner', repoId: 'test-repo', interfaceId: 'darwin-v1',
  modelId: 'policy-v1', benchmarkId: 'mock-v1', harnessVersion: '0.14.0',
};
async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sim-evolve-repo-'));
  dirs.push(dir);
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'sim-evolve-fixture', version: '1.0.0', scripts: { test: 'node --test' },
  }));
  await writeFile(join(dir, 'src', 'index.js'), 'export const value = 1;\n');
  return dir;
}
async function work(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sim-evolve-work-'));
  dirs.push(dir);
  return dir;
}

describe('Darwin SIM integration', () => {
  it('preserves frozen scores and promotion decisions while giving later proposals prior optimizer evidence', async () => {
    const repoRoot = await repo();
    const seenWithout: Array<string | undefined> = [];
    const seenWith: Array<string | undefined> = [];
    const generator = (seen: Array<string | undefined>): CodeGenerator => ({
      async generateMutation(input) {
        seen.push(input.simContext);
        return { code: input.parentCode, summary: 'controlled no-op fixture' };
      },
    });
    const base: EvolutionConfig = {
      repoRoot, workRoot: await work(), generations: 2, childrenPerGeneration: 1,
      tasks: [], sandboxMode: 'mock', mockTasks: [], concurrency: 1,
      promotionDelta: 0.01, seed: 17, generator: generator(seenWithout),
    };
    const off = await evolve(base);
    const workRoot = await work();
    const memory = new SimMemory(join(workRoot, 'optimizer-sim.json'));
    const on = await evolve({
      ...base, workRoot, generator: generator(seenWith),
      sim: { store: memory, mode: 'full', scope, maxTokens: 512 },
    });
    expect(on.records.map((r) => r.score?.finalScore)).toEqual(off.records.map((r) => r.score?.finalScore));
    expect(on.records.map((r) => r.score?.promoted)).toEqual(off.records.map((r) => r.score?.promoted));
    expect(seenWithout.every((context) => context === undefined)).toBe(true);
    expect(seenWith.some((context) => context?.includes('observedDelta'))).toBe(true);
    const reload = new SimMemory(memory.filePath);
    await reload.load();
    expect(reload.all().length).toBeGreaterThanOrEqual(1);
    expect(reload.all().every((r) => r.evidenceIds.every((id) => !id.includes('hidden')))).toBe(true);
  });

  it('mode off does not create SIM records or change the default run', async () => {
    const repoRoot = await repo();
    const workRoot = await work();
    const db = new SimMemory(join(workRoot, 'not-written.json'));
    const result = await evolve({
      repoRoot, workRoot, generations: 0, childrenPerGeneration: 1,
      tasks: [], promotionDelta: 0, sandboxMode: 'mock', mockTasks: [],
      sim: { store: db, mode: 'off', scope },
    });
    expect(result.records.length).toBeGreaterThanOrEqual(1);
    expect(db.all()).toEqual([]);
  });
});
