#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Darwin Mode CLI. One verb:
//
//   metaharness-darwin evolve <repo> [--generations N] [--children N]
//                                    [--concurrency N] [--seed N]
//
// Writes a self-describing `.metaharness/` work tree under the repo and prints a
// leaderboard + the winner's lineage. Dependency-free.

import { resolve } from 'node:path';
import { evolve } from './evolve.js';
import type { EvolutionResult } from './types.js';

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

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'evolve') {
    process.stderr.write(
      'usage: metaharness-darwin evolve <repo> [--generations N] [--children N] [--concurrency N] [--seed N]\n',
    );
    process.exit(1);
  }

  const repoRoot = resolve(process.argv[3] ?? process.cwd());
  const workRoot = resolve(repoRoot, '.metaharness');

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
  });

  printReport(result);
  process.stdout.write(`\nArtifacts: ${workRoot}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
