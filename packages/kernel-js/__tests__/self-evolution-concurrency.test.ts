// SPDX-License-Identifier: MIT
//
// Regression tests for a lazy-async-singleton race in
// SelfEvolvingRouter.ensureLoaded(): two concurrent first-calls both see
// `this.impl === null` and, with no shared in-flight guard, each
// unconditionally constructs its own `LearnedWeights` instance — one of
// the two (and the WASM-backed construction cost that went into it) is
// then silently discarded when the other overwrites `this.impl`.
// Confirmed below: duplicate, wasteful construction under concurrency.
// NOT confirmed (tested and found NOT to reproduce under Node's current
// microtask scheduling for this 2-call shape, so not claimed): the
// discarded instance's `.update()` call being permanently lost from the
// router's final weights — in every run observed, both concurrent calls'
// updates ended up landing on whichever instance survived. That remains a
// theoretical risk of the same race (a third call, a slower constructor,
// or a different engine's scheduling could still expose it) but is
// disclosed as such, not asserted as independently reproduced. Disclosed
// in the 2026-10-19 Dream Cycle gist; fixed here by caching the in-flight
// promise, which removes the duplicate construction entirely regardless.
//
// The EMA fallback path (`this.impl` null, emergent-time unavailable) was
// investigated too and found NOT racy: `recordOutcome()`'s read-modify-write
// of `this.weights[tier]` has no `await` between the read and the write, so
// JS run-to-completion semantics make it atomic regardless of how many
// calls are in flight — the first describe block below asserts that
// (confirms what's NOT broken, not just what is).
//
// The impl-path tests below deliberately avoid racing on the *module-level*
// `loadEmergent()`'s own `await import('@ruvector/emergent-time')` — under
// vitest/vite-node, concurrent dynamic imports of the same mocked specifier
// are deduplicated by the loader itself before `self-evolution.ts`'s own
// `_emergent` cache even comes into play, which would mask the bug this
// file exists to catch. Instead, each test first "primes" the module-level
// cache with one fully-awaited call (so `loadEmergent()` already resolves
// synchronously-fast on both racing calls), then races two
// `ensureLoaded()` calls on a *fresh router instance* against that already-
// warm cache — isolating the actual bug, which is instance-level
// (`this.impl`/`this.implPromise`), not module-level.

import { describe, it, expect, vi, beforeEach } from 'vitest';

async function freshRouter(mockFactory: () => unknown) {
  vi.resetModules();
  vi.doMock('@ruvector/emergent-time', mockFactory);
  return import('../src/self-evolution.js');
}

function fakeModule(countRef: { n: number }) {
  class FakeLearnedWeights {
    private w: Record<string, number> = {};
    update(tier: string, reward: number) {
      this.w[tier] = (this.w[tier] ?? 0) + reward;
    }
    weight(tier: string) {
      return this.w[tier] ?? 0;
    }
    weights() {
      return { ...this.w };
    }
    constructor() {
      countRef.n += 1;
    }
  }
  return { LearnedWeights: FakeLearnedWeights };
}

describe('SelfEvolvingRouter concurrency (race regression)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe('EMA fallback path (emergent-time unavailable — the common case today)', () => {
    it('does not lose a concurrent same-tier update', async () => {
      const { SelfEvolvingRouter } = await freshRouter(() => {
        throw new Error('simulated: @ruvector/emergent-time not installed');
      });
      const r = new SelfEvolvingRouter({ enabled: true });
      expect(r.weightFor('small')).toBe(1);

      // Two concurrent outcomes for the SAME tier, fired without awaiting
      // between them so they interleave around the ensureLoaded() yield.
      await Promise.all([
        r.recordOutcome({ tier: 'small', success: true, latencyMs: 0, costUsd: 0 }),
        r.recordOutcome({ tier: 'small', success: true, latencyMs: 0, costUsd: 0 }),
      ]);

      // Sequential ground truth: apply the identical EMA update twice,
      // one after another, on a fresh router with the same mock.
      const { SelfEvolvingRouter: SeqRouter } = await freshRouter(() => {
        throw new Error('simulated: @ruvector/emergent-time not installed');
      });
      const seq = new SeqRouter({ enabled: true });
      await seq.recordOutcome({ tier: 'small', success: true, latencyMs: 0, costUsd: 0 });
      await seq.recordOutcome({ tier: 'small', success: true, latencyMs: 0, costUsd: 0 });

      expect(r.weightFor('small')).toBeCloseTo(seq.weightFor('small'), 10);
    });
  });

  describe('real-impl path (emergent-time available and API-compatible)', () => {
    it('constructs exactly one LearnedWeights instance under 2 concurrent first-calls on the same router', async () => {
      const count = { n: 0 };
      const { SelfEvolvingRouter } = await freshRouter(() => fakeModule(count));

      // Prime the module-level loadEmergent() cache on a throwaway router
      // so it resolves synchronously-fast for both racing calls below —
      // isolating the instance-level `this.impl` race from any import()
      // loader-level dedup (see file header).
      const primer = new SelfEvolvingRouter({ enabled: true });
      await primer.recordOutcome({ tier: 'codemod', success: true, latencyMs: 0, costUsd: 0 });
      count.n = 0; // reset: only the race below counts

      const r = new SelfEvolvingRouter({ enabled: true });
      await Promise.all([
        r.recordOutcome({ tier: 'codemod', success: true, latencyMs: 0, costUsd: 0 }),
        r.recordOutcome({ tier: 'small', success: true, latencyMs: 0, costUsd: 0 }),
      ]);

      // On buggy main this is 2: both calls see `this.impl === null`,
      // race `await loadEmergent()`, and each constructs its own
      // LearnedWeights — the first instance (and whichever update landed
      // on it) is silently discarded when the second overwrites `this.impl`.
      expect(count.n).toBe(1);
    });

    it('retries construction on a later call after a transient construction failure, instead of permanently caching the rejection', async () => {
      // Attempt 1 is loadEmergent()'s own internal API-shape probe
      // (`new mod.LearnedWeights({tiers:['probe']})`), which must succeed
      // so `_emergent` gets cached — only then does ensureLoaded() reach
      // its own real construction (attempt 2), which we make throw once.
      let attempt = 0;
      const { SelfEvolvingRouter } = await freshRouter(() => ({
        LearnedWeights: class {
          constructor() {
            attempt += 1;
            if (attempt === 2) throw new Error('simulated transient construction failure');
          }
          update() {}
          weight() {
            return 1;
          }
          weights() {
            return {};
          }
        },
      }));
      const r = new SelfEvolvingRouter({ enabled: true });

      // First call: the real construction (attempt 2) throws. The error
      // should propagate, not be swallowed, and must NOT be cached
      // forever — a later call needs to be able to retry and succeed.
      await expect(r.recordOutcome({ tier: 'codemod', success: true, latencyMs: 0, costUsd: 0 })).rejects.toThrow(
        'simulated transient construction failure',
      );

      // Second call: `_emergent` is already cached (the probe only runs
      // once), so this retries straight to construction (attempt 3), which
      // succeeds. On a version that caches the rejected promise itself
      // (rather than clearing it on failure), this call would reject again
      // forever with the same cached error instead of retrying.
      const reward = await r.recordOutcome({ tier: 'small', success: true, latencyMs: 0, costUsd: 0 });
      expect(reward).toBeGreaterThan(0);
      expect(attempt).toBe(3);
    });
  });
});
