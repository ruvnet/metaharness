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
import { runVariantTasksMock } from './mock-sandbox.js';
import { scoreVariant } from './scorer.js';
import {
  behavioralNiche,
  embedTraces,
  nearestToTarget,
  underExploredTarget,
} from './phenotype.js';
import { buildLinkage, LinkageGraph, linkedCrossoverBlock } from './epistasis.js';
import { cladeThompsonSelect } from './clade.js';
import type { MutationSurface } from './types.js';
import { evaluateChildAgainstParent } from './bench/runner.js';
import { benjaminiHochberg } from './bench/stats.js';
import { curriculumSuite, maxDifficulty, nextCurriculumLevel } from './curriculum.js';
import { paretoFront } from './pareto.js';
import { statSync, readdirSync } from 'node:fs';
import { admitWithStatisticalGate, makeRiskBudget } from './bench/risk.js';
import type { RiskBudget } from './bench/risk.js';
import type { BenchmarkResult, PromotionDecision } from './bench/types.js';

/** Hidden-test pass rate over a variant's per-task results (SGM SOTA clause). */
function hiddenRate(results: BenchmarkResult[]): number {
  if (results.length === 0) return 0;
  return results.filter((r) => r.hiddenTestPassed).length / results.length;
}

/** Cost-per-solve: total metered cost divided by solved tasks (≥1 to avoid /0). */
function costPerSolve(results: BenchmarkResult[]): number {
  const solved = results.filter((r) => r.solved).length;
  const cost = results.reduce((s, r) => s + r.costUsd, 0);
  return cost / Math.max(1, solved);
}
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
  // ADR-102: in 'mock' mode the surfaces actually drive a deterministic agent
  // loop, so the trace depends on surface content (manifold becomes live). The
  // default 'real' mode runs the repo test command (surface-independent).
  const traces =
    cfg.sandboxMode === 'mock'
      ? await runVariantTasksMock(variant, cfg.mockTasks)
      : await runVariantTasks(variant, profile, cfg.tasks, { taskTimeoutMs: timeout });
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

/**
 * Total bytes of a variant's surface files — a DETERMINISTIC parsimony signal
 * (mutations change code size). Unlike trace-derived behaviour (which is
 * surface-independent in the current sandbox), code size genuinely differs
 * across variants, so it is a non-degenerate secondary objective for Pareto
 * selection (ADR-100). Returns Infinity if the directory is unreadable.
 */
function variantBytes(dir: string): number {
  try {
    let total = 0;
    for (const name of readdirSync(dir)) {
      const st = statSync(join(dir, name));
      if (st.isFile()) total += st.size;
    }
    return total;
  } catch {
    return Infinity;
  }
}

/** Mean wall-clock per trace; `Infinity` when a variant has no traces (sinks last). */
function meanDurationMs(traces: RunTrace[]): number {
  if (traces.length === 0) return Infinity;
  return traces.reduce((s, t) => s + t.durationMs, 0) / traces.length;
}

/**
 * Active niche steering (ADR-092): seed the next generation from the scored
 * variants nearest an UNDER-EXPLORED region of the Poincaré ball, so their
 * offspring drive toward it. Returns `[]` when there is no hole or no candidate,
 * letting the caller fall back to behavioural-diversity selection.
 */
function steerTowardHole(
  archive: Archive,
  tracesById: Map<string, RunTrace[]>,
  limit: number,
): HarnessVariant[] {
  const scored = archive.all().filter((r) => r.score !== null);
  if (scored.length === 0) return [];
  const occupied = new Set(scored.map((r) => behavioralNiche(tracesById.get(r.variant.id) ?? [])));
  const target = underExploredTarget(occupied);
  if (target === null) return []; // manifold fully occupied — nothing to steer toward
  const candidates = scored.map((r) => ({
    id: r.variant.id,
    embed: embedTraces(tracesById.get(r.variant.id) ?? []),
  }));
  const nearestIds = nearestToTarget(candidates, target.centroid, limit);
  const byId = new Map(scored.map((r) => [r.variant.id, r.variant]));
  return nearestIds.map((id) => byId.get(id)!).filter(Boolean);
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
  // Self-directed curriculum (ADR-097): start at the easiest tier and escalate as
  // the population masters it. Only meaningful with a graded benchSuite.
  let curriculumLevel = 1;
  // Opt-in SGM cumulative risk budget (ADR-079), shared across all generations.
  const riskBudget: RiskBudget | null =
    config.benchSuite && config.riskBudgetTotal !== undefined
      ? makeRiskBudget(config.riskBudgetTotal)
      : null;
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
    // ADR-093: when epistasis is on, learn the surface-linkage graph from the
    // archive so crossover keeps co-adapted surfaces together (topology-aware).
    const linkage: LinkageGraph | null =
      canCross && config.epistasis === true
        ? buildLinkage(
            archive
              .all()
              .filter((r) => r.score !== null)
              .map((r) => ({
                surfaces: archive
                  .lineageOf(r.variant.id)
                  .map((id) => archive.get(id)?.variant.mutationSurface)
                  .filter((s): s is MutationSurface => s !== undefined),
                score: r.score!.finalScore,
              })),
          )
        : null;
    for (let pIdx = 0; pIdx < parents.length; pIdx++) {
      const parent = parents[pIdx];
      for (let localIndex = 0; localIndex < config.childrenPerGeneration; localIndex++) {
        // Unique per generation across ALL parents, so sibling ids never collide
        // (and never coincide with an existing variant's id → no self-copy).
        const index = pIdx * config.childrenPerGeneration + localIndex;
        // Opt-in crossover (ADR-089): the first child of each parent recombines
        // with the next parent's surfaces; the rest are ordinary mutations. With
        // epistasis (ADR-093) the inherited subset is the next parent's linked block.
        const other = parents[(pIdx + 1) % parents.length];
        const child =
          canCross && localIndex === 0
            ? await createCrossoverVariant(
                parent,
                other,
                config.workRoot,
                generation,
                index,
                seed,
                linkage ? linkedCrossoverBlock(linkage, other.mutationSurface) : undefined,
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
      // With the curriculum on, score only the admitted difficulty tier this gen.
      const suite = config.curriculum
        ? curriculumSuite(config.benchSuite, curriculumLevel)
        : config.benchSuite;
      benchByChild = new Map();
      // Concurrent bench evaluation (no shared state).
      const evaluated = await mapLimit(children, concurrency, async ({ child, parent }) => {
        const r = await evaluateChildAgainstParent({
          parent,
          child,
          profile,
          suite,
          seed,
          samples: config.benchSamples,
          minDelta: config.benchMinDelta,
        });
        return { id: child.id, ...r };
      });
      // Apply the SGM gate SEQUENTIALLY so the shared risk budget charges safely
      // (ADR-079). Without a budget, the base statistical decision stands.
      for (const e of evaluated) {
        let decision = e.decision;
        if (riskBudget) {
          const gate = admitWithStatisticalGate({
            decision,
            childHiddenTestRate: hiddenRate(e.childResults),
            parentHiddenTestRate: hiddenRate(e.parentResults),
            childCostPerSolve: costPerSolve(e.childResults),
            parentCostPerSolve: costPerSolve(e.parentResults),
            costCeilingFactor: config.costCeilingFactor,
            riskBudget,
          });
          decision = {
            ...decision,
            promote: gate.admit,
            reasons: [
              ...decision.reasons,
              ...gate.reasons,
              `risk budget remaining: ${gate.riskRemaining}`,
            ],
          };
        }
        benchByChild.set(e.id, decision);
      }

      // ADR-096: Benjamini–Hochberg FDR control across THIS generation's
      // candidates. With many concurrent tests, per-comparison gates over-promote
      // by chance; BH corrects it. It can only DEMOTE (never promotes a child
      // that failed its clauses) — a child stays promoted iff it already passed
      // AND survives the generation-wide correction at q = config.fdrQ.
      if (config.fdrQ !== undefined) {
        const entries = [...benchByChild.entries()];
        const significant = benjaminiHochberg(entries.map(([, d]) => d.pValue), config.fdrQ);
        entries.forEach(([id, d], i) => {
          if (d.promote && !significant[i]) {
            benchByChild!.set(id, {
              ...d,
              promote: false,
              reasons: [...d.reasons, `FDR(BH q=${config.fdrQ}): not significant after multiple-testing correction`],
            });
          }
        });
      }

      // ADR-097: escalate the curriculum when the population MASTERS the tier.
      if (config.curriculum) {
        const rates = evaluated.map((e) =>
          e.childResults.length
            ? e.childResults.filter((r) => r.solved).length / e.childResults.length
            : 0,
        );
        const meanSolveRate = rates.length ? rates.reduce((s, r) => s + r, 0) / rates.length : 0;
        curriculumLevel = nextCurriculumLevel(
          curriculumLevel,
          meanSolveRate,
          maxDifficulty(config.benchSuite),
          config.curriculumThreshold,
        );
      }
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
    // ADR-094: clade-metaproductivity selection picks parents by descendant
    // POTENTIAL (Thompson sampling over the subtree's success rate), not current
    // score — the best scorer is a spent parent. τ is scheduled from the SGM
    // budget: full budget → explore, spent budget → exploit. Bypasses the
    // promoted-first rule (HGM), falling back only if nothing is scored yet.
    if (config.selection === 'clade') {
      const tau =
        riskBudget && riskBudget.total > 0 ? riskBudget.spent / riskBudget.total : 1;
      const cladeParents = cladeThompsonSelect(archive, tau, 2, seed + generation);
      parents = cladeParents.length > 0 ? cladeParents : promoted.length > 0 ? promoted : archive.selectParents(2);
      if (parents.length === 0) break;
      continue;
    }

    let stallFallback: HarnessVariant[];
    if (config.selection === 'niche-steering') {
      // Steer toward an under-explored Poincaré region; if the manifold is full
      // (no hole), degrade to behavioural-diversity elites.
      const steered = steerTowardHole(archive, tracesById, 2);
      stallFallback =
        steered.length > 0
          ? steered
          : archive.selectElites(2, (v) => behavioralNiche(tracesById.get(v.id) ?? []));
    } else if (config.selection === 'behavioral-diversity') {
      stallFallback = archive.selectElites(2, (v) => behavioralNiche(tracesById.get(v.id) ?? []));
    } else if (config.selection === 'quality-diversity') {
      stallFallback = archive.selectElites(2);
    } else if (config.selection === 'pareto') {
      // Non-dominated over (finalScore ↑, code parsimony ↑ = bytes ↓). Keeps both
      // capable and parsimonious variants as parents (ADR-100). Cap at 2 by score.
      const sized = archive
        .all()
        .filter((r) => r.score !== null)
        .map((r) => ({ v: r.variant, score: r.score!.finalScore, bytes: variantBytes(r.variant.dir) }));
      const front = paretoFront(sized, (o) => [o.score, -o.bytes]);
      stallFallback = (front.length > 0 ? front : sized)
        .sort((a, b) => b.score - a.score || a.bytes - b.bytes)
        .slice(0, 2)
        .map((o) => o.v);
    } else {
      stallFallback = archive.selectParents(2);
    }
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
