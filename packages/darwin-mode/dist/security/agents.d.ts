import type { Finding, HarnessGenome, RankedSite, RepoProfile } from './types.js';
import type { CorpusRepo, CorpusSite } from './corpus.js';
import { RuvSecurityMemory } from './memory.js';
/** repo-profiler: corpus repo → RepoProfile. */
export declare function profileRepo(repo: CorpusRepo): RepoProfile;
/**
 * Detection power of a harness against a single site (≥ site.detectionThreshold
 * ⇒ a real vuln is found). A sum of bounded, additive capabilities — exactly the
 * levers the genome exposes: tools, context depth, planner alignment, model
 * reasoning, retries, fuzzing, and (compounding) memory.
 */
export declare function detectionPower(genome: HarnessGenome, site: CorpusSite, memory?: RuvSecurityMemory): number;
/**
 * False-positive resistance against a decoy (≥ decoy.fpThreshold ⇒ the decoy is
 * correctly rejected, NOT emitted as a finding). Reviewers + tool agreement +
 * context discrimination + (compounding) negative memory. The negative-memory
 * term is what lets a trickier decoy be resisted only after the system has seen a
 * similar false positive before — the ADR-155 compounding claim.
 */
export declare function fpResistance(genome: HarnessGenome, site: CorpusSite, memory?: RuvSecurityMemory): number;
/**
 * file-ranker: rank a repo's sites using the hybrid formula (ADR-155). Higher
 * rank ⇒ examined first; with a fixed budget this changes WHICH sites get found.
 */
export declare function rankSites(genome: HarnessGenome, repo: CorpusRepo, memory?: RuvSecurityMemory): RankedSite[];
/** The raw output of running the analysis agents over one repo. */
export interface AnalysisOutput {
    /** Real vulnerabilities the harness detected (true positives). */
    truePositives: CorpusSite[];
    /** Decoys the harness mis-reported (false positives). */
    falsePositives: CorpusSite[];
    /** Real vulnerabilities the harness missed (false negatives). */
    falseNegatives: CorpusSite[];
}
/**
 * hypothesis-generator + static-analysis-runner + fuzz-runner + reviewer:
 * apply the capability model to classify every site in a repo. Pure and
 * deterministic given (genome, repo, memory).
 */
export declare function analyzeRepo(genome: HarnessGenome, repo: CorpusRepo, memory?: RuvSecurityMemory): AnalysisOutput;
/** patch-writer: attach a patch + regression test to a confirmed finding. */
export declare function writePatch(site: CorpusSite, repo: CorpusRepo): Finding;
/** disclosure-writer: a defensive advisory (never an exploit). */
export declare function writeAdvisory(finding: Finding): string;
//# sourceMappingURL=agents.d.ts.map