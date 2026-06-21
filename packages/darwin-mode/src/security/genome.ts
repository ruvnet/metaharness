// SPDX-License-Identifier: MIT
//
// Darwin Shield — the genome: creation, bounded mutation, and crossover
// (ADR-155 §genome, §mutation operators).
//
// Only the HARNESS evolves. `safetyProfile` is immutable ('strict-defensive')
// and every mutation is bounded — reviewerCount ∈ [1,5], retryBudget ∈ [1,6],
// fuzzBudget ∈ [10,600] — so a child can never escape the safe envelope. The
// mutator is deterministic given a seed (reproducible populations, ADR-155).

import type { HarnessGenome, SecurityTool } from './types.js';
import { clamp, makeRng } from './util.js';

export const PLANNERS: readonly HarnessGenome['planner'][] = [
  'file-first',
  'sink-first',
  'diff-first',
  'callgraph-first',
  'risk-first',
  'memory-first',
] as const;

export const CONTEXT_POLICIES: readonly HarnessGenome['contextPolicy'][] = [
  'minimal',
  'semantic',
  'callgraph',
  'hybrid',
] as const;

export const ALL_TOOLS: readonly SecurityTool[] = [
  'semgrep',
  'codeql',
  'cargo-audit',
  'npm-audit',
  'osv-scanner',
  'trivy',
  'cargo-fuzz',
] as const;

/** Bounds for the numeric knobs (the safe envelope). */
export const BOUNDS = {
  reviewerCount: [1, 5],
  retryBudget: [1, 6],
  fuzzBudgetSeconds: [10, 600],
} as const;

/** The default validation pipeline; reordering/extending is a knob, not safety. */
const DEFAULT_PIPELINE = ['static', 'fuzz', 'repro-test', 'review'];

/**
 * The baseline genome — a reasonable fixed harness (the `B2 fixed-agent`
 * benchmark baseline). Darwin Mode must beat THIS by ≥25% to be accepted.
 */
export function baselineGenome(): HarnessGenome {
  return {
    id: 'baseline',
    planner: 'file-first',
    contextPolicy: 'semantic',
    reviewerCount: 1,
    retryBudget: 2,
    fuzzBudgetSeconds: 60,
    tools: ['semgrep', 'osv-scanner'],
    modelMix: ['claude'],
    validationPipeline: [...DEFAULT_PIPELINE],
    safetyProfile: 'strict-defensive',
  };
}

/** A stricter static-only baseline (`B0`): tools, no LLM reasoning/review. */
export function staticOnlyGenome(): HarnessGenome {
  return {
    ...baselineGenome(),
    id: 'static-only',
    planner: 'file-first',
    contextPolicy: 'minimal',
    reviewerCount: 1,
    modelMix: [],
    tools: ['semgrep', 'codeql', 'cargo-audit', 'osv-scanner'],
    validationPipeline: ['static'],
  };
}

/** A single-pass LLM baseline (`B1`): one model, minimal context, one review. */
export function llmSinglePassGenome(): HarnessGenome {
  return {
    ...baselineGenome(),
    id: 'llm-single-pass',
    planner: 'file-first',
    contextPolicy: 'minimal',
    reviewerCount: 1,
    retryBudget: 1,
    tools: ['semgrep'],
    modelMix: ['claude'],
    validationPipeline: ['static', 'review'],
  };
}

let counter = 0;
/** A stable-ish id for a freshly created genome. */
function genomeId(generation: number, index: number): string {
  counter = (counter + 1) >>> 0;
  return `g${generation}_v${index}_${counter.toString(36)}`;
}

/** Pick an element deterministically from the RNG. */
function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Mutate a parent into a bounded child. Each call perturbs a handful of knobs;
 * the safety profile and id-lineage are preserved. Deterministic for a fixed RNG.
 */
export function mutate(
  parent: HarnessGenome,
  rng: () => number,
  generation: number,
  index: number,
): HarnessGenome {
  const toolDelta = pick(rng, ALL_TOOLS);
  const tools = parent.tools.includes(toolDelta)
    ? parent.tools.filter((t) => t !== toolDelta)
    : [...parent.tools, toolDelta];

  // Never let the toolset go empty — a harness with no tools is degenerate.
  const safeTools: SecurityTool[] = tools.length > 0 ? tools : [pick(rng, ALL_TOOLS)];

  return {
    id: genomeId(generation, index),
    parentId: parent.id,
    planner: rng() < 0.5 ? pick(rng, PLANNERS) : parent.planner,
    contextPolicy: rng() < 0.5 ? pick(rng, CONTEXT_POLICIES) : parent.contextPolicy,
    reviewerCount: clamp(
      parent.reviewerCount + pick(rng, [-1, 0, 1]),
      BOUNDS.reviewerCount[0],
      BOUNDS.reviewerCount[1],
    ),
    retryBudget: clamp(
      parent.retryBudget + pick(rng, [-1, 0, 1]),
      BOUNDS.retryBudget[0],
      BOUNDS.retryBudget[1],
    ),
    fuzzBudgetSeconds: clamp(
      Math.round(parent.fuzzBudgetSeconds * pick(rng, [0.5, 1, 2])),
      BOUNDS.fuzzBudgetSeconds[0],
      BOUNDS.fuzzBudgetSeconds[1],
    ),
    tools: [...new Set(safeTools)],
    modelMix: [...parent.modelMix],
    validationPipeline: [...parent.validationPipeline],
    safetyProfile: 'strict-defensive',
  };
}

/**
 * Uniform crossover of two parents (ADR-155 swarm §crossover). Each knob is
 * inherited from one parent or the other; the safety profile is fixed. The child
 * stays inside the safe envelope because both parents already are.
 */
export function crossover(
  a: HarnessGenome,
  b: HarnessGenome,
  rng: () => number,
  generation: number,
  index: number,
): HarnessGenome {
  const choose = <T>(x: T, y: T): T => (rng() < 0.5 ? x : y);
  const tools = [...new Set(choose(a.tools, b.tools))];
  return {
    id: genomeId(generation, index),
    parentId: a.id,
    planner: choose(a.planner, b.planner),
    contextPolicy: choose(a.contextPolicy, b.contextPolicy),
    reviewerCount: clamp(choose(a.reviewerCount, b.reviewerCount), BOUNDS.reviewerCount[0], BOUNDS.reviewerCount[1]),
    retryBudget: clamp(choose(a.retryBudget, b.retryBudget), BOUNDS.retryBudget[0], BOUNDS.retryBudget[1]),
    fuzzBudgetSeconds: clamp(
      choose(a.fuzzBudgetSeconds, b.fuzzBudgetSeconds),
      BOUNDS.fuzzBudgetSeconds[0],
      BOUNDS.fuzzBudgetSeconds[1],
    ),
    tools: tools.length > 0 ? tools : [...a.tools],
    modelMix: choose([...a.modelMix], [...b.modelMix]),
    validationPipeline: choose([...a.validationPipeline], [...b.validationPipeline]),
    safetyProfile: 'strict-defensive',
  };
}

/** True iff a genome respects every bound and the immutable safety profile. */
export function isGenomeValid(g: HarnessGenome): boolean {
  return (
    g.safetyProfile === 'strict-defensive' &&
    g.reviewerCount >= BOUNDS.reviewerCount[0] &&
    g.reviewerCount <= BOUNDS.reviewerCount[1] &&
    g.retryBudget >= BOUNDS.retryBudget[0] &&
    g.retryBudget <= BOUNDS.retryBudget[1] &&
    g.fuzzBudgetSeconds >= BOUNDS.fuzzBudgetSeconds[0] &&
    g.fuzzBudgetSeconds <= BOUNDS.fuzzBudgetSeconds[1] &&
    g.tools.length > 0 &&
    g.tools.every((t) => (ALL_TOOLS as readonly string[]).includes(t)) &&
    PLANNERS.includes(g.planner) &&
    CONTEXT_POLICIES.includes(g.contextPolicy)
  );
}

/**
 * Seed an initial population from a base genome by repeated mutation. If
 * `seeds` are supplied (from ruVector genome memory, ADR-155 §genome memory),
 * they prefix the population so evolution starts from prior winners.
 */
export function seedPopulation(
  base: HarnessGenome,
  size: number,
  seed: number,
  seeds: HarnessGenome[] = [],
): HarnessGenome[] {
  const rng = makeRng(seed);
  const pop: HarnessGenome[] = [base, ...seeds].slice(0, size);
  let i = pop.length;
  while (pop.length < size) {
    pop.push(mutate(base, rng, 0, i));
    i += 1;
  }
  return pop;
}
