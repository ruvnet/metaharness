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
import {
  createChildVariant,
  createCrossoverVariant,
  DeterministicMutator,
  summarizeFailedTraces,
} from './mutator.js';
import { profileRepo } from './repo_profiler.js';
import { runVariantTasks } from './sandbox.js';
import { scoreVariant } from './scorer.js';
import { evaluateChildAgainstParent } from './bench/runner.js';
import type { PromotionDecision } from './bench/types.js';
import type {
  ArchiveRecord,
  EvolutionConfig,
  EvolutionResult,
  HarnessVariant,
  RepoProfile,
  RunTrace,
  ScoreCard,
} from './types.js';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TASK_TIMEOUT_MS = 120_000;

/** Run async `fn` over `items` with at most `limit` in flight at once. Order-preserving. */
export async function mapLimit<T, R>(
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

/** Mean wall-clock per trace; `Infinity` when a variant has no traces (sinks last). */
function meanDurationMs(traces: RunTrace[]): number {
  if (traces.length === 0) return Infinity;
  return traces.reduce((s, t) => s + t.durationMs, 0) / traces.length;
}

/**
 * Among scored records sharing the TOP finalScore, return the most efficient
 * (lowest mean trace wall-clock). Pure: caller supplies the per-variant traces.
 * Returns `null` only when no record is scored. This is the 'faster' tie-break
 * (ADR-072 scorer is ceiling-bound, so the efficiency signal lives here, not in
 * finalScore). NOT reproducible by construction — opt-in via config.tieBreaker.
 */
export function pickEfficientWinner(
  records: ArchiveRecord[],
  tracesById: Map<string, RunTrace[]>,
): ArchiveRecord | null {
  let top = -Infinity;
  for (const r of records) {
    if (r.score && r.score.finalScore > top) top = r.score.finalScore;
  }
  if (top === -Infinity) return null;
  const EPS = 1e-9;
  let winner: ArchiveRecord | null = null;
  let bestMs = Infinity;
  for (const r of records) {
    if (!r.score || Math.abs(r.score.finalScore - top) > EPS) continue;
    const ms = meanDurationMs(tracesById.get(r.variant.id) ?? []);
    if (winner === null || ms < bestMs) {
      winner = r;
      bestMs = ms;
    }
  }
  return winner;
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
  // ADR-071: pluggable generator. Default deterministic; config.generator can
  // be an LLM-backed CodeGenerator (e.g. OpenRouterMutator) — same safety gate.
  const mutator = config.generator ?? new DeterministicMutator(seed);

  // --- baseline ---
  const baseline = await generateBaselineHarness(profile, config.workRoot);
  archive.addVariant(baseline);
  const baselineEval = await evaluateVariant(baseline, profile, config, null);
  await commit(archive, config.workRoot, baselineEval);
  await archive.save();

  const scoreById = new Map<string, ScoreCard>([[baseline.id, baselineEval.score]]);
  // Parent traces are carried forward so a child's mutation can target the
  // parent's ACTUAL failures (ADR-071 self-reflection); empty until a run fails.
  const tracesById = new Map<string, RunTrace[]>([[baseline.id, baselineEval.traces]]);
  let parents: HarnessVariant[] = [baseline];

  // --- generations ---
  for (let generation = 1; generation <= config.generations; generation++) {
    // Build this generation's children from the current parents.
    const children: Array<{ child: HarnessVariant; parent: HarnessVariant }> = [];
    const canCross = config.crossover === true && parents.length >= 2;
    for (let pIdx = 0; pIdx < parents.length; pIdx++) {
      const parent = parents[pIdx];
      for (let index = 0; index < config.childrenPerGeneration; index++) {
        // Opt-in crossover (ADR-089): the first child of each parent recombines
        // with the next parent's surfaces; the rest are ordinary mutations.
        const child =
          canCross && index === 0
            ? await createCrossoverVariant(
                parent,
                parents[(pIdx + 1) % parents.length],
                config.workRoot,
                generation,
                index,
                seed,
              )
            : await createChildVariant(
                parent,
                config.workRoot,
                generation,
                index,
                mutator,
                seed,
                {
                  repoSummary: profile.summary,
                  parentScore: scoreById.get(parent.id)?.finalScore ?? 0,
                  failedTraces: summarizeFailedTraces(tracesById.get(parent.id) ?? []),
                },
              );
        archive.addVariant(child);
        children.push({ child, parent });
      }
    }

    // Evaluate with bounded concurrency.
    const evals = await mapLimit(children, concurrency, ({ child, parent }) =>
      evaluateVariant(child, profile, config, scoreById.get(parent.id) ?? null),
    );

    // Opt-in graded promotion (ADR-076): when a hash-pinned suite is supplied,
    // evaluate each child vs its parent over the suite and let the STATISTICAL
    // decision override the single-run promote flag. Same bounded concurrency.
    let benchByChild: Map<string, PromotionDecision> | null = null;
    if (config.benchSuite) {
      const suite = config.benchSuite;
      benchByChild = new Map();
      const decisions = await mapLimit(children, concurrency, async ({ child, parent }) => {
        const { decision } = await evaluateChildAgainstParent({
          parent,
          child,
          profile,
          suite,
          seed,
          samples: config.benchSamples,
          minDelta: config.benchMinDelta,
        });
        return { id: child.id, decision };
      });
      for (const d of decisions) benchByChild.set(d.id, d.decision);
    }

    // Commit sequentially (single-writer to the archive + one save), honouring
    // the per-generation cost breaker.
    let spent = 0;
    const promoted: HarnessVariant[] = [];
    for (const ev of evals) {
      const decision = benchByChild?.get(ev.variant.id);
      if (decision) {
        // The graded gate is authoritative when present.
        ev.score.promoted = decision.promote;
        ev.score.reason = `bench(ADR-076): ${decision.reasons.join('; ')}`;
        await writeFile(
          join(config.workRoot, 'runs', `${ev.variant.id}.bench.json`),
          JSON.stringify(decision, null, 2),
          'utf8',
        );
      }
      await commit(archive, config.workRoot, ev);
      scoreById.set(ev.variant.id, ev.score);
      tracesById.set(ev.variant.id, ev.traces);
      if (ev.score.promoted) promoted.push(ev.variant);
      spent += traceSeconds(ev.traces);
      if (config.costBudgetSeconds && spent >= config.costBudgetSeconds) break;
    }
    await archive.save();

    // Selection (ADR-073): prefer promoted children; on a stalled generation
    // sample the whole archive so we explore sideways instead of dead-ending.
    // Opt-in MAP-Elites (config.selection): the stall fallback draws elites from
    // DISTINCT surface niches so exploration stays diverse at the score ceiling.
    const stallFallback =
      config.selection === 'quality-diversity'
        ? archive.selectElites(2)
        : archive.selectParents(2);
    parents = promoted.length > 0 ? promoted : stallFallback;
    if (parents.length === 0) break;
  }

  // Default 'insertion' (reproducible: archive.best breaks ties by insertion).
  // Opt-in 'faster' re-breaks top-finalScore ties by efficiency (ADR-072 ceiling).
  const winner =
    config.tieBreaker === 'faster'
      ? pickEfficientWinner(archive.all(), tracesById)
      : archive.best();
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
