// SPDX-License-Identifier: MIT
//
// Concurrency perf check (ADR-070 §loop): prove that `evolve`'s BOUNDED
// concurrency (`mapLimit`) actually OVERLAPS variant evaluation.
//
// `evolve` derives the test command from the repo profile (always a package
// runner, e.g. `npm test`), so the fixture repo's `scripts.test` is a ~120ms
// sleep. With C children evaluated at width C the wall-clock for the children
// phase must be meaningfully LESS than the C=1 (sequential) lower bound.
//
// `mapLimit` is internal (not exported); we exercise it through the public
// `evolve` entry point — the real hot path. Sizes are tiny and margins generous
// (0.7× ceiling) to stay non-flaky in CI; per-variant `npm` startup is roughly
// constant and cancels out of the ratio.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evolve } from '../../src/evolve.js';
import type { EvolutionConfig } from '../../src/types.js';

/** The per-variant test command sleeps ~120ms then exits 0 (no shell). */
const SLEEP_MS = 120;

/**
 * Minimal repo the profiler can read. `scripts.test` => profiler resolves
 * `npm test`, which the sandbox runs per variant; it sleeps SLEEP_MS.
 */
async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'darwin-perf-repo-'));
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify({
      name: 'perf-fixture',
      version: '0.0.0',
      scripts: { test: `node -e "setTimeout(()=>{},${SLEEP_MS})"` },
    }),
    'utf8',
  );
  await writeFile(join(repo, 'index.ts'), 'export const x = 1;\n', 'utf8');
  return repo;
}

describe('evolve — bounded concurrency overlaps work', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    dirs.length = 0;
  });

  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function timedEvolve(concurrency: number, childrenPerGeneration: number): Promise<number> {
    const repo = await makeRepo();
    const work = await mkdtemp(join(tmpdir(), 'darwin-perf-work-'));
    dirs.push(repo, work);
    const cfg: EvolutionConfig = {
      repoRoot: repo,
      workRoot: work,
      generations: 1,
      childrenPerGeneration,
      tasks: ['t0'], // one sleep per variant evaluation
      promotionDelta: 0.01,
      seed: 1,
      concurrency,
      taskTimeoutMs: 30_000,
    };
    const start = performance.now();
    await evolve(cfg);
    return performance.now() - start;
  }

  it(
    'C=4 over 4 children (~120ms sleeps) is meaningfully faster than C=1',
    async () => {
      const children = 4;
      const seqMs = await timedEvolve(1, children);
      const conMs = await timedEvolve(4, children);

      // The baseline evaluation (1 sleep) is serial in BOTH runs, so the
      // difference is the 4 children: sequential ~4 sleeps vs concurrent ~1.
      // eslint-disable-next-line no-console
      console.log(
        `[concurrency.perf] seq(C=1)=${seqMs.toFixed(0)}ms  con(C=4)=${conMs.toFixed(0)}ms  ratio=${(conMs / seqMs).toFixed(2)}`,
      );

      expect(conMs).toBeLessThan(seqMs * 0.7);
    },
    60_000,
  );
});
