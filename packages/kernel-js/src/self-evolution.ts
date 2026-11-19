// SPDX-License-Identifier: MIT
//
// Self-evolving routing. Wraps `@ruvector/emergent-time`'s LearnedWeights
// over the kernel's 3-tier router so a harness can ADAPT its routing
// decisions over time based on the outcomes of past calls.
//
// Per ADR-014 (Self-evolution + federation), this is the "exotic" mode —
// off by default, opt-in. When enabled, every routing decision feeds back
// a reward signal (success/failure + latency + cost), and the LearnedWeights
// inference shifts future decisions toward whichever tier worked best for
// similar tasks.
//
// Honesty caveat from the @ruvector/emergent-time README applies here:
// "diagnostic signal, no proven early-warning lead over a fair baseline".
// The self-evolving path is gated behind explicit opt-in for that reason.

export type RoutingTier = 'codemod' | 'small' | 'frontier';

export interface RoutingHistoryEntry {
  /** Tier that was chosen. */
  tier: RoutingTier;
  /** Did the call succeed (e.g. task completed)? */
  success: boolean;
  /** Latency in ms. */
  latencyMs: number;
  /** Approximate cost in USD. */
  costUsd: number;
  /** Optional task fingerprint (semantic class). */
  taskFingerprint?: string;
}

export interface SelfEvolvingConfig {
  /** When true, applies learned weights. When false, passes through. */
  enabled: boolean;
  /** Reward signal weights. Defaults sum to 1.0. */
  rewardMix?: {
    successWeight: number;     // default 0.5
    latencyWeight: number;     // default 0.3 — lower latency = higher reward
    costWeight: number;        // default 0.2 — lower cost = higher reward
  };
  /** Bias toward small-tier (saving budget) — multiplier on small's weight. */
  smallTierBias?: number;
}

interface LearnedWeightsApi {
  LearnedWeights: new (config: { tiers: string[] }) => {
    update(tier: string, reward: number): void;
    weight(tier: string): number;
    weights(): Record<string, number>;
  };
}

let _emergent: LearnedWeightsApi | null | undefined;
async function loadEmergent(): Promise<LearnedWeightsApi | null> {
  if (_emergent !== undefined) return _emergent;
  try {
    const mod = await import('@ruvector/emergent-time') as unknown as LearnedWeightsApi;
    // Probe-construct + verify the API contract holds. Catches both:
    //   (1) WASM not initialised — constructor throws on `learnedweights_new`
    //   (2) API drift — module loaded but `.update` no longer on the prototype
    // In either case, fall back to the local EMA path so tests + runtime see
    // a consistent "graceful absent" signal.
    const probe = new mod.LearnedWeights({ tiers: ['probe'] });
    if (typeof probe.update !== 'function' || typeof probe.weights !== 'function') {
      throw new Error('LearnedWeights API surface drifted');
    }
    _emergent = mod;
    return mod;
  } catch {
    _emergent = null;
    return null;
  }
}

/**
 * Compute a reward in [0, 1] from a single routing outcome.
 *
 * - success contributes successWeight directly (1 if succeeded, 0 if not)
 * - latency contributes latencyWeight scaled by 1/(1 + ms/1000) — saturates
 * - cost contributes costWeight scaled by 1/(1 + usd*1000) — saturates
 */
export function computeReward(entry: RoutingHistoryEntry, config: SelfEvolvingConfig): number {
  const mix = config.rewardMix ?? { successWeight: 0.5, latencyWeight: 0.3, costWeight: 0.2 };
  const successComponent = entry.success ? 1 : 0;
  const latencyComponent = 1 / (1 + entry.latencyMs / 1000);
  const costComponent = 1 / (1 + entry.costUsd * 1000);
  const total =
    mix.successWeight * successComponent +
    mix.latencyWeight * latencyComponent +
    mix.costWeight * costComponent;
  // Normalise to [0, 1] in case the weights don't sum to 1.
  const denominator = mix.successWeight + mix.latencyWeight + mix.costWeight;
  return total / denominator;
}

/**
 * A learned-weights router. Wraps the kernel router's decision with a
 * post-hoc weight applied to each tier; weights update from outcomes.
 *
 * When `config.enabled === false`, this is a pure pass-through.
 */
export class SelfEvolvingRouter {
  private weights: Record<RoutingTier, number> = { codemod: 1, small: 1, frontier: 1 };
  private history: RoutingHistoryEntry[] = [];
  private impl: { update(tier: string, reward: number): void; weight(tier: string): number; weights(): Record<string, number> } | null = null;
  // Caches the in-flight load, not just the resolved result: two concurrent
  // first calls to ensureLoaded() both see `this.impl === null` and would
  // otherwise each construct their own LearnedWeights, silently discarding
  // whichever instance (and any update already applied to it) loses the
  // last-write-wins race on `this.impl`. Caching the promise itself means
  // every concurrent caller awaits the same single construction.
  private implPromise: Promise<void> | null = null;

  constructor(private config: SelfEvolvingConfig) {}

  async ensureLoaded(): Promise<void> {
    if (!this.config.enabled) return;
    if (this.impl) return;
    this.implPromise ??= loadEmergent()
      .then((emergent) => {
        if (emergent) {
          this.impl = new emergent.LearnedWeights({ tiers: ['codemod', 'small', 'frontier'] });
        }
      })
      .catch((err) => {
        // Don't let a transient construction failure permanently poison
        // every future call with the same cached rejection — clear the
        // cache so the next ensureLoaded() retries from scratch, matching
        // pre-fix behavior (which always retried, since nothing was cached).
        this.implPromise = null;
        throw err;
      });
    return this.implPromise;
  }

  /**
   * Record an outcome and update learned weights.
   * Returns the reward used (for tests/telemetry).
   */
  async recordOutcome(entry: RoutingHistoryEntry): Promise<number> {
    this.history.push(entry);
    if (!this.config.enabled) return 0;
    await this.ensureLoaded();
    const reward = computeReward(entry, this.config);
    if (this.impl) {
      this.impl.update(entry.tier, reward);
      const w = this.impl.weights();
      this.weights = {
        codemod: w.codemod ?? 1,
        small: w.small ?? 1,
        frontier: w.frontier ?? 1,
      };
    } else {
      // Local exponential moving average fallback when emergent-time
      // isn't installed. Smaller learning rate so single bad runs don't
      // crater a tier.
      //
      // Important: the EMA target is `reward * 2`, not `reward`. computeReward
      // returns values in [0, 1] where 0.5 is "neutral / break-even". Mapping
      // to [0, 2] keeps the initial weight of 1.0 as the neutral baseline:
      // successful tiers pull above 1.0, failed tiers pull below, untouched
      // tiers stay at 1.0. Without this rescale, ALL tiers slowly drift below
      // 1.0 and untouched tiers always win — silently breaking re-ranking.
      const lr = 0.1;
      const target = reward * 2;
      this.weights[entry.tier] = (1 - lr) * this.weights[entry.tier] + lr * target;
    }
    if (this.config.smallTierBias) {
      this.weights.small *= this.config.smallTierBias;
    }
    return reward;
  }

  /**
   * Get the current weight for a tier. Higher = more preferred.
   */
  weightFor(tier: RoutingTier): number {
    return this.weights[tier];
  }

  /**
   * Re-rank a tier shortlist by current weights.
   * Returns tiers ordered most preferred first.
   */
  reRank(tiers: RoutingTier[]): RoutingTier[] {
    return [...tiers].sort((a, b) => this.weights[b] - this.weights[a]);
  }

  history_(): readonly RoutingHistoryEntry[] {
    return this.history;
  }
}
