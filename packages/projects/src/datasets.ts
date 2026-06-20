// SPDX-License-Identifier: MIT
//
// @metaharness/projects — datasets.ts (ADR-162 DarwinBench Dataset Registry).
//
// Borrowed from LangSmith's evaluation workflow: examples carry provenance and live
// in named splits, and a candidate is judged by an explicit gate rather than a single
// aggregate score. DarwinBench partitions every example into one of four splits
// (train / heldout / regression / adversarial). The promotion rule — the false-winner
// killer — is that a candidate must beat the incumbent on ALL FOUR splits, each
// certified by the shared seeded bootstrap (lower95 > 0). A variant that overfits the
// train split but ties/loses on the adversarial split is rejected.
//
// The optimization (measured in bench/datasets.bench.mjs): fourSplitGate() promotes a
// genuine winner and rejects a train-overfit false winner — the per-split bootstrap
// lower bounds make the difference visible and reproducible.

import type { BootstrapResult } from './core.js';
import { bootstrapDelta } from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// Provenance-tracked examples and the registry.
// ─────────────────────────────────────────────────────────────────────────────

/** The four DarwinBench splits a winner must sweep. */
export type Split = 'train' | 'heldout' | 'regression' | 'adversarial';

/** Where an example came from — its audited source of truth. */
export type Provenance =
  | 'github-issue'
  | 'ci-log'
  | 'accepted-pr'
  | 'advisory'
  | 'docs-drift'
  | 'agent-trace'
  | 'synthetic';

/** A single benchmark example with full provenance and split tagging. */
export interface DatasetExample {
  id: string;
  split: Split;
  provenance: Provenance;
  input: unknown;
  label: unknown;
}

const ALL_SPLITS: readonly Split[] = ['train', 'heldout', 'regression', 'adversarial'];
const VALID_SPLITS = new Set<string>(ALL_SPLITS);
const VALID_PROVENANCE = new Set<string>([
  'github-issue',
  'ci-log',
  'accepted-pr',
  'advisory',
  'docs-drift',
  'agent-trace',
  'synthetic',
]);

/** A registry of provenance-tracked examples, queryable by split. */
export class DatasetRegistry {
  // Insertion order is preserved per split so bootstrap pairing is deterministic.
  private readonly examples: DatasetExample[] = [];

  /** Append an example to the registry. */
  add(ex: DatasetExample): void {
    this.examples.push(ex);
  }

  /** All examples belonging to one split, in insertion order. */
  get(split: Split): DatasetExample[] {
    return this.examples.filter((e) => e.split === split);
  }

  /** Every example in the registry, in insertion order. */
  all(): DatasetExample[] {
    return this.examples.slice();
  }

  /** The splits that actually have at least one example, in canonical order. */
  splits(): Split[] {
    return ALL_SPLITS.filter((s) => this.examples.some((e) => e.split === s));
  }

  /** True iff every example carries a VALID split AND a valid provenance. */
  provenanceComplete(): boolean {
    return this.examples.every(
      (e) => VALID_SPLITS.has(e.split) && VALID_PROVENANCE.has(e.provenance),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The four-split promotion gate — the false-winner killer.
// ─────────────────────────────────────────────────────────────────────────────

/** Scores a variant's quality on a single example, in [0, 1]. */
export type ScoreFn = (ex: DatasetExample) => number;

/** The gate verdict: per-split bootstrap, which splits passed, and the decision. */
export interface FourSplitVerdict {
  promote: boolean;
  perSplit: Record<Split, BootstrapResult>;
  passedSplits: Split[];
}

/**
 * For EACH split, score every example with the incumbent and candidate, run the
 * seeded paired bootstrap of (candidate − incumbent), and pass the split iff
 * lower95 > 0 (candidate superior with 95% confidence). Promote iff ALL FOUR splits
 * are present AND every one of them passes. A split with no examples is missing,
 * which cannot pass — so an overfit candidate that wins train but ties adversarial
 * is rejected. Deterministic for a fixed seed (passed through to bootstrapDelta).
 */
export function fourSplitGate(
  reg: DatasetRegistry,
  incumbent: ScoreFn,
  candidate: ScoreFn,
  opts: { seed?: number } = {},
): FourSplitVerdict {
  const seed = opts.seed ?? 0;
  const perSplit = {} as Record<Split, BootstrapResult>;
  const passedSplits: Split[] = [];
  const present = new Set(reg.splits());

  for (const split of ALL_SPLITS) {
    const examples = reg.get(split);
    // Derive a per-split seed so splits don't share the same resample stream,
    // while the whole gate stays deterministic for a fixed top-level seed.
    const splitSeed = (seed + ALL_SPLITS.indexOf(split) * 1009) >>> 0;
    const inc = examples.map(incumbent);
    const cand = examples.map(candidate);
    const result = bootstrapDelta(inc, cand, { seed: splitSeed });
    perSplit[split] = result;
    if (present.has(split) && examples.length > 0 && result.lower95 > 0) {
      passedSplits.push(split);
    }
  }

  // Promotion requires all four splits present and all four passing.
  const allPresent = ALL_SPLITS.every((s) => present.has(s));
  const promote = allPresent && passedSplits.length === ALL_SPLITS.length;
  return { promote, perSplit, passedSplits };
}
