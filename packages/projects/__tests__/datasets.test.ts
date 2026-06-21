// SPDX-License-Identifier: MIT
//
// Tests for datasets.ts (ADR-162 DarwinBench Dataset Registry).

import { describe, expect, it } from 'vitest';
import {
  DatasetRegistry,
  fourSplitGate,
  type DatasetExample,
  type Provenance,
  type ScoreFn,
  type Split,
} from '../src/datasets.js';

// Build a registry with `per` examples in every split. Each example's id encodes
// its split and index so scorers can compute deterministic per-example quality.
function buildRegistry(per = 24): DatasetRegistry {
  const reg = new DatasetRegistry();
  const splits: Split[] = ['train', 'heldout', 'regression', 'adversarial'];
  const prov: Provenance = 'accepted-pr';
  for (const split of splits) {
    for (let i = 0; i < per; i += 1) {
      reg.add({ id: `${split}-${i}`, split, provenance: prov, input: i, label: i % 2 });
    }
  }
  return reg;
}

describe('DatasetRegistry.provenanceComplete', () => {
  it('(1) true when well-formed, false when a field is invalid', () => {
    const reg = buildRegistry(2);
    expect(reg.provenanceComplete()).toBe(true);

    const bad = new DatasetRegistry();
    bad.add({ id: 'x', split: 'train', provenance: 'accepted-pr', input: 1, label: 0 });
    // An invalid provenance breaks completeness.
    bad.add({ id: 'y', split: 'train', provenance: 'made-up' as Provenance, input: 1, label: 0 });
    expect(bad.provenanceComplete()).toBe(false);

    const badSplit = new DatasetRegistry();
    badSplit.add({ id: 'z', split: 'nope' as Split, provenance: 'ci-log', input: 1, label: 0 });
    expect(badSplit.provenanceComplete()).toBe(false);
  });
});

describe('fourSplitGate', () => {
  const incumbent: ScoreFn = (ex) => 0.5 + ((Number(ex.input) % 5) - 2) * 0.02;

  it('(missing-split) a clearly-better candidate is NOT promoted when a split is absent', () => {
    // Registry has only three of four splits — the adversarial split is missing.
    const reg = new DatasetRegistry();
    for (const split of ['train', 'heldout', 'regression'] as Split[]) {
      for (let i = 0; i < 12; i += 1) reg.add({ id: `${split}-${i}`, split, provenance: 'accepted-pr', input: i, label: i % 2 });
    }
    const candidate: ScoreFn = (ex) => incumbent(ex) + 0.1; // wins everywhere present
    const v = fourSplitGate(reg, incumbent, candidate, { seed: 3 });
    expect(v.promote).toBe(false); // cannot promote without all four splits present
    expect(v.passedSplits).not.toContain('adversarial');
  });

  it('(2) promotes a true winner that beats baseline on all four splits', () => {
    const reg = buildRegistry(24);
    // Candidate is uniformly +0.1 better on every example, every split.
    const candidate: ScoreFn = (ex) => incumbent(ex) + 0.1;
    const v = fourSplitGate(reg, incumbent, candidate, { seed: 1 });
    expect(v.promote).toBe(true);
    expect(v.passedSplits.sort()).toEqual(['adversarial', 'heldout', 'regression', 'train']);
    for (const s of ['train', 'heldout', 'regression', 'adversarial'] as Split[]) {
      expect(v.perSplit[s].lower95).toBeGreaterThan(0);
    }
  });

  it('(3) FALSE-WINNER guard: train-overfit candidate is rejected', () => {
    const reg = buildRegistry(24);
    // Overfit: big win on `train`, but exactly ties the incumbent on `adversarial`.
    const candidate: ScoreFn = (ex) => {
      if (ex.split === 'train') return incumbent(ex) + 0.2;
      if (ex.split === 'adversarial') return incumbent(ex); // tie → no certified win
      return incumbent(ex) + 0.05;
    };
    const v = fourSplitGate(reg, incumbent, candidate, { seed: 1 });
    expect(v.promote).toBe(false);
    expect(v.passedSplits).not.toContain('adversarial');
    expect(v.passedSplits).toContain('train');
    expect(v.perSplit.adversarial.lower95).toBeLessThanOrEqual(0);
  });

  it('(4) is deterministic for a fixed seed', () => {
    const reg = buildRegistry(16);
    const candidate: ScoreFn = (ex) => incumbent(ex) + 0.08;
    const a = fourSplitGate(reg, incumbent, candidate, { seed: 9 });
    const b = fourSplitGate(reg, incumbent, candidate, { seed: 9 });
    expect(a).toEqual(b);
  });
});
