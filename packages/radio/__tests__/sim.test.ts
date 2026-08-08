// @metaharness/radio — vitest suite for the deterministic swarm sim (sim.ts).
//
// Two properties the flywheel stands on, plus the new relevance/DIGEST lever:
//
//   - The ablation ORDERING the paper reproduces (single > L1 divide > L2
//     negotiate > L3 passive in steps-to-resolve) must hold per seed over
//     1..10 with the DEFAULT policy. Adding the digest lever must not disturb it.
//   - DETERMINISM: same SimConfig => bit-identical SimResult (seeded LCG,
//     logical clock; no wall clock, no Math.random).
//   - The DIGEST lever (ADR-241 surface): 'full' is correct but pays a per-fold
//     context surcharge; 'mentions' is cheaper but LOSES a cross-fact bundled
//     under another owner's mention (an unresolved seed — the hard gate stop);
//     'relevant' is the cheapest CORRECT digest (topic filter recovers what
//     'mentions' drops, at a fraction of 'full's read cost).
import { describe, expect, it } from 'vitest';
import { runSim, makeTask } from '../src/sim.js';
import type { SimMode, Digest } from '../src/sim.js';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

describe('runSim — ablation ordering (the flywheel sanity target)', () => {
  it('orders passive < negotiate <= divide < single per seed with the default policy', () => {
    for (const seed of SEEDS) {
      const steps: Record<SimMode, number> = {
        single: runSim({ seed, mode: 'single' }).stepsToResolve,
        divide: runSim({ seed, mode: 'divide' }).stepsToResolve,
        negotiate: runSim({ seed, mode: 'negotiate' }).stepsToResolve,
        passive: runSim({ seed, mode: 'passive' }).stepsToResolve,
      };
      expect(steps.passive, `seed ${seed}`).toBeLessThan(steps.negotiate);
      expect(steps.negotiate, `seed ${seed}`).toBeLessThanOrEqual(steps.divide);
      expect(steps.divide, `seed ${seed}`).toBeLessThan(steps.single);
    }
  });

  it('resolves every sub-question in every mode over the holdout seeds', () => {
    for (const seed of SEEDS) {
      for (const mode of ['single', 'divide', 'negotiate', 'passive'] as SimMode[]) {
        expect(runSim({ seed, mode }).resolved, `${mode} seed ${seed}`).toBe(true);
      }
    }
  });
});

describe('runSim — determinism', () => {
  it('same config => bit-identical result, across modes and digests', () => {
    const configs = [
      { seed: 3, mode: 'passive' as SimMode, digest: 'full' as Digest },
      { seed: 3, mode: 'passive' as SimMode, digest: 'relevant' as Digest },
      { seed: 7, mode: 'divide' as SimMode, digest: 'mentions' as Digest },
      { seed: 42, mode: 'negotiate' as SimMode, postPolicy: 'batched' as const },
    ];
    for (const cfg of configs) {
      expect(JSON.stringify(runSim(cfg))).toBe(JSON.stringify(runSim(cfg)));
    }
  });

  it('an unspecified digest defaults to the legacy full-snapshot behavior', () => {
    for (const seed of [1, 3, 5]) {
      const dflt = runSim({ seed, mode: 'passive' });
      const full = runSim({ seed, mode: 'passive', digest: 'full' });
      expect(JSON.stringify(dflt)).toBe(JSON.stringify(full));
    }
  });
});

describe('runSim — the relevance/DIGEST lever', () => {
  const region = { mode: 'passive' as SimMode, postPolicy: 'immediate' as const, foldEvery: '1' as const };

  it("'full' and 'relevant' resolve every seed; 'mentions' loses at least one", () => {
    let mentionsUnresolved = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(runSim({ ...region, seed, digest: 'full' }).resolved).toBe(true);
      expect(runSim({ ...region, seed, digest: 'relevant' }).resolved).toBe(true);
      if (!runSim({ ...region, seed, digest: 'mentions' }).resolved) mentionsUnresolved++;
    }
    // 'mentions' drops cross-facts consolidated under another owner's mention —
    // exactly the failure the paper warns about, and a hard stop under the gate.
    expect(mentionsUnresolved).toBeGreaterThan(0);
  });

  it("'relevant' is the cheapest CORRECT digest: fewer steps and less surcharge than 'full'", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const full = runSim({ ...region, seed, digest: 'full' });
      const relevant = runSim({ ...region, seed, digest: 'relevant' });
      // Same correctness...
      expect(relevant.resolved).toBe(true);
      expect(full.resolved).toBe(true);
      // ...at strictly lower context surcharge, hence no more total steps.
      expect(relevant.digestSteps).toBeLessThan(full.digestSteps);
      expect(relevant.stepsToResolve).toBeLessThanOrEqual(full.stepsToResolve);
    }
  });

  it("'full' pays a real per-fold surcharge that 'batched' posting cannot dodge", () => {
    // Surcharge is priced by fact CONTENT, not message envelopes, so coalescing
    // posts into fewer messages does not lower it — 'full' stays expensive.
    for (const seed of [1, 2, 3]) {
      const immediate = runSim({ mode: 'passive', seed, digest: 'full', postPolicy: 'immediate' });
      const batched = runSim({ mode: 'passive', seed, digest: 'full', postPolicy: 'batched' });
      expect(immediate.digestSteps).toBeGreaterThan(0);
      expect(batched.digestSteps).toBeGreaterThan(0);
    }
  });

  it('a larger digestCap lowers the surcharge monotonically (cost is per-fact)', () => {
    const at = (digestCap: number): number =>
      runSim({ ...region, seed: 1, digest: 'full', digestCap }).digestSteps;
    expect(at(2)).toBeGreaterThan(at(6));
    expect(at(6)).toBeGreaterThanOrEqual(at(1000));
    expect(at(1000)).toBe(0);
  });
});
