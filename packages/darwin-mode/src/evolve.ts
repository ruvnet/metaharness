// SPDX-License-Identifier: MIT
//
// The evolution loop (ADR-070). Ties the pieces together:
//
//   profile → baseline → (mutate → sandbox → score → archive)* → promote/select
//
// Population variants are evaluated with BOUNDED concurrency (no unbounded fan-out),
// under an optional per-generation cost-proxy budget (the circuit breaker of
// ADR-072). Selection samples from the WHOLE archive on a stalled generation
// (ADR-073) rather than dead-ending — a weak ancestor can still seed a branch.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Archive } from './archive.js';
import { generateBaselineHarness } from './generator.js';
import { createChildVariant, DeterministicMutator } from './mutator.js';
import { profileRepo } from './repo_profiler.js';
import { runVariantTasks } from './sandbox.js';
import { scoreVariant } from './scorer.js';
import type {
  EvolutionConfig,
  EvolutionResult,
  HarnessVariant,
  RepoProfile,
  RunTrace,
  ScoreCard,
} from './types.js';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TASK_TIMEOUT_MS = 120_000;

/** Run async `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function ensureWorkRoot(workRoot: string): Promise<void> {
  await mkdir(join(workRoot, 'variants'), { recursive: true });
  await mkdir(join(workRoot, 'runs'), { recursive: true });
  await mkdir(join(workRoot, 'reports'), { recursive: true });
}

interface Evaluation {
  variant: HarnessVariant;
  traces: RunTrace[];
  score: ScoreCard;
}

/** Run + score one variant. Pure of archive mutation (caller commits results). */
async function evaluateVariant(
  variant: HarnessVariant,
  profile: RepoProfile,
  cfg: EvolutionConfig,
  parentScore: ScoreCard | null,
): Promise<Evaluation> {
  const timeout = cfg.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const traces = await runVariantTasks(variant, profile, cfg.tasks, {
    taskTimeoutMs: timeout,
  });
  const score = scoreVariant(
    variant.id,
    traces,
    parentScore,
    cfg.promotionDelta,
    timeout,
  );
  return { variant, traces, score };
}

/** Cost proxy for the breaker: cumulative variant-seconds in a generation. */
function traceSeconds(traces: RunTrace[]): number {
  return traces.reduce((s, t) => s + t.durationMs, 0) / 1000;
}

async function commit(
  archive: Archive,
  workRoot: string,
  evalResult: Evaluation,
): Promise<void> {
  await writeFile(
    join(workRoot, 'runs', `${evalResult.variant.id}.json`),
    JSON.stringify({ traces: evalResult.traces, score: evalResult.score }, null, 2),
    'utf8',
  );
  archive.setScore(evalResult.variant.id, evalResult.score);
}

/**
 * Run a full Darwin Mode evolution. Returns the baseline, the winning record,
 * the whole archive, and the winner's lineage. Side effects are confined to the
 * `<workRoot>/.metaharness`-style tree (variants, runs, reports, archive.json,
 * lineage.json).
 */
export async function evolve(config: EvolutionConfig): Promise<EvolutionResult> {
  await ensureWorkRoot(config.workRoot);
  const profile = await profileRepo(config.repoRoot);
  const archive = new Archive(join(config.workRoot, 'archive.json'));
  await archive.load();

  const seed = config.seed ?? 0;
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  const mutator = new DeterministicMutator(seed);

  // --- baseline ---
  const baseline = await generateBaselineHarness(profile, config.workRoot);
  archive.addVariant(baseline);
  const baselineEval = await evaluateVariant(baseline, profile, config, null);
  await commit(archive, config.workRoot, baselineEval);
  await archive.save();

  const scoreById = new Map<string, ScoreCard>([[baseline.id, baselineEval.score]]);
  let parents: HarnessVariant[] = [baseline];

  // --- generations ---
  for (let generation = 1; generation <= config.generations; generation++) {
    // Build this generation's children from the current parents.
    const children: Array<{ child: HarnessVariant; parent: HarnessVariant }> = [];
    for (const parent of parents) {
      for (let index = 0; index < config.childrenPerGeneration; index++) {
        const child = await createChildVariant(
          parent,
          config.workRoot,
          generation,
          index,
          mutator,
          seed,
        );
        archive.addVariant(child);
        children.push({ child, parent });
      }
    }

    // Evaluate with bounded concurrency.
    const evals = await mapLimit(children, concurrency, ({ child, parent }) =>
      evaluateVariant(child, profile, config, scoreById.get(parent.id) ?? null),
    );

    // Commit sequentially (single-writer to the archive + one save), honouring
    // the per-generation cost breaker.
    let spent = 0;
    const promoted: HarnessVariant[] = [];
    for (const ev of evals) {
      await commit(archive, config.workRoot, ev);
      scoreById.set(ev.variant.id, ev.score);
      if (ev.score.promoted) promoted.push(ev.variant);
      spent += traceSeconds(ev.traces);
      if (config.costBudgetSeconds && spent >= config.costBudgetSeconds) break;
    }
    await archive.save();

    // Selection (ADR-073): prefer promoted children; on a stalled generation
    // sample the whole archive so we explore sideways instead of dead-ending.
    parents = promoted.length > 0 ? promoted : archive.selectParents(2);
    if (parents.length === 0) break;
  }

  const winner = archive.best();
  const winnerLineage = winner ? archive.lineageOf(winner.variant.id) : [];

  await writeFile(
    join(config.workRoot, 'reports', 'winner.json'),
    JSON.stringify(winner, null, 2),
    'utf8',
  );
  await writeFile(
    join(config.workRoot, 'lineage.json'),
    JSON.stringify(archive.toLineageGraph(), null, 2),
    'utf8',
  );

  const baselineRecord = archive.get(baseline.id);
  return {
    baseline: baselineRecord ?? { variant: baseline, score: baselineEval.score, children: [] },
    winner,
    records: archive.all(),
    generations: config.generations,
    winnerLineage,
  };
}
