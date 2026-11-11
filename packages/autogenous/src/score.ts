import type { Score } from '@metaharness/flywheel';
import type { AdmissionResult } from 'autogenous';

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
  /** AGL admission of this candidate (Autogenous agl-types via the `autogenous` package), when evaluated. */
  aglAdmission?: AdmissionResult;
}

/** Project Autogenous' vector result onto the generic flywheel axes without scalarizing safety. */
export function projectAutogenousScore(
  result: AutogenousBenchResult,
  policyViolations: string[] = [],
  aglAdmission?: AdmissionResult,
): AutogenousScore {
  // An AGL refusal withdraws authorization; it never grants it.
  const authorized = result.authorized && (aglAdmission?.admissible ?? true);
  // radio-moe's evaluate() returns topicRatio = +Infinity when the off-topic frame scores 0
  // (perfect separation). Signed flywheel receipts cannot carry non-finite numbers, so map it
  // to the largest finite double, which keeps its ordering. NaN and -Infinity stay invalid.
  const topicRatio = result.topicRatio === Infinity ? Number.MAX_VALUE : result.topicRatio;
  const finite = [
    result.separation,
    result.familyStack,
    result.diversePair,
    topicRatio,
    result.correlatedGainVsBest,
    result.independentGainVsBest,
  ].every(Number.isFinite);
  const regressed =
    !finite ||
    !result.hardGatesPass ||
    !authorized ||
    !result.reversible ||
    policyViolations.length > 0;
  return {
    ...result,
    topicRatio,
    authorized,
    policyViolations: [...policyViolations],
    ...(aglAdmission ? { aglAdmission } : {}),
    primary: result.separation,
    noopRate: result.hardGatesPass ? 0 : 1,
    costPerWin: Math.max(0, result.costUsd ?? 0),
    regressed,
  };
}
