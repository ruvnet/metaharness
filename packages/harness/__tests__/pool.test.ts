// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { AgentPool } from '../src/pool.js';
import type { AgentSpec, WorkerOutput } from '../src/types.js';

const stub = (id: string): AgentSpec => ({
  id,
  model: id,
  handles: ['code'],
  run: (): WorkerOutput => ({ output: id, quality: 1, confidence: 1, risk: 0, costUsd: 0, latencyMs: 0 }),
});

describe('AgentPool (bandit + online reward)', () => {
  it('tries every candidate once before exploiting (infinite UCB for unpulled)', () => {
    const pool = new AgentPool([stub('a'), stub('b')], { rng: () => 0 });
    const first = pool.select('code');
    pool.update(first.id, 0);
    const second = pool.select('code');
    expect(second.id).not.toBe(first.id); // the other unpulled arm
  });

  it('shifts future picks toward the higher-reward agent', () => {
    const pool = new AgentPool([stub('good'), stub('bad')], { rng: () => 0 });
    // Warm both arms once.
    pool.update('good', 1);
    pool.update('bad', 0);
    // After exploration, the high-reward arm should dominate selections.
    let goodPicks = 0;
    for (let i = 0; i < 20; i++) {
      const a = pool.select('code');
      if (a.id === 'good') goodPicks++;
      pool.update(a.id, a.id === 'good' ? 1 : 0);
    }
    expect(goodPicks).toBeGreaterThan(10);
    expect(pool.snapshot().good.mean).toBeGreaterThan(pool.snapshot().bad.mean);
  });

  it('throws when no agent handles the kind', () => {
    expect(() => new AgentPool([stub('a')]).select('research')).toThrow(/no agent/);
  });
});
