import type { Score } from '@metaharness/flywheel';

export interface AutogenousBenchResult {
  /** radio-moe mesh-evolve.ts separation fitness. */
  separation: number;
  familyStack: number;
  diversePair: number;
  topicRatio: number;
  hardGatesPass: boolean;
  correlatedGainVsBest: number;
  independentGainVsBest: number;
  /** Whether the caller has authority to promote this candidate. */
  authorized: boolean;
  /** Whether the parent remains available as a verified rollback target. */
  reversible: boolean;
  /** Optional measured cost for one benchmark run. */
  costUsd?: number;
}

export interface AutogenousScore extends Score, AutogenousBenchResult {
  policyViolations: string[];
}

/** Project Autogenous' vector result onto the generic flywheel axes without scalarizing safety. */
export function projectAutogenousScore(
  result: AutogenousBenchResult,
  policyViolations: string[] = [],
): AutogenousScore {
  const finite = [
    result.separation,
    result.familyStack,
    result.diversePair,
    result.topicRatio,
    result.correlatedGainVsBest,
    result.independentGainVsBest,
  ].every(Number.isFinite);
  const regressed =
    !finite ||
    !result.hardGatesPass ||
    !result.authorized ||
    !result.reversible ||
    policyViolations.length > 0;
  return {
    ...result,
    policyViolations: [...policyViolations],
    primary: result.separation,
    noopRate: result.hardGatesPass ? 0 : 1,
    costPerWin: Math.max(0, result.costUsd ?? 0),
    regressed,
  };
}
