import type { Budget, Edit, HarnessDocument, Observation, Scope } from './types.js';
export declare function record(value: unknown): asserts value is Record<string, unknown>;
export declare function keys(value: Record<string, unknown>, allowed: readonly string[]): void;
export declare function finite(value: unknown, label: string): asserts value is number;
/** Integer nanodollars avoid false budget denials from decimal addition. */
export declare function moneyUnits(value: number): number;
export declare function id(value: unknown): asserts value is string;
/** Snapshot untrusted JSON without invoking getters or accepting executable values. */
export declare function snapshot<T>(value: T, maxBytes?: number): T;
export declare function digestDocument(document: HarnessDocument): string;
export declare function validateDocument(document: HarnessDocument): void;
export declare function validateBudget(budget: Budget): void;
export declare function validateObservations(value: readonly Observation[], document: HarnessDocument): void;
export declare function applyEdits(document: HarnessDocument, edits: readonly Edit[], observations: readonly Observation[], scope?: Scope): HarnessDocument;
//# sourceMappingURL=validation.d.ts.map