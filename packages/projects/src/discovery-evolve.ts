// SPDX-License-Identifier: MIT
//
// @metaharness/projects — Darwin-style evolution over the DISCOVERY HARNESS POLICY.
// This makes the defensive zero-day discovery harness (discovery.ts) self-optimizing:
// the program thesis end-to-end — FREEZE THE MODEL, EVOLVE THE HARNESS. A seeded
// population of DiscoveryPolicy objects is mutated, scored, selected by elitism, and
// evolved for N generations toward "verified findings per cost". The champion is
// compared against a baseline policy.
//
// There are NO real LLM calls anywhere here. The policy evaluator is INJECTED, so the
// loop is fully deterministic and unit-testable: real use wires the discovery bench
// (run the pipeline under each candidate policy, count verified findings and cost
// units), while tests pass a deterministic mock. Modeled on the elitism / mutation /
// champion / receipt pattern of Darwin Shield's real-evolve, kept generic and LLM-free.

import { makeRng, hashJson, round6, clamp } from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// The mutatable policy and its fitness.
// ─────────────────────────────────────────────────────────────────────────────

/** The discovery-harness knobs Darwin mutates (a subset surfaced for evolution). */
export interface DiscoveryPolicy {
  /** Cheap model used for the triage lane. */
  cheapModel: string;
  /** Frontier model used for the propose (proof) lane. */
  frontierModel: string;
  /** Cap on triage candidates escalated to the frontier lane (cost guard). */
  maxEscalations: number;
  /** Skip frontier escalation for sites the static channel already verified. */
  skipStaticallyCovered: boolean;
  /** Which prompt template family the lanes use (an opaque variant index). */
  promptVariant: number;
}

/** What the (injected) evaluator measures for one policy. */
export interface PolicyFitness {
  /** Execution-verified findings produced under this policy. */
  verified: number;
  /** Total abstract cost-units spent under this policy. */
  costUnits: number;
}

/**
 * Score a policy: VERIFIED FINDINGS PER COST. More verified weaknesses for less
 * spend is better, so higher is better. A policy that finds something for zero cost
 * is the theoretical best (we floor the divisor at epsilon, not zero). round6.
 */
export function policyFitnessScalar(f: PolicyFitness): number {
  const EPSILON = 1e-6;
  return round6(f.verified / Math.max(f.costUnits, EPSILON));
}

/**
 * The injected fitness function. In production this runs the discovery pipeline
 * (bench/zero-day-discovery) under the policy and returns its verified/cost tally;
 * in tests it is a deterministic mock. The loop never calls an LLM itself.
 */
export type PolicyEvaluator = (p: DiscoveryPolicy) => PolicyFitness;

/** The vocabulary the population draws each knob's allele from. */
export interface PolicyVocabulary {
  cheapModels: string[];
  frontierModels: string[];
  maxEscalationChoices: number[];
  promptVariants: number[];
}

export interface EvolveConfig {
  /** REQUIRED injected scorer (keeps the loop LLM-free and deterministic). */
  evaluator: PolicyEvaluator;
  /** Allele pools per knob (default: defaultVocabulary()). */
  vocabulary?: PolicyVocabulary;
  generations?: number;
  population?: number;
  seed?: number;
  /** Starting policy to beat (default: a deliberately weak baseline). */
  baseline?: DiscoveryPolicy;
  eliteFraction?: number;
}

export interface DiscoveryEvolveResult {
  champion: DiscoveryPolicy;
  championFitness: number;
  baseline: DiscoveryPolicy;
  baselineFitness: number;
  /** Best champion fitness per generation (monotone non-decreasing learning curve). */
  history: number[];
  generations: number;
  /** Total policy evaluations requested across the run. */
  evaluations: number;
  /** Distinct evaluator invocations actually made (< evaluations: the memo cache). */
  evaluatorCalls: number;
  improvedOverBaseline: boolean;
  receiptHash: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults.
// ─────────────────────────────────────────────────────────────────────────────

/** A small default allele vocabulary covering cheap/frontier tiers and cost guards. */
export function defaultVocabulary(): PolicyVocabulary {
  return {
    cheapModels: ['cheap-a', 'cheap-b'],
    frontierModels: ['frontier-a', 'frontier-b'],
    maxEscalationChoices: [1, 2, 4, 8],
    promptVariants: [0, 1, 2],
  };
}

/** The default starting policy — cheap-first, low escalation cap, no static skip. */
export function defaultDiscoveryPolicy(): DiscoveryPolicy {
  return {
    cheapModel: 'cheap-a',
    frontierModel: 'frontier-a',
    maxEscalations: 1,
    skipStaticallyCovered: false,
    promptVariant: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals.
// ─────────────────────────────────────────────────────────────────────────────

/** Stable content hash of a policy (key order normalized) — the memo/cache key. */
function policyKey(p: DiscoveryPolicy): string {
  return hashJson({
    cheapModel: p.cheapModel,
    frontierModel: p.frontierModel,
    maxEscalations: p.maxEscalations,
    skipStaticallyCovered: p.skipStaticallyCovered,
    promptVariant: p.promptVariant,
  });
}

function pick<T>(xs: T[], rng: () => number): T {
  return xs[Math.floor(rng() * xs.length)] as T;
}

/** Draw a fully random policy from the vocabulary (seeded). */
function randomPolicy(v: PolicyVocabulary, rng: () => number): DiscoveryPolicy {
  return {
    cheapModel: pick(v.cheapModels, rng),
    frontierModel: pick(v.frontierModels, rng),
    maxEscalations: pick(v.maxEscalationChoices, rng),
    skipStaticallyCovered: rng() < 0.5,
    promptVariant: pick(v.promptVariants, rng),
  };
}

/** Mutate exactly ONE knob of a policy (the bounded mutation operator, seeded). */
function mutatePolicy(p: DiscoveryPolicy, v: PolicyVocabulary, rng: () => number): DiscoveryPolicy {
  const knob = Math.floor(rng() * 5);
  const next: DiscoveryPolicy = { ...p };
  switch (knob) {
    case 0:
      next.cheapModel = pick(v.cheapModels, rng);
      break;
    case 1:
      next.frontierModel = pick(v.frontierModels, rng);
      break;
    case 2:
      next.maxEscalations = pick(v.maxEscalationChoices, rng);
      break;
    case 3:
      next.skipStaticallyCovered = !p.skipStaticallyCovered;
      break;
    default:
      next.promptVariant = pick(v.promptVariants, rng);
      break;
  }
  return next;
}

interface Scored {
  policy: DiscoveryPolicy;
  fitness: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// The evolution loop.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evolve a DiscoveryPolicy population with the INJECTED evaluator as the fitness
 * oracle. Each generation: evaluate (memoized by stable policy hash, so identical
 * policies are never re-scored — evaluatorCalls stays < evaluations), select elites,
 * mutate one knob per child, and keep the running champion by fitness. Tie-break:
 * fewer escalations (cheaper), then stable policy-hash order. The champion history
 * is monotone. Deterministic for a fixed seed; the receipt hashes champion + history.
 */
export function evolveDiscoveryPolicy(cfg: EvolveConfig): DiscoveryEvolveResult {
  const generations = Math.max(1, cfg.generations ?? 6);
  const popSize = Math.max(2, cfg.population ?? 8);
  const seed = cfg.seed ?? 0;
  const eliteFraction = cfg.eliteFraction ?? 0.34;
  const vocab = cfg.vocabulary ?? defaultVocabulary();
  const baseline = cfg.baseline ?? defaultDiscoveryPolicy();
  const rng = makeRng(seed);

  // Memo cache keyed by stable policy hash: identical policies are scored once.
  const cache = new Map<string, number>();
  let evaluations = 0;
  let evaluatorCalls = 0;
  const evaluate = (p: DiscoveryPolicy): number => {
    evaluations += 1;
    const k = policyKey(p);
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    evaluatorCalls += 1;
    const f = policyFitnessScalar(cfg.evaluator(p));
    cache.set(k, f);
    return f;
  };

  // Champion ranking: higher fitness, then fewer escalations (cheaper), then stable.
  const better = (a: Scored, b: Scored): number =>
    b.fitness - a.fitness ||
    a.policy.maxEscalations - b.policy.maxEscalations ||
    policyKey(a.policy).localeCompare(policyKey(b.policy));

  const score = (p: DiscoveryPolicy): Scored => ({ policy: p, fitness: evaluate(p) });

  const baselineScored = score(baseline);

  // Initial population: the baseline plus seeded-random policies.
  let population: DiscoveryPolicy[] = [baseline];
  for (let i = 1; i < popSize; i += 1) population.push(randomPolicy(vocab, rng));

  let champion = baselineScored;
  const history: number[] = [];
  const eliteCount = clamp(Math.floor(popSize * eliteFraction), 1, popSize);

  for (let gen = 0; gen < generations; gen += 1) {
    const scored = population.map(score);
    scored.sort(better);
    if (better(scored[0], champion) < 0) champion = scored[0];
    history.push(champion.fitness); // monotone: champion only ever improves

    const elites = scored.slice(0, eliteCount).map((s) => s.policy);
    const next: DiscoveryPolicy[] = [...elites];
    let idx = 0;
    while (next.length < popSize) {
      const parent = elites[idx % elites.length];
      next.push(mutatePolicy(parent, vocab, rng));
      idx += 1;
    }
    population = next;
  }

  const improvedOverBaseline = champion.fitness > baselineScored.fitness;
  const receiptHash = hashJson({ champion: champion.policy, fitness: champion.fitness, history });

  return {
    champion: champion.policy,
    championFitness: champion.fitness,
    baseline: baselineScored.policy,
    baselineFitness: baselineScored.fitness,
    history,
    generations,
    evaluations,
    evaluatorCalls,
    improvedOverBaseline,
    receiptHash,
  };
}
