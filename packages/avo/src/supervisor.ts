// SPDX-License-Identifier: MIT

import type { Supervisor } from './ports.js';
import type { Hypothesis, SupervisorIntervention, VariationState } from './types.js';

export interface SupervisorOptions {
  policyVersion: string;
  epsilon?: number;
  plateauWindow?: number;
  repeatedFailureLimit?: number;
  minimumNoveltyEntropy?: number;
  maxCostPerProgress?: number;
}

export type StrategyFactory = (input: {
  state: Readonly<VariationState>;
  trigger: SupervisorIntervention['trigger'];
  dominantFailure?: string;
}) => Promise<[Hypothesis, Hypothesis, Hypothesis]>;

function entropy(values: number[]): number {
  const positive = values.filter((value) => value > 0);
  const sum = positive.reduce((total, value) => total + value, 0);
  if (sum === 0) return 0;
  return -positive.reduce((total, value) => {
    const p = value / sum;
    return total + p * Math.log(p);
  }, 0);
}

/** Redirects search; it never receives or returns a capability mutation. */
export class SemanticSupervisor implements Supervisor {
  private readonly epsilon: number;
  private readonly window: number;
  private readonly failureLimit: number;
  private readonly minEntropy: number;
  private readonly maxCostPerProgress: number;

  constructor(private readonly options: SupervisorOptions, private readonly strategies: StrategyFactory) {
    this.epsilon = options.epsilon ?? 1e-6;
    this.window = options.plateauWindow ?? 5;
    this.failureLimit = options.repeatedFailureLimit ?? 3;
    this.minEntropy = options.minimumNoveltyEntropy ?? -1;
    this.maxCostPerProgress = options.maxCostPerProgress ?? Infinity;
  }

  async observe(state: Readonly<VariationState>): Promise<SupervisorIntervention | null> {
    let trigger: SupervisorIntervention['trigger'] | null = null;
    let dominantFailure: string | undefined;
    const evaluations = state.evaluations;
    if (evaluations.length >= this.window) {
      const recent = evaluations.slice(-this.window).map((value) => value.quality);
      if (Math.max(...recent) - Math.min(...recent) < this.epsilon) trigger = 'plateau';
    }
    const failures = new Map<string, number>();
    for (const evaluation of evaluations) {
      if (!evaluation.failureSignature) continue;
      failures.set(evaluation.failureSignature, (failures.get(evaluation.failureSignature) ?? 0) + 1);
    }
    for (const [signature, count] of failures) {
      if (count >= this.failureLimit) {
        trigger = 'repeated-failure';
        dominantFailure = signature;
        break;
      }
    }
    if (!trigger && this.minEntropy >= 0 && entropy(state.candidates.map((candidate) => candidate.novelty)) < this.minEntropy) {
      trigger = 'low-novelty';
    }
    const qualityGain = evaluations.length > 1
      ? Math.max(0, evaluations.at(-1)!.quality - evaluations[0].quality)
      : 0;
    if (!trigger && state.budget.costUsdUsed / Math.max(qualityGain, 1e-9) > this.maxCostPerProgress) {
      trigger = 'cost-progress';
    }
    if (!trigger) return null;

    const proposed = await this.strategies({ state, trigger, dominantFailure });
    const mechanisms = new Set(proposed.map((strategy) => strategy.causalMechanism.trim().toLowerCase()));
    if (mechanisms.size !== 3) throw new Error('avo: supervisor must issue three causally distinct strategies');
    const alternate = state.candidates
      .filter((candidate) => candidate.id !== state.currentCandidateId && candidate.committed)
      .sort((a, b) => b.learningPotential - a.learningPotential || b.novelty - a.novelty)[0];
    return {
      trigger,
      reason: dominantFailure ? `${trigger}: ${dominantFailure}` : trigger,
      dominantFailure,
      alternateCandidateId: alternate?.id,
      strategies: proposed,
      explorationAllocation: Math.min(1, 0.25 + state.interventions.length * 0.1),
      policyVersion: this.options.policyVersion,
    };
  }
}
