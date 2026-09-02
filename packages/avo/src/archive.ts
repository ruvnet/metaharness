// SPDX-License-Identifier: MIT

import type { Candidate } from './types.js';

export interface SelectionWeights {
  novelty: number;
  uncertainty: number;
  learning: number;
  risk: number;
  quality: number;
  cost: number;
  latency: number;
}

export const DEFAULT_SELECTION_WEIGHTS: SelectionWeights = {
  novelty: 0.2,
  uncertainty: 0.15,
  learning: 0.2,
  risk: 0.3,
  quality: 1,
  cost: 0.25,
  latency: 0.05,
};

export function candidateUtility(candidate: Candidate, archiveSize: number, w = DEFAULT_SELECTION_WEIGHTS): number {
  const fitness = w.quality * candidate.evaluation.quality
    - w.cost * candidate.evaluation.costUsd
    - w.latency * Math.log1p(candidate.evaluation.wallTimeMs);
  const uncertainty = Math.sqrt(Math.log1p(archiveSize) / (1 + candidate.visits));
  return fitness
    + w.novelty * candidate.novelty
    + w.uncertainty * uncertainty
    + w.learning * candidate.learningPotential
    - w.risk * candidate.risk;
}

export class DarwinArchive {
  private readonly candidates = new Map<string, Candidate>();

  insert(candidate: Candidate): void {
    if (!this.candidates.has(candidate.id)) this.candidates.set(candidate.id, structuredClone(candidate));
  }

  get(id: string): Candidate | undefined {
    const value = this.candidates.get(id);
    return value ? structuredClone(value) : undefined;
  }

  all(): Candidate[] {
    return [...this.candidates.values()].map((value) => structuredClone(value));
  }

  select(excludeId?: string): Candidate {
    const pool = this.all().filter((candidate) => candidate.id !== excludeId);
    const usable = pool.length > 0 ? pool : this.all();
    if (usable.length === 0) throw new Error('avo: archive is empty');
    usable.sort((a, b) => candidateUtility(b, usable.length) - candidateUtility(a, usable.length) || a.id.localeCompare(b.id));
    const selected = usable[0];
    const stored = this.candidates.get(selected.id)!;
    stored.visits += 1;
    return selected;
  }

  bestVerified(): Candidate | null {
    return this.all()
      .filter((candidate) => candidate.committed && qualifies(candidate.evaluation, null, 0))
      .sort((a, b) => b.evaluation.quality - a.evaluation.quality || a.id.localeCompare(b.id))[0] ?? null;
  }
}

export function qualifies(child: Candidate['evaluation'], parent: Candidate['evaluation'] | null, delta: number): boolean {
  const improved = parent === null || child.quality - parent.quality >= delta;
  const statistical = child.lowerConfidenceBound === undefined || child.lowerConfidenceBound >= delta;
  return child.correct
    && child.safe
    && child.replayable
    && child.noRegression
    && child.budgetValid
    && child.protectedTestsPassed
    && child.policyViolations === 0
    && improved
    && statistical;
}
