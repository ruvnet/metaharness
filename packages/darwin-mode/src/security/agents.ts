// SPDX-License-Identifier: MIT
//
// Darwin Shield — the swarm agents and the capability model (ADR-155 §agent
// topology). The agents are deterministic functions over a corpus repo; the
// capability model is what turns a HarnessGenome into measurable detection power
// and false-positive resistance, so a better harness genuinely finds more real
// weaknesses and mis-reports fewer decoys. THAT is the gradient Darwin climbs.
//
// Agents: repo-profiler · file-ranker · hypothesis-generator ·
// static-analysis-runner · fuzz-runner · patch-writer · reviewer (adversarial) ·
// safety-redactor (policy.ts) · disclosure-writer · archive-curator (memory.ts).

import type {
  Finding,
  HarnessGenome,
  Language,
  RankedSite,
  RepoProfile,
  SecurityTool,
} from './types.js';
import type { CorpusRepo, CorpusSite } from './corpus.js';
import { findingFromSite } from './corpus.js';
import { RuvSecurityMemory, centrality, hybridRank } from './memory.js';
import { clamp, round6 } from './util.js';

/** Tools that apply to a given language (tool choice should match the repo). */
const LANG_TOOLS: Record<Language, ReadonlySet<SecurityTool>> = {
  rust: new Set(['semgrep', 'codeql', 'osv-scanner', 'trivy', 'cargo-audit', 'cargo-fuzz']),
  ts: new Set(['semgrep', 'codeql', 'osv-scanner', 'trivy', 'npm-audit']),
  py: new Set(['semgrep', 'codeql', 'osv-scanner', 'trivy']),
  go: new Set(['semgrep', 'codeql', 'osv-scanner', 'trivy']),
};

/** repo-profiler: corpus repo → RepoProfile. */
export function profileRepo(repo: CorpusRepo): RepoProfile {
  return {
    repo: repo.repo,
    commit: repo.commit,
    languages: repo.languages,
    frameworks: repo.frameworks,
    unitCount: repo.sites.length,
    attackSurface: repo.sites
      .filter((s) => s.taintRole === 'sink')
      .map((s) => `${s.file}:${s.symbol}`),
    summary: `${repo.kind} repo, ${repo.languages.join('/')} (${repo.sites.length} units)`,
  };
}

/** How many of a genome's enabled tools are relevant to a language. */
function relevantToolCount(genome: HarnessGenome, lang: Language): number {
  const set = LANG_TOOLS[lang];
  return genome.tools.filter((t) => set.has(t)).length;
}

const CONTEXT_BONUS: Record<HarnessGenome['contextPolicy'], number> = {
  minimal: 0,
  semantic: 0.08,
  callgraph: 0.14,
  hybrid: 0.2,
};

/** Whether the planner's exploration order is aligned with a site's shape. */
function plannerAligned(genome: HarnessGenome, site: CorpusSite, hasMemoryHit: boolean): boolean {
  switch (genome.planner) {
    case 'sink-first':
    case 'risk-first':
      return site.taintRole === 'sink';
    case 'callgraph-first':
      return site.callgraphDegree >= 8;
    case 'diff-first':
      return site.recentChange >= 0.6;
    case 'memory-first':
      return hasMemoryHit;
    case 'file-first':
    default:
      return false;
  }
}

/**
 * Detection power of a harness against a single site (≥ site.detectionThreshold
 * ⇒ a real vuln is found). A sum of bounded, additive capabilities — exactly the
 * levers the genome exposes: tools, context depth, planner alignment, model
 * reasoning, retries, fuzzing, and (compounding) memory.
 */
export function detectionPower(
  genome: HarnessGenome,
  site: CorpusSite,
  memory?: RuvSecurityMemory,
): number {
  const toolScore = clamp(relevantToolCount(genome, site.language) * 0.1, 0, 0.5);
  const contextBonus = CONTEXT_BONUS[genome.contextPolicy];

  const candidateText = `${site.weakness} ${site.symbol} ${site.file} ${site.riskTags.join(' ')}`;
  const historical = memory ? memory.historicalFindingSimilarity(candidateText) : 0;
  const memoryEnabled = genome.contextPolicy === 'hybrid' || genome.planner === 'memory-first';
  const memoryBonus = memoryEnabled ? 0.15 * historical : 0;

  const plannerBonus = plannerAligned(genome, site, memoryEnabled && historical > 0.5) ? 0.12 : 0.04;
  const modelBonus = genome.modelMix.length > 0 ? 0.1 : 0;
  const retryBonus = (genome.retryBudget - 1) * 0.02;
  // Fuzzing mainly helps memory-safety / parsing bugs; modest, budget-scaled.
  const fuzzBonus = (genome.fuzzBudgetSeconds / 600) * 0.08;

  return round6(toolScore + contextBonus + memoryBonus + plannerBonus + modelBonus + retryBonus + fuzzBonus);
}

/** Reviewer falsification resistance: diminishing returns in reviewer count. */
function reviewerResistance(reviewerCount: number): number {
  return 0.25 + (clamp(reviewerCount, 1, 5) - 1) * 0.0875; // r1=0.25 … r5=0.60
}

/**
 * False-positive resistance against a decoy (≥ decoy.fpThreshold ⇒ the decoy is
 * correctly rejected, NOT emitted as a finding). Reviewers + tool agreement +
 * context discrimination + (compounding) negative memory. The negative-memory
 * term is what lets a trickier decoy be resisted only after the system has seen a
 * similar false positive before — the ADR-155 compounding claim.
 */
export function fpResistance(
  genome: HarnessGenome,
  site: CorpusSite,
  memory?: RuvSecurityMemory,
): number {
  const reviewers = reviewerResistance(genome.reviewerCount);
  const toolAgreement = clamp(relevantToolCount(genome, site.language) * 0.0375, 0, 0.15);
  const contextResistance =
    genome.contextPolicy === 'hybrid' ? 0.15 : genome.contextPolicy === 'callgraph' ? 0.1 : genome.contextPolicy === 'semantic' ? 0.08 : 0;

  const candidateText = `${site.weakness} ${site.symbol} ${site.file} ${site.riskTags.join(' ')}`;
  const memoryEnabled = genome.contextPolicy === 'hybrid' || genome.planner === 'memory-first';
  const fpSim = memory ? memory.falsePositiveSimilarity(candidateText) : 0;
  const negativeMemory = memoryEnabled ? 0.3 * fpSim : 0;

  return round6(reviewers + toolAgreement + contextResistance + negativeMemory);
}

/**
 * file-ranker: rank a repo's sites using the hybrid formula (ADR-155). Higher
 * rank ⇒ examined first; with a fixed budget this changes WHICH sites get found.
 */
export function rankSites(
  genome: HarnessGenome,
  repo: CorpusRepo,
  memory?: RuvSecurityMemory,
): RankedSite[] {
  return repo.sites
    .map((s) => {
      const candidateText = `${s.weakness} ${s.symbol} ${s.file} ${s.riskTags.join(' ')}`;
      const vectorSimilarity = memory ? memory.historicalFindingSimilarity(candidateText) : 0;
      const fpSim = memory ? memory.falsePositiveSimilarity(candidateText) : 0;
      const rank = hybridRank({
        vectorSimilarity,
        callgraphCentrality: centrality(s.callgraphDegree),
        taintSinkProximity: s.sinkProximity,
        historicalFindingSimilarity: vectorSimilarity,
        recentChangeWeight: s.recentChange,
        falsePositiveSimilarity: fpSim,
      });
      return { siteId: s.siteId, file: s.file, symbol: s.symbol, rank };
    })
    .sort((a, b) => b.rank - a.rank);
}

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
export function analyzeRepo(
  genome: HarnessGenome,
  repo: CorpusRepo,
  memory?: RuvSecurityMemory,
): AnalysisOutput {
  const truePositives: CorpusSite[] = [];
  const falsePositives: CorpusSite[] = [];
  const falseNegatives: CorpusSite[] = [];

  for (const site of repo.sites) {
    if (site.isVulnerable) {
      if (detectionPower(genome, site, memory) >= site.detectionThreshold) {
        truePositives.push(site);
      } else {
        falseNegatives.push(site);
      }
    } else {
      // A decoy leaks as a false positive only when resistance is insufficient.
      if (fpResistance(genome, site, memory) < site.fpThreshold) {
        falsePositives.push(site);
      }
    }
  }
  return { truePositives, falsePositives, falseNegatives };
}

/** patch-writer: attach a patch + regression test to a confirmed finding. */
export function writePatch(site: CorpusSite, repo: CorpusRepo): Finding {
  return findingFromSite(site, repo.repo, repo.commit, 0.9, 'confirmed');
}

/** disclosure-writer: a defensive advisory (never an exploit). */
export function writeAdvisory(finding: Finding): string {
  return [
    `# Advisory: ${finding.weakness}`,
    ``,
    `**Location:** ${finding.file}${finding.symbol ? `:${finding.symbol}` : ''}`,
    `**Confidence:** ${finding.confidence}`,
    ``,
    `## Remediation`,
    finding.patch ?? 'Apply input validation and add a regression test.',
    ``,
    `_This advisory is strictly defensive and contains no exploit code._`,
  ].join('\n');
}
