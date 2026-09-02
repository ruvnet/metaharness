import type { Corpus, CorpusSite } from './corpus.js';
import type { Finding } from './types.js';
import { type FitnessBreakdown } from './scoring.js';
import type { GeneratedDetectorCandidate } from './selfwrite.js';
/** The evolvable security-assertion classes (ADR-155 Addendum B). */
export type InvariantKind = 'input-constraint' | 'memory-safety' | 'auth-boundary' | 'serialization' | 'path-traversal' | 'taint-flow' | 'race-condition';
export declare const INVARIANT_KINDS: readonly InvariantKind[];
/** Map a weakness class to the invariant kind whose violation reveals it. */
export declare function kindForWeakness(weakness: string): InvariantKind;
/** A security assertion over a code site (never an exploit). */
export interface SecurityInvariant {
    id: string;
    kind: InvariantKind;
    target: string;
    /** Human-readable assertion. Defensive only. */
    assertion: string;
    /** 0..1 — how tightly it constrains behavior (more checkable ⇒ more falsifiable). */
    strength: number;
}
/** The genome the invariant harness evolves. */
export interface InvariantGenome {
    id: string;
    parentId?: string;
    /** Which invariant classes to assert. */
    kinds: InvariantKind[];
    /** 0..1 assertion strength. */
    strength: number;
    /** Fuzz budget per invariant (seconds). Clamp 10..600. */
    fuzzBudgetSeconds: number;
    safetyProfile: 'strict-defensive';
}
/** A fuzzer-found counterexample: the proof a finding is real (no exploit code). */
export interface Falsification {
    invariantId: string;
    kind: InvariantKind;
    siteId: string;
    file: string;
    symbol: string;
    weakness: string;
    /** A NON-weaponized description of the violating input class. */
    counterexample: string;
    severity: number;
}
/** The fuzz oracle interface — Phase 2 implements this against a real fuzzer. */
export interface FuzzOracle {
    readonly name: string;
    readonly version: string;
    /** Attempt to falsify an invariant over a site; null ⇒ the invariant holds. */
    attempt(inv: SecurityInvariant, site: CorpusSite, fuzzBudgetSeconds: number): Falsification | null;
}
/**
 * Deterministic MOCK fuzzer. Falsifies an invariant iff the site is genuinely
 * vulnerable, the invariant's kind matches the weakness, and the effective fuzz
 * power (strength scaled by budget) reaches the site's subtlety threshold. Clean
 * code and decoys yield NO counterexample → no false positive (the trust prop).
 */
export declare class MockFuzzOracle implements FuzzOracle {
    readonly name = "mock-fuzz-oracle";
    readonly version = "1.0.0";
    attempt(inv: SecurityInvariant, site: CorpusSite, fuzzBudgetSeconds: number): Falsification | null;
}
/** Generate the invariants a genome asserts over a site (defensive assertions). */
export declare function generateInvariants(genome: InvariantGenome, site: CorpusSite): SecurityInvariant[];
export interface InvariantRunResult {
    genome: InvariantGenome;
    falsifications: Falsification[];
    findings: Finding[];
    metrics: {
        truePositives: number;
        falsePositives: number;
        falseNegatives: number;
    };
    /** Per-repo fitness samples (for the paired statistical gate). */
    perRepoFitness: number[];
    breakdown: FitnessBreakdown;
}
/**
 * Run the invariant harness over a corpus: assert invariants, let the fuzzer try
 * to falsify them, turn falsifications into findings. Deterministic.
 */
export declare function runInvariantHarness(genome: InvariantGenome, corpus: Corpus, fuzz: FuzzOracle, baselineFalsePositiveRate?: number): InvariantRunResult;
/** Deterministic cost proxy: more invariant kinds and more fuzz budget cost more. */
export declare function costOfInvariant(genome: InvariantGenome): number;
/** The fixed baseline invariant genome (a single weak assertion class). */
export declare function baselineInvariantGenome(): InvariantGenome;
export declare function mutateInvariant(parent: InvariantGenome, rng: () => number, gen: number, idx: number): InvariantGenome;
export declare function isInvariantGenomeValid(g: InvariantGenome): boolean;
export interface InvariantEvolveResult {
    champion: InvariantRunResult;
    baseline: InvariantRunResult;
    history: number[];
    /** Paired-bootstrap verdict: champion vs baseline invariant genome. */
    promote: boolean;
    lower95: number;
    cyclesRun: number;
}
/** Evolve the invariant genome; promote the champion only if statistically superior. */
export declare function evolveInvariants(corpus: Corpus, fuzz: FuzzOracle, opts?: {
    population?: number;
    cycles?: number;
    seed?: number;
    baselineFalsePositiveRate?: number;
}): InvariantEvolveResult;
/**
 * Promote a fuzzer-falsified invariant into a DURABLE detector candidate (a
 * taint-heuristic artifact), closing the loop: a violated assertion becomes a
 * reusable detector that flows into the self-writing promotion gate + ruVector.
 * The artifact is defensive and carries no exploit (asserted + checked here).
 */
export declare function falsificationToDetector(f: Falsification): GeneratedDetectorCandidate;
//# sourceMappingURL=invariant.d.ts.map