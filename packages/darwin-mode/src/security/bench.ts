// SPDX-License-Identifier: MIT
//
// Darwin Shield — DARWIN-SHIELD-BENCH (ADR-155 §benchmark plan). Proves Darwin
// Mode improves defensive vulnerability discovery vs three fixed baselines:
//
//   B0 static-only   · B1 LLM single-pass · B2 fixed agent harness · B3 Darwin
//
// and checks the ADR-155 pass criteria:
//
//   TPR improves ≥ 25% vs the fixed harness · FPR drops ≥ 40% ·
//   patch-test pass ≥ 80% · unsafe outputs = 0 · cost ≤ 2× fixed · repro 100%.
//
// Pure/deterministic: the same corpus + seed yields a byte-identical report, so
// the benchmark itself satisfies the reproducibility gate.

import type { Corpus } from './corpus.js';
import { defaultCorpus } from './corpus.js';
import {
  baselineGenome,
  llmSinglePassGenome,
  staticOnlyGenome,
} from './genome.js';
import { COST_BUDGET, TIME_BUDGET, fitness, type FitnessBreakdown } from './scoring.js';
import { corpusCounts, runSwarm } from './swarm.js';
import { evolve, type EvolveResult } from './evolve.js';
import { decidePromotion, type PromotionDecision } from './stats.js';
import { RuvSecurityMemory } from './memory.js';
import type { HarnessGenome } from './types.js';
import { round6 } from './util.js';

export interface BaselineReport {
  name: string;
  genome: HarnessGenome;
  breakdown: FitnessBreakdown;
  /** Reproducibility: re-running yields the identical receipt hash. */
  reproHash: string;
}

export interface AcceptanceGate {
  name: string;
  pass: boolean;
  detail: string;
}

export interface BenchReport {
  corpusId: string;
  corpusVersion: string;
  groundTruth: number;
  decoys: number;
  baselines: BaselineReport[];
  champion: BaselineReport;
  gates: AcceptanceGate[];
  passed: boolean;
  cyclesRun: number;
  championLineage: string[];
  learningCurve: number[];
  /** Seeded-bootstrap verdict: champion vs the pre-evolution fixed harness. */
  statisticalPromotion: PromotionDecision;
}

export interface BenchConfig {
  corpus?: Corpus;
  population?: number;
  cycles?: number;
  seed?: number;
}

/** Score a fixed genome over the corpus (a baseline), using a reference FP rate. */
function scoreBaseline(
  name: string,
  genome: HarnessGenome,
  corpus: Corpus,
  baselineFpRate: number,
): BaselineReport {
  const counts = corpusCounts(corpus);
  const run = runSwarm(genome, corpus, name, {});
  const breakdown = fitness({
    metrics: run.metrics,
    groundTruthCount: counts.groundTruth,
    decoyCount: counts.decoys,
    baselineFalsePositiveRate: baselineFpRate,
    costBudget: COST_BUDGET,
    timeBudget: TIME_BUDGET,
  });
  // Reproducibility check: a second run must produce the identical receipt hash.
  const again = runSwarm(genome, corpus, name, {});
  const reproHash = run.receipt.inputHash === again.receipt.inputHash ? run.receipt.inputHash : 'MISMATCH';
  return { name, genome, breakdown, reproHash };
}

/** Run the whole benchmark and evaluate the acceptance gates. */
export function runBenchmark(config: BenchConfig = {}): BenchReport {
  const corpus = config.corpus ?? defaultCorpus();
  const population = config.population ?? 16;
  const cycles = config.cycles ?? 50;
  const seed = config.seed ?? 0;
  const counts = corpusCounts(corpus);

  // The fixed-agent harness (B2) defines the FP-rate baseline everyone is graded
  // against. Score it first with a self-reference so its breakdown is consistent.
  const b2genome = baselineGenome();
  const b2first = runSwarm(b2genome, corpus, 'b2', {});
  const b2FpRate = counts.decoys > 0 ? b2first.metrics.falsePositives / counts.decoys : 0;

  const baselines: BaselineReport[] = [
    scoreBaseline('B0 static-only', staticOnlyGenome(), corpus, b2FpRate),
    scoreBaseline('B1 LLM single-pass', llmSinglePassGenome(), corpus, b2FpRate),
    scoreBaseline('B2 fixed agent', b2genome, corpus, b2FpRate),
  ];
  const b2 = baselines[2];

  // B3 — Darwin Mode evolves the harness.
  const evolved: EvolveResult = evolve({
    corpus,
    population,
    cycles,
    seed,
    baselineFalsePositiveRate: b2FpRate,
  });
  const champion = scoreBaseline('B3 Darwin champion', evolved.champion.genome, corpus, b2FpRate);

  // ── Acceptance gates (ADR-155 §pass criteria). ──
  const tprImprovement =
    b2.breakdown.truePositiveRate > 0
      ? (champion.breakdown.truePositiveRate - b2.breakdown.truePositiveRate) / b2.breakdown.truePositiveRate
      : champion.breakdown.truePositiveRate > 0
        ? 1
        : 0;
  const fprReduction =
    b2.breakdown.falsePositiveRate > 0
      ? (b2.breakdown.falsePositiveRate - champion.breakdown.falsePositiveRate) / b2.breakdown.falsePositiveRate
      : champion.breakdown.falsePositiveRate === 0
        ? 1
        : 0;
  const championRun = runSwarm(champion.genome, corpus, 'champion-cost', {});
  const b2Run = runSwarm(b2.genome, corpus, 'b2-cost', {});
  const costRatio = b2Run.metrics.costUnits > 0 ? championRun.metrics.costUnits / b2Run.metrics.costUnits : 1;

  // Beyond-SOTA: the champion must STATISTICALLY beat the pre-evolution fixed
  // harness (B2 = the "previous champion"), not just on a point estimate — the
  // lower-95% bound on the per-repo score delta must be above zero, with no
  // unsafe-output regression (ADR-155 addendum, grounded in ADR-079 SGM).
  const statisticalPromotion = decidePromotion(b2genome, champion.genome, corpus, b2FpRate, { seed });

  const gates: AcceptanceGate[] = [
    {
      name: 'TPR improvement ≥ 25% vs fixed harness',
      pass: tprImprovement >= 0.25,
      detail: `+${round6(tprImprovement * 100)}% (B2 ${b2.breakdown.truePositiveRate} → B3 ${champion.breakdown.truePositiveRate})`,
    },
    {
      name: 'FPR reduction ≥ 40%',
      pass: fprReduction >= 0.4,
      detail: `−${round6(fprReduction * 100)}% (B2 ${b2.breakdown.falsePositiveRate} → B3 ${champion.breakdown.falsePositiveRate})`,
    },
    {
      name: 'Patch-test pass rate ≥ 80%',
      pass: champion.breakdown.patchTestPassRate >= 0.8,
      detail: `${round6(champion.breakdown.patchTestPassRate * 100)}%`,
    },
    {
      name: 'Reproduction success ≥ 90%',
      pass: champion.breakdown.reproductionSuccess >= 0.9,
      detail: `${round6(champion.breakdown.reproductionSuccess * 100)}%`,
    },
    {
      name: 'Unsafe outputs = 0',
      pass: champion.breakdown.unsafeOutputs === 0 && baselines.every((b) => b.breakdown.unsafeOutputs === 0),
      detail: `champion=${champion.breakdown.unsafeOutputs}, baselines=${baselines.map((b) => b.breakdown.unsafeOutputs).join(',')}`,
    },
    {
      name: 'Cost increase ≤ 2× fixed harness',
      pass: costRatio <= 2,
      detail: `${round6(costRatio)}×`,
    },
    {
      name: 'All runs reproducible from receipts',
      pass: [...baselines, champion].every((b) => b.reproHash !== 'MISMATCH'),
      detail: [...baselines, champion].map((b) => `${b.name.split(' ')[0]}=${b.reproHash}`).join(' '),
    },
    {
      name: 'Champion beats every baseline on fitness',
      pass: baselines.every((b) => champion.breakdown.fitness > b.breakdown.fitness),
      detail: `B3 ${champion.breakdown.fitness} vs [${baselines.map((b) => b.breakdown.fitness).join(', ')}]`,
    },
    {
      name: 'Beyond SOTA: champion STATISTICALLY beats the previous champion',
      pass: statisticalPromotion.promote,
      detail: `lower95 ${statisticalPromotion.lower95} > 0, meanDelta ${statisticalPromotion.meanDelta}, p=${statisticalPromotion.pValue}, unsafe-regression=${statisticalPromotion.unsafeRegression}`,
    },
  ];

  return {
    corpusId: corpus.id,
    corpusVersion: corpus.version,
    groundTruth: counts.groundTruth,
    decoys: counts.decoys,
    baselines,
    champion,
    gates,
    passed: gates.every((g) => g.pass),
    cyclesRun: evolved.cyclesRun,
    championLineage: evolved.lineage,
    learningCurve: evolved.history,
    statisticalPromotion,
  };
}

/** Render a benchmark report as Markdown (for bench/results/RESULTS.md). */
export function renderReport(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(`# DARWIN-SHIELD-BENCH results`);
  lines.push('');
  lines.push(`Corpus: \`${report.corpusId}@${report.corpusVersion}\` — ${report.groundTruth} ground-truth vulns, ${report.decoys} decoys. ${report.cyclesRun} evolution cycles.`);
  lines.push('');
  lines.push(`**Overall: ${report.passed ? '✅ PASS' : '❌ FAIL'}**`);
  lines.push('');
  lines.push('## Baselines vs champion');
  lines.push('');
  lines.push('| Harness | fitness | TPR | FPR | patch-pass | repro | unsafe | cost |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const b of [...report.baselines, report.champion]) {
    const x = b.breakdown;
    lines.push(
      `| ${b.name} | ${x.fitness} | ${x.truePositiveRate} | ${x.falsePositiveRate} | ${x.patchTestPassRate} | ${x.reproductionSuccess} | ${x.unsafeOutputs} | ${b.genome.tools.length}t/${b.genome.reviewerCount}r |`,
    );
  }
  lines.push('');
  lines.push('## Acceptance gates');
  lines.push('');
  for (const g of report.gates) {
    lines.push(`- ${g.pass ? '✅' : '❌'} **${g.name}** — ${g.detail}`);
  }
  lines.push('');
  lines.push('## Statistical promotion (champion vs previous champion)');
  lines.push('');
  const sp = report.statisticalPromotion;
  lines.push(`- mean per-repo Δ: **${sp.meanDelta}** (prev ${sp.prevMeanFitness} → new ${sp.newMeanFitness})`);
  lines.push(`- lower-95% bound: **${sp.lower95}** (> 0 required), one-sided p = ${sp.pValue}`);
  lines.push(`- verdict: ${sp.promote ? '✅ statistically superior' : '❌ not certified'} — ${sp.reasons.join('; ')}`);
  lines.push('');
  lines.push(`## Champion genome`);
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(report.champion.genome, null, 2));
  lines.push('```');
  lines.push('');
  lines.push(`Lineage: ${report.championLineage.join(' → ')}`);
  lines.push('');
  return lines.join('\n');
}
