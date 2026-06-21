#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Darwin Mode CLI. Verbs:
//
//   metaharness-darwin evolve <repo> [--generations N] [--children N]
//                                    [--concurrency N] [--seed N]
//                                    [--bench <suite.json>] [--tie faster]
//   metaharness-darwin bench create <repo> [--out <suite.json>]
//   metaharness-darwin bench verify <suite.json>
//
// Writes a self-describing `.metaharness/` work tree under the repo and prints a
// leaderboard + the winner's lineage. Dependency-free.

import { resolve } from 'node:path';
import { evolve } from './evolve.js';
import { RuvllmMutator } from './ruvllm-mutator.js';
import { profileRepo } from './repo_profiler.js';
import { loadSuite, makeSuite, saveSuite, verifySuite } from './bench/suite.js';
import type { BenchmarkTask } from './bench/types.js';
import type { EvolutionResult } from './types.js';
import { runBenchmark, renderReport } from './security/index.js';

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

function num(name: string, fallback: number): number {
  const v = Number(flag(name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}

function printReport(result: EvolutionResult): void {
  const scored = result.records
    .filter((r) => r.score)
    .sort((a, b) => (b.score?.finalScore ?? 0) - (a.score?.finalScore ?? 0));

  process.stdout.write('\nDarwin Mode — leaderboard\n');
  for (const r of scored.slice(0, 10)) {
    const s = r.score!;
    const tag = r.variant.id === result.winner?.variant.id ? ' ◀ winner' : '';
    process.stdout.write(
      `  ${s.finalScore.toFixed(3)}  ${r.variant.id}` +
        `  [${r.variant.mutationSurface}]  safety=${s.safetyScore.toFixed(2)}` +
        `  pass=${s.testPassRate.toFixed(2)}${tag}\n`,
    );
  }

  if (result.winner) {
    process.stdout.write(`\nWinner: ${result.winner.variant.id}\n`);
    process.stdout.write(`Lineage: ${result.winnerLineage.join(' → ')}\n`);
    const base = result.baseline.score?.finalScore ?? 0;
    const win = result.winner.score?.finalScore ?? 0;
    process.stdout.write(
      `Delta over baseline: ${(win - base >= 0 ? '+' : '')}${(win - base).toFixed(3)}\n`,
    );
  } else {
    process.stdout.write('\nNo scored variants.\n');
  }
}

/** `bench create <repo>` / `bench verify <suite.json>` (ADR-076). */
async function runBench(): Promise<void> {
  const sub = process.argv[3];

  if (sub === 'create') {
    const repoRoot = resolve(process.argv[4] ?? process.cwd());
    const profile = await profileRepo(repoRoot);
    const out = resolve(flag('--out', resolve(repoRoot, '.metaharness/bench.json')));
    // A scaffold task pinned to the repo's own test command. Hidden/regression
    // commands are placeholders to be replaced with human-curated held-out tests.
    const task: BenchmarkTask = {
      id: 'task-0001',
      repo: repoRoot,
      commit: 'WORKDIR',
      title: 'Repo native smoke task',
      prompt: 'Keep the repository test suite green.',
      publicTestCommand: profile.testCommand,
      hiddenTestCommand: profile.testCommand,
      regressionTestCommand: profile.testCommand,
      timeoutMs: 300000,
      maxCostUsd: 2,
      allowedMutationFiles: [],
      blockedFiles: ['.env', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.github/workflows'],
      successCriteria: ['public test passes', 'hidden test passes', 'regression suite passes'],
      difficulty: 1,
      tags: ['smoke', 'repo-native'],
    };
    const suite = makeSuite('repo-native', '0.1.0', [task]);
    await saveSuite(out, suite);
    process.stdout.write(`Wrote suite (${suite.tasks.length} task, hash ${suite.taskHash.slice(0, 12)}…): ${out}\n`);
    return;
  }

  if (sub === 'verify') {
    const file = resolve(process.argv[4] ?? '');
    const suite = await loadSuite(file); // throws on tamper
    const check = verifySuite(suite);
    process.stdout.write(`Suite ${suite.id}@${suite.version}: ${suite.tasks.length} tasks, hash ${check.ok ? 'OK' : 'MISMATCH'} (${check.actual.slice(0, 12)}…)\n`);
    return;
  }

  process.stderr.write('usage: metaharness-darwin bench <create|verify> …\n');
  process.exit(1);
}

/** `security bench` (ADR-155, Darwin Shield). Runs DARWIN-SHIELD-BENCH. */
function runSecurity(): void {
  const sub = process.argv[3];
  if (sub !== 'bench') {
    process.stderr.write(
      'usage: metaharness-darwin security bench [--population N] [--cycles N] [--seed N]\n',
    );
    process.exit(1);
  }
  const report = runBenchmark({
    population: num('--population', 16),
    cycles: num('--cycles', 50),
    seed: num('--seed', 0),
  });
  process.stdout.write(renderReport(report));
  process.stdout.write(`\nOverall: ${report.passed ? 'PASS' : 'FAIL'}\n`);
  if (!report.passed) process.exit(1);
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === 'security') {
    runSecurity();
    return;
  }

  if (command === 'bench') {
    await runBench();
    return;
  }

  if (command !== 'evolve') {
    process.stderr.write(
      'usage: metaharness-darwin <evolve|bench|security> …\n' +
        '  evolve <repo> [--generations N] [--children N] [--concurrency N] [--seed N] [--bench <suite.json>] [--tie faster] [--selection quality-diversity|behavioral-diversity|niche-steering|clade|pareto] [--crossover] [--epistasis] [--risk-budget N] [--fdr Q] [--curriculum] [--sandbox real|mock|agent] [--mutator deterministic|ruvllm] [--ruvllm-url URL] [--ruvllm-model M]\n' +
        '  bench create <repo> [--out <suite.json>]\n' +
        '  bench verify <suite.json>\n' +
        '  security bench [--population N] [--cycles N] [--seed N]   (ADR-155 Darwin Shield)\n',
    );
    process.exit(1);
  }

  const repoRoot = resolve(process.argv[3] ?? process.cwd());
  const workRoot = resolve(repoRoot, '.metaharness');

  // Opt-in graded promotion (ADR-076/087): --bench <suite.json> loads a
  // hash-verified suite (throws on tamper) and routes promotion through the
  // statistical gate. --tie faster opts into efficiency tie-breaking (ADR-086).
  const benchPath = flag('--bench', '');
  const benchSuite = benchPath ? await loadSuite(resolve(benchPath)) : undefined;
  const tieBreaker = flag('--tie', 'insertion') === 'faster' ? 'faster' : 'insertion';
  const selRaw = flag('--selection', 'score');
  const selection =
    selRaw === 'quality-diversity' ||
    selRaw === 'behavioral-diversity' ||
    selRaw === 'niche-steering' ||
    selRaw === 'clade' ||
    selRaw === 'pareto'
      ? selRaw
      : 'score';
  const crossover = process.argv.includes('--crossover');
  const epistasis = process.argv.includes('--epistasis');
  const riskArg = flag('--risk-budget', '');
  const riskBudgetTotal = riskArg === '' ? undefined : num('--risk-budget', 0);
  const fdrArg = flag('--fdr', '');
  const fdrQ = fdrArg === '' ? undefined : num('--fdr', 0.05);
  const curriculum = process.argv.includes('--curriculum');
  const sbRaw = flag('--sandbox', 'real');
  const sandboxMode = sbRaw === 'mock' || sbRaw === 'agent' ? sbRaw : 'real';

  // ADR-259: pluggable mutator backend. Default = deterministic (no network, no key).
  // --mutator ruvllm routes mutations to a local `ruvllm serve` endpoint (fully local,
  // air-gapped, zero API cost). The OpenRouter LLM mutator stays library-only.
  const mutatorRaw = flag('--mutator', 'deterministic');
  const generator =
    mutatorRaw === 'ruvllm'
      ? new RuvllmMutator({ baseUrl: flag('--ruvllm-url', '') || undefined, model: flag('--ruvllm-model', '') || undefined })
      : undefined;

  const result = await evolve({
    repoRoot,
    workRoot,
    generations: num('--generations', 3),
    childrenPerGeneration: num('--children', 4),
    concurrency: num('--concurrency', 4),
    seed: num('--seed', 0),
    promotionDelta: 0.05,
    tasks: [
      'run repository test suite',
      'verify generated harness safety',
      'check trace quality',
    ],
    ...(benchSuite ? { benchSuite } : {}),
    ...(riskBudgetTotal !== undefined ? { riskBudgetTotal } : {}),
    ...(fdrQ !== undefined ? { fdrQ } : {}),
    ...(curriculum ? { curriculum } : {}),
    ...(sandboxMode !== 'real' ? { sandboxMode } : {}),
    ...(generator ? { generator } : {}),
    tieBreaker,
    selection,
    crossover,
    epistasis,
  });

  printReport(result);
  process.stdout.write(`\nArtifacts: ${workRoot}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
