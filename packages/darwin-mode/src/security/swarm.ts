// SPDX-License-Identifier: MIT
//
// Darwin Shield — the RuFlo-coordinated swarm (ADR-155 §swarm execution). One
// `runSwarm` is the whole defensive pipeline for ONE genome over a corpus:
//
//   profile → rank → context → hypotheses → static + fuzz → review →
//   SAFETY GATE → patch → score → archive (receipt + memory).
//
// Every output passes the safety gate (policy.ts) before it is counted, so
// `unsafeOutputs` is the acceptance-critical counter (MUST be 0). The run is
// deterministic: same (genome, corpus, memory, seed) ⇒ byte-identical receipt.

import type { BenchmarkReceipt, Finding, HarnessGenome, RunMetrics } from './types.js';
import type { Corpus } from './corpus.js';
import { findingFromSite, groundTruth, decoys } from './corpus.js';
import { analyzeRepo, profileRepo, writePatch } from './agents.js';
import { gateOutputs } from './policy.js';
import { RuvSecurityMemory } from './memory.js';
import { fnv1a, round6 } from './util.js';

export interface SwarmOptions {
  /** Compounding memory. When supplied, findings are written back (archive-curator). */
  memory?: RuvSecurityMemory;
  /** Persist confirmed findings / false positives into memory after the run. */
  writeBack?: boolean;
  seed?: number;
}

export interface SwarmRunResult {
  genome: HarnessGenome;
  /** The gated, safe findings (confirmed + false positives that leaked). */
  findings: Finding[];
  metrics: RunMetrics;
  receipt: BenchmarkReceipt;
}

/**
 * A deterministic cost proxy: more reviewers, more tools, deeper context, and a
 * bigger fuzz budget all cost more compute. Gives the cost-efficiency fitness
 * term a real gradient without measuring wall-clock (which would be non-repro).
 */
export function costOf(genome: HarnessGenome): number {
  return round6(
    genome.reviewerCount * 1.0 +
      genome.tools.length * 0.5 +
      genome.retryBudget * 0.3 +
      genome.fuzzBudgetSeconds / 60 +
      (genome.contextPolicy === 'hybrid' ? 2 : genome.contextPolicy === 'callgraph' ? 1.5 : genome.contextPolicy === 'semantic' ? 1 : 0.5) +
      genome.modelMix.length * 1.0,
  );
}

/** A deterministic time-to-finding proxy (planner + context drive ordering). */
function timeToFindingOf(genome: HarnessGenome): number {
  const plannerCost = genome.planner === 'risk-first' || genome.planner === 'sink-first' ? 1 : genome.planner === 'memory-first' ? 1.5 : 2;
  const ctxCost = genome.contextPolicy === 'hybrid' ? 0.5 : 1;
  return round6(plannerCost * ctxCost + 0.1 * genome.tools.length);
}

/**
 * Per-repo metrics for one genome — the per-task SAMPLE DISTRIBUTION the
 * statistical promotion gate (stats.ts, ADR-079/155) bootstraps over. Aggregating
 * to a single number throws away the variance a champion-vs-champion comparison
 * needs to be more than one lucky run. Deterministic.
 */
export function runSwarmPerRepo(
  genome: HarnessGenome,
  corpus: Corpus,
  opts: SwarmOptions = {},
): Array<{ repo: string; metrics: RunMetrics }> {
  const memory = opts.memory;
  return corpus.repos.map((repo) => {
    const out = analyzeRepo(genome, repo, memory);
    const tp = out.truePositives.length;
    const patchesProposed = tp;
    const patchesPassing = genome.retryBudget >= 2 ? tp : 0;
    const reproduced =
      genome.validationPipeline.includes('repro-test') || genome.fuzzBudgetSeconds >= 30 ? tp : 0;
    const metrics: RunMetrics = {
      truePositives: tp,
      falsePositives: out.falsePositives.length,
      falseNegatives: out.falseNegatives.length,
      reproduced,
      patchesPassing,
      patchesProposed,
      toolAgreements: genome.tools.length >= 2 ? tp : 0,
      novelFindings: tp,
      unsafeOutputs: 0,
      costUnits: costOf(genome),
      timeToFinding: timeToFindingOf(genome),
    };
    return { repo: repo.repo, metrics };
  });
}

/** Run the full defensive swarm for one genome over the whole corpus. */
export function runSwarm(
  genome: HarnessGenome,
  corpus: Corpus,
  taskId: string,
  opts: SwarmOptions = {},
): SwarmRunResult {
  const memory = opts.memory;
  const rawFindings: Finding[] = [];
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let reproduced = 0;
  let patchesPassing = 0;
  let patchesProposed = 0;
  let toolAgreements = 0;
  let novelFindings = 0;

  for (const repo of corpus.repos) {
    profileRepo(repo); // repo-profiler (drives nothing in the sim but part of the pipeline)
    const out = analyzeRepo(genome, repo, memory);

    truePositives += out.truePositives.length;
    falsePositives += out.falsePositives.length;
    falseNegatives += out.falseNegatives.length;

    for (const site of out.truePositives) {
      const finding = writePatch(site, repo); // patch-writer → patch + regression test
      rawFindings.push(finding);
      patchesProposed += 1;
      // A patch passes its test when the harness has the retry budget to iterate.
      if (genome.retryBudget >= 2) patchesPassing += 1;
      // Reproduced under repro-test/fuzz when the pipeline includes them.
      if (genome.validationPipeline.includes('repro-test') || genome.fuzzBudgetSeconds >= 30) reproduced += 1;
      // ≥2 relevant tools agreeing.
      if (genome.tools.length >= 2) toolAgreements += 1;
      // Novel unless memory has already seen something very similar.
      const candidateText = `${site.weakness} ${site.symbol} ${site.file}`;
      if (!memory || memory.historicalFindingSimilarity(candidateText) < 0.9) novelFindings += 1;
    }
    for (const site of out.falsePositives) {
      // A leaked decoy is reported as needs_review (then rejected by the reviewer
      // narrative); it still counts against the harness as a false positive.
      rawFindings.push(findingFromSite(site, repo.repo, repo.commit, 0.5, 'false_positive'));
    }
  }

  // ── SAFETY GATE: redact unsafe content; count unsafe outputs (must be 0). ──
  const gate = gateOutputs(rawFindings);
  const findings = gate.safe;

  // ── archive-curator: write confirmed/false-positive memory for next run. ──
  if (memory && opts.writeBack) {
    for (const f of findings) {
      if (f.verdict === 'confirmed') memory.writeConfirmed(f);
      else if (f.verdict === 'false_positive') memory.writeFalsePositive(f);
    }
  }

  const metrics: RunMetrics = {
    truePositives,
    falsePositives,
    falseNegatives,
    reproduced,
    patchesPassing,
    patchesProposed,
    toolAgreements,
    novelFindings,
    unsafeOutputs: gate.unsafeOutputs,
    costUnits: costOf(genome),
    timeToFinding: timeToFindingOf(genome),
  };

  const inputHash = hashInputs(genome, corpus, taskId, opts.seed ?? 0);
  const receipt: BenchmarkReceipt = {
    taskId,
    genomeId: genome.id,
    repo: corpus.id,
    commit: corpus.version,
    seed: opts.seed ?? 0,
    findings,
    metrics,
    inputHash,
    createdAt: '1970-01-01T00:00:00.000Z', // fixed for reproducible receipts
  };

  return { genome, findings, metrics, receipt };
}

/** A tamper-evident hash over the run's inputs (for replay/audit). */
export function hashInputs(genome: HarnessGenome, corpus: Corpus, taskId: string, seed: number): string {
  const canonical = JSON.stringify({
    g: {
      planner: genome.planner,
      contextPolicy: genome.contextPolicy,
      reviewerCount: genome.reviewerCount,
      retryBudget: genome.retryBudget,
      fuzzBudgetSeconds: genome.fuzzBudgetSeconds,
      tools: [...genome.tools].sort(),
      modelMix: [...genome.modelMix].sort(),
    },
    c: `${corpus.id}@${corpus.version}`,
    t: taskId,
    s: seed,
  });
  return fnv1a(canonical).toString(16).padStart(8, '0');
}

/** Convenience: ground-truth and decoy counts for a corpus (fitness denominators). */
export function corpusCounts(corpus: Corpus): { groundTruth: number; decoys: number } {
  return { groundTruth: groundTruth(corpus).length, decoys: decoys(corpus).length };
}
