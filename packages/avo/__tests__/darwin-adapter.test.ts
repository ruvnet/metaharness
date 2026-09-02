import { describe, expect, it } from 'vitest';
import { DarwinVariationAdapter, type VariationResult } from '../src/index.js';

describe('DarwinVariationAdapter', () => {
  it('materializes only a verified promoted variation', async () => {
    const verified = {
      winner: { id: 'winner' }, failureReport: undefined,
    } as unknown as VariationResult;
    const adapter = new DarwinVariationAdapter(
      'v1',
      () => ({ run: async () => verified }),
      async (result, context) => ({ id: result.winner!.id, generation: context.generation }),
    );
    await expect(adapter.run({
      parent: {}, profile: {}, workRoot: '/tmp/work', generation: 2, index: 0,
      seed: 1, parentScore: 0, failedTraces: [], allowedSurfaces: [],
    })).resolves.toEqual({ id: 'winner', generation: 2 });
  });

  it('fails closed when AVO retains only the seed', async () => {
    const adapter = new DarwinVariationAdapter('v1', () => ({
      run: async () => ({ winner: { id: 'seed' }, failureReport: 'no promoted variation' } as unknown as VariationResult),
    }), async () => ({}));
    await expect(adapter.run({
      parent: {}, profile: {}, workRoot: '/tmp/work', generation: 1, index: 0,
      seed: 0, parentScore: 0, failedTraces: [], allowedSurfaces: [],
    })).rejects.toThrow('no promoted variation');
  });
});
