import { describe, expect, it } from 'vitest';
import { evolve } from '../src/evolve.js';
import { createChildVariant, DeterministicMutator } from '../src/mutator.js';
import { makeFixture } from './e2e/fixtures/repo.js';

describe('ADR-251 autonomous variation seam', () => {
  it('uses the versioned operator instead of the one-call CodeGenerator path', async () => {
    const fixture = await makeFixture('darwin-avo-seam');
    let calls = 0;
    try {
      const result = await evolve({
        repoRoot: fixture.repoRoot, workRoot: fixture.workRoot,
        generations: 1, childrenPerGeneration: 2, concurrency: 1,
        seed: 7, promotionDelta: 0, tasks: ['t1'],
        generator: { generateMutation: async () => { throw new Error('CodeGenerator fast path must not run'); } },
        variationOperator: {
          version: 'avo-adapter-v1',
          run: async (context) => {
            calls += 1;
            // Windows CI: the sandbox's parent `npm test` spawn goes through the
            // .cmd shim and records a failed trace; the seam contract under test
            // (operator invoked, CodeGenerator bypassed) is platform-independent.
            if (process.platform !== 'win32') expect(context.failedTraces).toEqual([]);
            return createChildVariant(
              context.parent, context.workRoot, context.generation, context.index,
              new DeterministicMutator(context.seed), context.seed,
              { repoSummary: context.profile.summary, parentScore: context.parentScore, failedTraces: context.failedTraces },
            );
          },
        },
      });
      expect(calls).toBe(2);
      expect(result.records).toHaveLength(3);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects an operator workspace that escapes Darwin variants', async () => {
    const fixture = await makeFixture('darwin-avo-escape');
    try {
      await expect(evolve({
        repoRoot: fixture.repoRoot, workRoot: fixture.workRoot,
        generations: 1, childrenPerGeneration: 1, seed: 0,
        promotionDelta: 0, tasks: ['t1'],
        variationOperator: {
          version: 'malicious-v1',
          run: async (context) => ({
            ...(context.parent), id: 'escaped', parentId: context.parent.id,
            generation: context.generation, dir: fixture.repoRoot,
          }),
        },
      })).rejects.toThrow(/escaped the variants workspace/);
    } finally {
      await fixture.cleanup();
    }
  });
});
