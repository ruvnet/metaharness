import type { BenchmarkResult, BenchmarkTask, GateResult } from './types.js';
/** Solve gate: the public AND hidden acceptance tests both pass. */
export declare function solveGate(r: BenchmarkResult): GateResult;
/** Regression gate: the full relevant suite still passes. */
export declare function regressionGate(r: BenchmarkResult): GateResult;
/** Safety gate: zero blocked-file touches and zero safety violations (ADR-071). */
export declare function safetyGate(r: BenchmarkResult): GateResult;
/** Cost gate: the metered cost is within the task's budget. */
export declare function costGate(r: BenchmarkResult, task: BenchmarkTask): GateResult;
/** Repro gate: a clean checkout reproduced the result. */
export declare function reproGate(cleanReplay: boolean): GateResult;
/**
 * Evaluate all five gates in canonical order: solve, regression, safety, cost,
 * repro. Returns one GateResult per gate.
 */
export declare function evaluateGates(r: BenchmarkResult, task: BenchmarkTask, cleanReplay: boolean): GateResult[];
/** True iff every gate in the list passed. */
export declare function allGatesPass(gates: GateResult[]): boolean;
//# sourceMappingURL=gates.d.ts.map