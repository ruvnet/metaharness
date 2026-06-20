// SPDX-License-Identifier: MIT
//
// @metaharness/projects — self-learning discovery loop. As the harness verifies
// weaknesses it REMEMBERS the winning proof STRATEGY per weakness class (a
// ruVector-style memory). On later targets of a class it has seen, the strategy is
// recalled and injected — so the CHEAP lane can handle recurring classes that
// previously needed the frontier lane, and cost-per-verified-finding falls as the
// loop learns. Lanes are INJECTED, so the loop is pure and deterministically
// unit-testable with no LLM (the real wiring lives in bench/learning-loop.bench.mjs).

import { round6 } from './core.js';
import { TieredMemory } from './memory-tiers.js';

/** A learned, reusable proof strategy for a weakness class. */
export interface Strategy {
  weaknessClass: string;
  hint: string; // a redacted, generalized cue (e.g. "zero divisor") — never a raw payload
}

/**
 * Compounding memory of winning strategies — backed by the metaharness `TieredMemory`
 * (ADR-161), stored in the `mutation` tier (prior winning policies/strategies). This
 * is the ruVector-style capability the rest of the program uses, not a bespoke store.
 */
export class StrategyMemory {
  private readonly mem: TieredMemory;
  private readonly keys = new Set<string>();
  constructor(mem?: TieredMemory) {
    this.mem = mem ?? new TieredMemory();
  }
  recall(weaknessClass: string): Strategy | undefined {
    return this.mem.get<Strategy>('mutation', weaknessClass);
  }
  record(s: Strategy): void {
    if (this.keys.has(s.weaknessClass)) return; // first winning strategy per class wins
    this.keys.add(s.weaknessClass);
    this.mem.put<Strategy>('mutation', s.weaknessClass, s);
  }
  size(): number {
    return this.mem.size('mutation');
  }
  export(): Strategy[] {
    return [...this.keys].sort().map((k) => this.mem.get<Strategy>('mutation', k)!).filter(Boolean);
  }
}

export interface LoopTarget {
  id: string;
  /** The weakness class this target exercises (routes memory recall). */
  weaknessClass: string;
}

export interface AttemptInput {
  target: string;
  /** A recalled strategy for this class, if the loop has learned one. */
  recalled?: Strategy;
}

export interface AttemptResult {
  verified: boolean;
  weaknessClass?: string;
  hint?: string; // the winning generalized cue to remember (defensive: not a payload)
  costUnits: number;
}

export type AttemptLane = (input: AttemptInput) => Promise<AttemptResult> | AttemptResult;

export interface RoundResult {
  target: string;
  weaknessClass: string;
  verified: boolean;
  costUnits: number;
  usedMemory: boolean; // a recalled strategy was injected this round
}

export interface LearningLoopResult {
  rounds: RoundResult[];
  verified: number;
  totalCost: number;
  costPerVerified: number | null;
  memorySize: number;
  /** Mean cost on memory-assisted rounds vs unassisted (lower assisted = learning). */
  costWithMemory: number | null;
  costWithoutMemory: number | null;
}

/**
 * Run the self-learning loop over a target sequence. With `useMemory` (default),
 * a verified round's strategy is stored and recalled for later same-class targets.
 * Deterministic given a deterministic `attempt` lane.
 */
export async function runLearningLoop(
  targets: LoopTarget[],
  attempt: AttemptLane,
  opts: { memory?: StrategyMemory; useMemory?: boolean } = {},
): Promise<LearningLoopResult> {
  const memory = opts.memory ?? new StrategyMemory();
  const useMemory = opts.useMemory ?? true;
  const rounds: RoundResult[] = [];

  for (const t of targets) {
    const recalled = useMemory ? memory.recall(t.weaknessClass) : undefined;
    const r = await attempt({ target: t.id, recalled });
    rounds.push({ target: t.id, weaknessClass: t.weaknessClass, verified: r.verified, costUnits: round6(r.costUnits), usedMemory: !!recalled });
    // Key memory on the TARGET's declared class (known a priori) so recall on later
    // same-class targets always aligns — not on the post-hoc detected exception class.
    if (useMemory && r.verified && r.hint) {
      memory.record({ weaknessClass: t.weaknessClass, hint: r.hint });
    }
  }

  const verified = rounds.filter((r) => r.verified).length;
  const totalCost = round6(rounds.reduce((a, r) => a + r.costUnits, 0));
  const assisted = rounds.filter((r) => r.usedMemory);
  const unassisted = rounds.filter((r) => !r.usedMemory);
  const mean = (xs: RoundResult[]) => (xs.length ? round6(xs.reduce((a, r) => a + r.costUnits, 0) / xs.length) : null);

  return {
    rounds,
    verified,
    totalCost,
    costPerVerified: verified ? round6(totalCost / verified) : null,
    memorySize: memory.size(),
    costWithMemory: mean(assisted),
    costWithoutMemory: mean(unassisted),
  };
}
