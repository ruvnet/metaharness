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
  // Per-class counters. `uses` counts successful recalls (cue hits); `fails` counts
  // recalled cues that did NOT lead to a verified finding (NEGATIVE-example signal).
  private readonly useCounts = new Map<string, number>();
  private readonly failCounts = new Map<string, number>();
  constructor(mem?: TieredMemory) {
    this.mem = mem ?? new TieredMemory();
  }
  recall(weaknessClass: string): Strategy | undefined {
    const s = this.mem.get<Strategy>('mutation', weaknessClass);
    if (s) this.useCounts.set(weaknessClass, (this.useCounts.get(weaknessClass) ?? 0) + 1);
    return s;
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

  /** How many times a recalled cue for this class produced a HIT (successful recall). */
  uses(weaknessClass: string): number {
    return this.useCounts.get(weaknessClass) ?? 0;
  }

  /**
   * DECAY/PRUNE: drop strategies whose `uses < minUses` (stale/unhelpful), returning
   * the count dropped. Pruned classes lose their stored strategy and counters so they
   * no longer persist or recall.
   */
  prune(minUses: number): number {
    let dropped = 0;
    for (const k of [...this.keys]) {
      if (this.uses(k) < minUses) {
        this.keys.delete(k);
        this.mem.delete('mutation', k);
        this.useCounts.delete(k);
        this.failCounts.delete(k);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** NEGATIVE example: a recalled cue for this class did NOT lead to a verified finding. */
  recordFailure(weaknessClass: string): void {
    this.failCounts.set(weaknessClass, (this.failCounts.get(weaknessClass) ?? 0) + 1);
  }

  /** How many times a recalled cue for this class failed to verify. */
  failures(weaknessClass: string): number {
    return this.failCounts.get(weaknessClass) ?? 0;
  }

  /** A cue is DISTRUSTED once its failure count exceeds `maxFailures` — stop trusting it. */
  isDistrusted(weaknessClass: string, maxFailures = 2): boolean {
    return this.failures(weaknessClass) > maxFailures;
  }

  /**
   * PERSISTENCE: serialize the learned strategies plus their use/failure counters to a
   * JSON string. Round-trips losslessly through `fromJSON` — reload restores recall.
   */
  toJSON(): string {
    const strategies = [...this.keys].sort().map((k) => this.mem.get<Strategy>('mutation', k)!).filter(Boolean);
    const uses: Record<string, number> = {};
    const failures: Record<string, number> = {};
    for (const k of [...this.keys].sort()) {
      const u = this.useCounts.get(k);
      const f = this.failCounts.get(k);
      if (u !== undefined) uses[k] = u;
      if (f !== undefined) failures[k] = f;
    }
    return JSON.stringify({ version: 1, strategies, uses, failures });
  }

  /** Rebuild a StrategyMemory from a `toJSON` string. Restores strategies + counters. */
  static fromJSON(s: string): StrategyMemory {
    const data = JSON.parse(s) as {
      strategies?: Strategy[];
      uses?: Record<string, number>;
      failures?: Record<string, number>;
    };
    const out = new StrategyMemory();
    for (const st of data.strategies ?? []) {
      if (st && typeof st.weaknessClass === 'string') out.record(st);
    }
    for (const [k, v] of Object.entries(data.uses ?? {})) out.useCounts.set(k, v);
    for (const [k, v] of Object.entries(data.failures ?? {})) out.failCounts.set(k, v);
    return out;
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
  /** Rounds where a recalled cue was SUPPRESSED because its class is distrusted. */
  distrusted: number;
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
  let distrusted = 0;

  for (const t of targets) {
    // NEGATIVE memory: if the class is distrusted (its recalled cue keeps failing to
    // verify), suppress the cue and treat the round as unassisted. We only consult
    // recall when memory is on; distrust short-circuits BEFORE injection so a bad cue
    // can't drive a cheap-but-wrong attempt.
    let recalled = useMemory ? memory.recall(t.weaknessClass) : undefined;
    if (recalled && memory.isDistrusted(t.weaknessClass)) {
      recalled = undefined;
      distrusted += 1;
    }
    const r = await attempt({ target: t.id, recalled });
    rounds.push({ target: t.id, weaknessClass: t.weaknessClass, verified: r.verified, costUnits: round6(r.costUnits), usedMemory: !!recalled });
    // A round that USED memory but still failed to verify is a NEGATIVE example: the
    // recalled cue did not pan out — record it so the class can become distrusted.
    if (recalled && !r.verified) {
      memory.recordFailure(t.weaknessClass);
    }
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
    distrusted,
  };
}
