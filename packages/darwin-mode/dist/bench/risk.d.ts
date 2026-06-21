import type { PromotionDecision } from './types.js';
/** A bounded, monotonically-spent risk budget shared across evolution rounds. */
export interface RiskBudget {
    total: number;
    spent: number;
}
export declare function makeRiskBudget(total: number): RiskBudget;
export declare function riskRemaining(budget: RiskBudget): number;
/**
 * Charge `amount` against the budget iff it fits. Mutates `budget.spent` only on
 * success. Returns whether the charge was admitted and the remaining budget.
 */
export declare function chargeRisk(budget: RiskBudget, amount: number): {
    ok: boolean;
    remaining: number;
};
export interface StatisticalGateInput {
    /** The base statistical promotion decision (ADR-076). */
    decision: PromotionDecision;
    /** Hidden-test pass rate must not regress (SOTA rule). */
    childHiddenTestRate: number;
    parentHiddenTestRate: number;
    /** Cost-per-solve must stay within `costCeilingFactor`× the parent (SOTA rule). */
    childCostPerSolve: number;
    parentCostPerSolve: number;
    /** Default 1.20 (≤ +20%). */
    costCeilingFactor?: number;
    /** Optional global risk budget; charged `riskPerEdit` on admission. */
    riskBudget?: RiskBudget;
    /** Risk charged per admitted self-modification. Default 1. */
    riskPerEdit?: number;
}
export interface StatisticalGateResult {
    admit: boolean;
    reasons: string[];
    riskRemaining: number;
}
/**
 * The full SOTA / SGM admission gate. A child is admitted only when the base
 * statistical decision promotes AND the hidden-test rate is held/improved AND
 * cost-per-solve is within the ceiling AND the global risk budget can absorb the
 * edit. The risk budget is charged ONLY on admission.
 */
export declare function admitWithStatisticalGate(input: StatisticalGateInput): StatisticalGateResult;
//# sourceMappingURL=risk.d.ts.map