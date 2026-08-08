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
import type { SimMode, Digest, Topology } from '../src/sim.js';

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

describe('runSim — the STALENESS rework cost (F9, arXiv:2502.14321)', () => {
  const SEEDS5 = [1, 2, 3, 4, 5];

  it('is EXACTLY zero at the defaults (foldEvery=1 + immediate) — ablation untouched', () => {
    // The whole point of the default: staleness never perturbs the existing
    // landscape. Live async folding at fold cadence 1 lands with zero latency.
    for (const seed of [...SEEDS5, 6, 7, 8, 9, 10]) {
      const r = runSim({ seed, mode: 'passive', postPolicy: 'immediate', foldEvery: '1' });
      expect(r.stalenessSteps, `seed ${seed}`).toBe(0);
    }
  });

  it('the default topology is message-passing, byte-identical to naming it', () => {
    for (const seed of [1, 3, 5]) {
      const dflt = runSim({ seed, mode: 'passive' });
      const mp = runSim({ seed, mode: 'passive', topology: 'message-passing' as Topology });
      expect(JSON.stringify(dflt)).toBe(JSON.stringify(mp));
    }
  });

  it('prices LAZY folding: a live async fold at foldEvery=4 goes stale, foldEvery=1 does not', () => {
    for (const seed of SEEDS5) {
      const region = { seed, mode: 'passive' as SimMode, postPolicy: 'immediate' as const, digest: 'relevant' as Digest };
      const f1 = runSim({ ...region, foldEvery: '1' });
      const f4 = runSim({ ...region, foldEvery: '4' });
      expect(f1.stalenessSteps, `seed ${seed} f1`).toBe(0);
      expect(f4.stalenessSteps, `seed ${seed} f4`).toBeGreaterThan(0);
      // The rework surcharge makes fold-every-1 genuinely cheaper, not merely neutral.
      expect(f4.stepsToResolve, `seed ${seed}`).toBeGreaterThan(f1.stepsToResolve);
      expect(f1.resolved && f4.resolved).toBe(true);
    }
  });

  it('the blocking/sync arms carry no live state to go stale (zero staleness)', () => {
    for (const seed of SEEDS5) {
      // negotiate/divide/single never fold live; silent-passive shares nothing until Review.
      expect(runSim({ seed, mode: 'negotiate', foldEvery: '4' }).stalenessSteps).toBe(0);
      expect(runSim({ seed, mode: 'divide', foldEvery: '4' }).stalenessSteps).toBe(0);
      expect(runSim({ seed, mode: 'single' }).stalenessSteps).toBe(0);
      expect(runSim({ seed, mode: 'passive', postPolicy: 'silent', foldEvery: '4' }).stalenessSteps).toBe(0);
    }
  });

  it('stalenessCost=0 disables the effect (a faithful off switch)', () => {
    for (const seed of SEEDS5) {
      const r = runSim({ seed, mode: 'passive', postPolicy: 'immediate', foldEvery: '4', stalenessCost: 0 });
      expect(r.stalenessSteps).toBe(0);
    }
  });
});

describe('runSim — the BLACKBOARD topology lever (F6, arXiv:2510.01285 / 2507.01701)', () => {
  const MULTI: SimMode[] = ['divide', 'negotiate', 'passive'];

  it('is CORRECT BY CONSTRUCTION: resolves every seed in every multi-agent mode, even with a lossy digest', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      for (const mode of MULTI) {
        // 'mentions' drops cross-facts under message-passing; the board never does.
        const r = runSim({ seed, mode, topology: 'blackboard', digest: 'mentions', postPolicy: 'silent', foldEvery: '4' });
        expect(r.resolved, `${mode} seed ${seed}`).toBe(true);
      }
    }
  });

  it("its fine-grained pull is never stale (zero staleness) and carries a bounded board-read cost", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = runSim({ seed, mode: 'passive', topology: 'blackboard' });
      expect(r.stalenessSteps, `seed ${seed}`).toBe(0);
      expect(r.boardReadSteps, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(r.digestSteps, `seed ${seed}`).toBe(0); // digest is subsumed, never charged
    }
  });

  it('SUBSUMES the message-passing levers: blackboard is invariant under digest/foldEvery/postPolicy', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const base = JSON.stringify(
        runSim({ seed, mode: 'passive', topology: 'blackboard', digest: 'full', foldEvery: '1', postPolicy: 'immediate' }),
      );
      for (const digest of ['full', 'mentions', 'relevant'] as Digest[]) {
        for (const foldEvery of ['1', '2', '4'] as const) {
          for (const postPolicy of ['immediate', 'batched', 'silent'] as const) {
            const r = runSim({ seed, mode: 'passive', topology: 'blackboard', digest, foldEvery, postPolicy });
            expect(JSON.stringify(r), `seed ${seed} ${digest}/${foldEvery}/${postPolicy}`).toBe(base);
          }
        }
      }
    }
  });

  it('a bigger boardReadCap lowers the bounded read cost monotonically', () => {
    const at = (boardReadCap: number): number =>
      runSim({ seed: 1, mode: 'divide', topology: 'blackboard', boardReadCap }).boardReadSteps;
    expect(at(2)).toBeGreaterThanOrEqual(at(6));
    expect(at(6)).toBeGreaterThanOrEqual(at(1000));
    expect(at(1000)).toBe(0);
  });

  it('never leaves a seed unresolved for LACK OF DELIVERY (F6): the board delivers every cross-fact', () => {
    // Correct by construction: a validated write is never dropped and every
    // fact-bearing unit is covered by some partition, so as long as the facts
    // are discoverable, the owner receives every cross-fact. We stress the
    // WORST delivery configuration message-passing offers (silent posting +
    // lossy 'mentions' digest + laziest fold cadence) — under blackboard those
    // levers are inert, so delivery cannot fail. Every open sub-question that
    // was ever discovered must close, and each closes at a real recorded step.
    for (const seed of SEEDS) {
      for (const mode of MULTI) {
        const r = runSim({
          seed,
          mode,
          topology: 'blackboard',
          digest: 'mentions',
          postPolicy: 'silent',
          foldEvery: '4',
        });
        expect(r.resolved, `${mode} seed ${seed}`).toBe(true);
        // Delivery, not luck: no sub-question is left at the -1 "never" sentinel.
        expect(r.subResolvedAtStep.some((s) => s < 0), `${mode} seed ${seed}`).toBe(false);
      }
    }
  });

  it('is DETERMINISTIC: same blackboard SimConfig => bit-identical SimResult', () => {
    const configs = [
      { seed: 2, mode: 'passive' as SimMode, topology: 'blackboard' as Topology },
      { seed: 4, mode: 'divide' as SimMode, topology: 'blackboard' as Topology, boardReadCap: 3 },
      {
        seed: 9,
        mode: 'negotiate' as SimMode,
        topology: 'blackboard' as Topology,
        digest: 'mentions' as Digest,
        foldEvery: '4' as const,
        postPolicy: 'silent' as const,
      },
    ];
    for (const cfg of configs) {
      expect(JSON.stringify(runSim(cfg)), JSON.stringify(cfg)).toBe(JSON.stringify(runSim(cfg)));
    }
  });
});

describe('runSim — the two new levers preserve the flywheel invariants', () => {
  it('DETERMINISM holds across the new levers: same SimConfig => bit-identical SimResult', () => {
    // Spans topology, stalenessCost, and their interaction with the delivery
    // levers — none may introduce Date.now/Math.random nondeterminism.
    const configs = [
      { seed: 1, mode: 'passive' as SimMode, topology: 'blackboard' as Topology, boardReadCap: 4 },
      { seed: 5, mode: 'passive' as SimMode, foldEvery: '4' as const, stalenessCost: 0.25 },
      { seed: 8, mode: 'passive' as SimMode, postPolicy: 'batched' as const, foldEvery: '2' as const, stalenessCost: 0.5 },
      { seed: 6, mode: 'divide' as SimMode, topology: 'blackboard' as Topology, digest: 'relevant' as Digest },
      { seed: 3, mode: 'negotiate' as SimMode, stalenessCost: 1.0, foldEvery: '4' as const },
    ];
    for (const cfg of configs) {
      const a = JSON.stringify(runSim(cfg));
      const b = JSON.stringify(runSim(cfg));
      expect(a, JSON.stringify(cfg)).toBe(b);
    }
  });

  it('staleness grows MONOTONICALLY with delivery latency (fold cadence AND withhold)', () => {
    // More fold lag => more staleness; withheld ('batched') posting adds latency
    // on top, so it goes stale even at fold cadence 1 where immediate never does.
    let sumF2 = 0;
    let sumF4 = 0;
    let sumBatched1 = 0;
    for (const seed of SEEDS) {
      const region = { seed, mode: 'passive' as SimMode, digest: 'relevant' as Digest };
      const f1 = runSim({ ...region, postPolicy: 'immediate', foldEvery: '1' }).stalenessSteps;
      const f2 = runSim({ ...region, postPolicy: 'immediate', foldEvery: '2' }).stalenessSteps;
      const f4 = runSim({ ...region, postPolicy: 'immediate', foldEvery: '4' }).stalenessSteps;
      const imm1 = runSim({ ...region, postPolicy: 'immediate', foldEvery: '1' }).stalenessSteps;
      const bat1 = runSim({ ...region, postPolicy: 'batched', foldEvery: '1' }).stalenessSteps;
      const bat4 = runSim({ ...region, postPolicy: 'batched', foldEvery: '4' }).stalenessSteps;
      // Zero at the default; climbing as the fold cadence lags further. Small
      // delivered-fact counts can floor a single cadence step to 0, so the
      // near step is non-decreasing while the far step is strictly larger; the
      // aggregate below pins the strict trend.
      expect(f1, `seed ${seed}`).toBe(0);
      expect(f2, `seed ${seed}`).toBeGreaterThanOrEqual(f1);
      expect(f4, `seed ${seed}`).toBeGreaterThan(f2);
      expect(f4, `seed ${seed}`).toBeGreaterThan(0);
      // Withheld posting adds latency: batched > immediate at the SAME cadence.
      expect(imm1, `seed ${seed}`).toBe(0);
      expect(bat1, `seed ${seed}`).toBeGreaterThan(0); // stale even at fold cadence 1
      expect(bat4, `seed ${seed}`).toBeGreaterThan(f4); // withhold stacks on fold lag
      sumF2 += f2;
      sumF4 += f4;
      sumBatched1 += bat1;
    }
    expect(sumF4).toBeGreaterThan(sumF2);
    expect(sumBatched1).toBeGreaterThan(0);
  });

  it('staleness is ZERO in the sync/blocking and blackboard arms, POSITIVE only for live-passive delayed delivery', () => {
    for (const seed of SEEDS) {
      // Sync/blocking arms: no live shared state to go stale, at ANY fold cadence.
      expect(runSim({ seed, mode: 'single', foldEvery: '4' }).stalenessSteps, `single ${seed}`).toBe(0);
      expect(runSim({ seed, mode: 'divide', foldEvery: '4' }).stalenessSteps, `divide ${seed}`).toBe(0);
      expect(runSim({ seed, mode: 'negotiate', foldEvery: '4' }).stalenessSteps, `negotiate ${seed}`).toBe(0);
      // Silent-passive shares nothing until Review: no live fold, so no staleness.
      expect(
        runSim({ seed, mode: 'passive', postPolicy: 'silent', foldEvery: '4' }).stalenessSteps,
        `silent ${seed}`,
      ).toBe(0);
      // Blackboard pulls fine-grained every boundary: never stale, even lazy/batched.
      expect(
        runSim({ seed, mode: 'passive', topology: 'blackboard', foldEvery: '4', postPolicy: 'batched' }).stalenessSteps,
        `blackboard ${seed}`,
      ).toBe(0);
      // POSITIVE only where the paper's failure lives: live passive + delayed delivery.
      expect(
        runSim({ seed, mode: 'passive', postPolicy: 'immediate', foldEvery: '4' }).stalenessSteps,
        `live-passive ${seed}`,
      ).toBeGreaterThan(0);
    }
  });

  it('GUARD: the original 4-lever ablation ordering still holds, and the new levers at their defaults leave it byte-for-byte unchanged', () => {
    for (const seed of SEEDS) {
      // The frozen sanity target over the four ORIGINAL modes at defaults.
      const single = runSim({ seed, mode: 'single' });
      const divide = runSim({ seed, mode: 'divide' });
      const negotiate = runSim({ seed, mode: 'negotiate' });
      const passive = runSim({ seed, mode: 'passive' });
      expect(passive.stepsToResolve, `seed ${seed}`).toBeLessThan(negotiate.stepsToResolve);
      expect(negotiate.stepsToResolve, `seed ${seed}`).toBeLessThanOrEqual(divide.stepsToResolve);
      expect(divide.stepsToResolve, `seed ${seed}`).toBeLessThan(single.stepsToResolve);
      // Naming the new levers at their documented defaults must be a NO-OP: the
      // baseline landscape the flywheel measures is preserved byte-for-byte.
      for (const [mode, base] of [
        ['single', single],
        ['divide', divide],
        ['negotiate', negotiate],
        ['passive', passive],
      ] as const) {
        const withDefaults = runSim({
          seed,
          mode,
          topology: 'message-passing',
          stalenessCost: 0.1,
        });
        expect(JSON.stringify(withDefaults), `${mode} seed ${seed}`).toBe(JSON.stringify(base));
      }
    }
  });
});
