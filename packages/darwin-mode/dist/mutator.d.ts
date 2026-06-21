import type { HarnessVariant, MutationSurface, RunTrace } from './types.js';
/**
 * A pluggable code generator. Given the parent's surface file and context, it
 * returns replacement code for that one file plus a one-line summary. The
 * default implementation is deterministic; an LLM-backed one slots in behind the
 * same `validateGeneratedCode` gate (ADR-071 §contract).
 */
export interface CodeGenerator {
    generateMutation(input: {
        parentCode: string;
        surface: MutationSurface;
        repoSummary: string;
        parentScore: number;
        failedTraces: string[];
        /**
         * Sibling-diversity nonce (ADR-104): the child's index within its
         * generation. Siblings mutating the same surface use it to explore
         * DIFFERENT edit directions (e.g. retry budget up vs. down) instead of an
         * identical edit. Deterministic, defaults to 0 — so reproducibility holds.
         */
        nonce?: number;
    }): Promise<{
        code: string;
        summary: string;
    }>;
}
/**
 * The default mutator: deterministic, seeded, dependency-free. It applies the
 * first matching bounded edit (in a seeded rotation) to the parent file. If no
 * edit rule matches, it appends a tracking comment — a safe, signature-neutral
 * no-op so the surface still differs and the file still passes the scanner.
 */
export declare class DeterministicMutator implements CodeGenerator {
    private readonly seed;
    constructor(seed?: number);
    generateMutation(input: {
        parentCode: string;
        surface: MutationSurface;
        repoSummary: string;
        parentScore: number;
        failedTraces: string[];
        nonce?: number;
    }): Promise<{
        code: string;
        summary: string;
    }>;
}
/**
 * Reflection context (ADR-071 §contract) carried from a parent's evaluation into
 * its child's mutation. The DeterministicMutator ignores it (stays reproducible);
 * an LLM-backed CodeGenerator uses it to target the parent's actual failures —
 * closing the self-improvement loop instead of mutating blind.
 */
export interface MutationContext {
    /** Short human-readable repo summary (RepoProfile.summary). */
    repoSummary?: string;
    /** The parent variant's finalScore (0 if unknown). */
    parentScore?: number;
    /** Compact, one-line-per-failure summaries of the parent's failing traces. */
    failedTraces?: string[];
}
/**
 * Distil a parent's run traces into compact failure summaries for the mutator.
 * A trace "failed" if it exited non-zero, timed out, or tripped a safety block.
 * Pure and deterministic — order-preserving, no wall-clock, no I/O.
 */
export declare function summarizeFailedTraces(traces: RunTrace[]): string[];
/**
 * Deterministically pick one of the seven surfaces from `(generation+index+seed)`.
 * Same inputs ⇒ same surface (reproducibility, ADR-070 §seed).
 */
export declare function pickSurface(generation: number, index: number, seed: number): MutationSurface;
/**
 * Recombine two parents into a child (genetic crossover, ADR-089). The child is
 * parentA's directory with a deterministic, non-empty PROPER subset of surface
 * files replaced by parentB's versions — so it inherits some surfaces from each.
 *
 * Recombination only — no code is generated — so every adopted file already
 * passed the gate when its parent was built; we re-run `validateGeneratedCode`
 * defensively and skip any file that would fail (the child keeps parentA's), so
 * the child always still passes `inspectVariant`.
 *
 * The archive is a strict tree (one `parentId`): we record `parentA` as the tree
 * parent and name `parentB` in the summary, so every tree invariant holds.
 */
export declare function createCrossoverVariant(parentA: HarnessVariant, parentB: HarnessVariant, workRoot: string, generation: number, index: number, seed?: number, surfacesFromB?: readonly MutationSurface[]): Promise<HarnessVariant>;
/**
 * Recursively copy a variant directory using `node:fs/promises` only (never a
 * shell). The destination is created fresh; only the parent's files are copied,
 * so no extraneous entry can leak in.
 */
export declare function copyVariantDir(src: string, dest: string): Promise<void>;
/**
 * Create a child variant from `parent`: copy its directory, pick one surface
 * deterministically, regenerate that surface's file via `gen`, validate the
 * generated code BEFORE writing, and return the resulting `HarnessVariant`.
 *
 * If `validateGeneratedCode` reports any violation, the mutation is DISCARDED
 * and the parent's surface file is left untouched (a safe no-op). The child
 * directory therefore always still passes `inspectVariant`.
 */
export declare function createChildVariant(parent: HarnessVariant, workRoot: string, generation: number, index: number, gen?: CodeGenerator, seed?: number, context?: MutationContext): Promise<HarnessVariant>;
//# sourceMappingURL=mutator.d.ts.map