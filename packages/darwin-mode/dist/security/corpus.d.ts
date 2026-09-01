import type { Finding, Language } from './types.js';
/** A ground-truth weakness OR a decoy in a corpus repo. */
export interface CorpusSite {
    siteId: string;
    file: string;
    symbol: string;
    language: Language;
    /** The weakness class (CWE-style label). */
    weakness: string;
    /** true ⇒ a real vulnerability; false ⇒ a decoy (clean code that looks risky). */
    isVulnerable: boolean;
    taintRole: 'source' | 'sink' | 'sanitizer' | 'unknown';
    callgraphDegree: number;
    /** 0..1 — closeness to a dangerous sink. */
    sinkProximity: number;
    /** 0..1 — how recently the code changed (churn). */
    recentChange: number;
    /** 0..1 — cyclomatic-ish complexity. */
    complexity: number;
    /** 0..1 — harness power needed to detect a real vuln (higher = subtler). */
    detectionThreshold: number;
    /** 0..1 — harness resistance needed to NOT mis-flag a decoy (higher = trickier). */
    fpThreshold: number;
    /** The accepted fix (text only; never an exploit). Present for real vulns. */
    acceptedPatch?: string;
    riskTags: string[];
    /**
     * Multi-step DISCOVERY depth (ADR-155 Addendum C): how many navigation steps
     * (reading related sites / following call edges) are needed before the
     * weakness is even visible. 1 (default) = single-shot visible; > 1 = only an
     * agentic loop that pays the navigation cost can surface it. This is the
     * "discovery wall" a single-shot harness structurally cannot cross.
     */
    discoveryDepth?: number;
}
export interface CorpusRepo {
    repo: string;
    commit: string;
    kind: 'seeded' | 'real-cve' | 'clean';
    languages: Language[];
    frameworks: string[];
    sites: CorpusSite[];
}
export interface Corpus {
    id: string;
    version: string;
    repos: CorpusRepo[];
}
/** Convenience: every real (ground-truth) vulnerable site across the corpus. */
export declare function groundTruth(corpus: Corpus): CorpusSite[];
/** Convenience: every decoy (a finding on one of these is a false positive). */
export declare function decoys(corpus: Corpus): CorpusSite[];
/**
 * The default benchmark corpus. Mixed languages, mixed difficulty, with a
 * realistic decoy load so false-positive control matters. Difficulty is spread
 * so that a weak harness finds the easy bugs and mis-flags the trickier decoys,
 * while an evolved harness crosses the harder thresholds and resists the decoys —
 * producing the ADR-155 acceptance deltas.
 */
export declare function defaultCorpus(): Corpus;
/** Build a clean, gated `Finding` from a corpus site (never carries exploit code). */
export declare function findingFromSite(site: CorpusSite, repo: string, commit: string, confidence: number, verdict: Finding['verdict']): Finding;
//# sourceMappingURL=corpus.d.ts.map