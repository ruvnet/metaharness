// SPDX-License-Identifier: MIT
//
// Darwin Shield — Invariant Genome (ADR-155 Addendum B; inspired by Code Augur +
// DGM). The highest-leverage step beyond rule synthesis: instead of evolving only
// configuration, evolve explicit SECURITY ASSERTIONS and score each by whether a
// (real, here mock) fuzzer can FALSIFY it:
//
//   agent proposes invariant → fuzzer tries to break it → a violated invariant
//   becomes a finding → the fixed finding becomes a durable detector + memory.
//
// The trust property (why this beats pattern matching): a finding requires an
// actual counterexample, so clean code and decoys do not produce false positives.
// Deterministic mock fuzzer in this phase; Phase 2 wires libFuzzer/AFL++/cargo-fuzz
// behind the IDENTICAL falsification interface and promotion gate.

import type { Corpus, CorpusSite } from './corpus.js';
import type { Finding } from './types.js';
import { findingFromSite } from './corpus.js';
import { fitness, type FitnessBreakdown } from './scoring.js';
import { COST_BUDGET, TIME_BUDGET } from './scoring.js';
import { bootstrapDelta } from './stats.js';
import { detectUnsafe } from './policy.js';
import type { GeneratedDetectorCandidate } from './selfwrite.js';
import { clamp, fnv1a, makeRng, round6 } from './util.js';

/** The evolvable security-assertion classes (ADR-155 Addendum B). */
export type InvariantKind =
  | 'input-constraint'
  | 'memory-safety'
  | 'auth-boundary'
  | 'serialization'
  | 'path-traversal'
  | 'taint-flow'
  | 'race-condition';

export const INVARIANT_KINDS: readonly InvariantKind[] = [
  'input-constraint',
  'memory-safety',
  'auth-boundary',
  'serialization',
  'path-traversal',
  'taint-flow',
  'race-condition',
] as const;

/** Map a weakness class to the invariant kind whose violation reveals it. */
export function kindForWeakness(weakness: string): InvariantKind {
  const w = weakness.toLowerCase();
  if (/sql|xss|injection|ssrf|command/.test(w)) return 'taint-flow';
  if (/deserial|pickle|yaml|prototype|ssti|serializ/.test(w)) return 'serialization';
  if (/auth|signature|bypass|jwt/.test(w)) return 'auth-boundary';
  if (/oob|out-of-bounds|use-after-free|overflow|memory|uaf/.test(w)) return 'memory-safety';
  if (/path|traversal/.test(w)) return 'path-traversal';
  if (/race|toctou|concurren/.test(w)) return 'race-condition';
  return 'input-constraint';
}

/** A security assertion over a code site (never an exploit). */
export interface SecurityInvariant {
  id: string;
  kind: InvariantKind;
  target: string;
  /** Human-readable assertion. Defensive only. */
  assertion: string;
  /** 0..1 — how tightly it constrains behavior (more checkable ⇒ more falsifiable). */
  strength: number;
}

/** The genome the invariant harness evolves. */
export interface InvariantGenome {
  id: string;
  parentId?: string;
  /** Which invariant classes to assert. */
  kinds: InvariantKind[];
  /** 0..1 assertion strength. */
  strength: number;
  /** Fuzz budget per invariant (seconds). Clamp 10..600. */
  fuzzBudgetSeconds: number;
  safetyProfile: 'strict-defensive';
}

/** A fuzzer-found counterexample: the proof a finding is real (no exploit code). */
export interface Falsification {
  invariantId: string;
  kind: InvariantKind;
  siteId: string;
  file: string;
  symbol: string;
  weakness: string;
  /** A NON-weaponized description of the violating input class. */
  counterexample: string;
  severity: number;
}

/** The fuzz oracle interface — Phase 2 implements this against a real fuzzer. */
export interface FuzzOracle {
  readonly name: string;
  readonly version: string;
  /** Attempt to falsify an invariant over a site; null ⇒ the invariant holds. */
  attempt(inv: SecurityInvariant, site: CorpusSite, fuzzBudgetSeconds: number): Falsification | null;
}

/**
 * Deterministic MOCK fuzzer. Falsifies an invariant iff the site is genuinely
 * vulnerable, the invariant's kind matches the weakness, and the effective fuzz
 * power (strength scaled by budget) reaches the site's subtlety threshold. Clean
 * code and decoys yield NO counterexample → no false positive (the trust prop).
 */
export class MockFuzzOracle implements FuzzOracle {
  readonly name = 'mock-fuzz-oracle';
  readonly version = '1.0.0';

  attempt(inv: SecurityInvariant, site: CorpusSite, fuzzBudgetSeconds: number): Falsification | null {
    if (!site.isVulnerable) return null; // no counterexample exists in clean code
    if (inv.kind !== kindForWeakness(site.weakness)) return null; // wrong assertion class
    const power = inv.strength * (1 + clamp(fuzzBudgetSeconds, 10, 600) / 600);
    if (power < site.detectionThreshold) return null; // budget/strength insufficient
    return {
      invariantId: inv.id,
      kind: inv.kind,
      siteId: site.siteId,
      file: site.file,
      symbol: site.symbol,
      weakness: site.weakness,
      counterexample: `an input class violating the ${inv.kind} assertion at ${site.symbol} (bound/contract breached; payload withheld)`,
      severity: round6(site.sinkProximity),
    };
  }
}

/** Generate the invariants a genome asserts over a site (defensive assertions). */
export function generateInvariants(genome: InvariantGenome, site: CorpusSite): SecurityInvariant[] {
  return genome.kinds.map((kind) => ({
    id: `inv-${fnv1a(`${site.siteId}|${kind}`).toString(16)}`,
    kind,
    target: `${site.file}:${site.symbol}`,
    assertion: assertionText(kind, site.symbol),
    strength: clamp(genome.strength, 0, 1),
  }));
}

function assertionText(kind: InvariantKind, symbol: string): string {
  switch (kind) {
    case 'input-constraint': return `all inputs to ${symbol} are validated and bounded`;
    case 'memory-safety': return `${symbol} performs no out-of-bounds or use-after-free access`;
    case 'auth-boundary': return `${symbol} enforces the authorization boundary before privileged work`;
    case 'serialization': return `${symbol} never deserializes untrusted data into executable state`;
    case 'path-traversal': return `${symbol} confines all paths to the intended root`;
    case 'taint-flow': return `no tainted input reaches the sink in ${symbol} unsanitized`;
    case 'race-condition': return `${symbol} has no time-of-check/time-of-use window`;
  }
}

export interface InvariantRunResult {
  genome: InvariantGenome;
  falsifications: Falsification[];
  findings: Finding[];
  metrics: { truePositives: number; falsePositives: number; falseNegatives: number };
  /** Per-repo fitness samples (for the paired statistical gate). */
  perRepoFitness: number[];
  breakdown: FitnessBreakdown;
}

/**
 * Run the invariant harness over a corpus: assert invariants, let the fuzzer try
 * to falsify them, turn falsifications into findings. Deterministic.
 */
export function runInvariantHarness(
  genome: InvariantGenome,
  corpus: Corpus,
  fuzz: FuzzOracle,
  baselineFalsePositiveRate = 0.5,
): InvariantRunResult {
  const falsifications: Falsification[] = [];
  const findings: Finding[] = [];
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const perRepoFitness: number[] = [];

  for (const repo of corpus.repos) {
    let rtp = 0;
    let rfp = 0;
    let rfn = 0;
    for (const site of repo.sites) {
      const invs = generateInvariants(genome, site);
      const broken = invs.map((inv) => fuzz.attempt(inv, site, genome.fuzzBudgetSeconds)).find((x) => x !== null) ?? null;
      if (site.isVulnerable) {
        if (broken) {
          rtp += 1;
          falsifications.push(broken);
          findings.push(findingFromSite(site, repo.repo, repo.commit, 0.95, 'confirmed'));
        } else {
          rfn += 1;
        }
      } else if (broken) {
        // A counterexample on clean code should never happen in the mock; guard anyway.
        rfp += 1;
      }
    }
    tp += rtp; fp += rfp; fn += rfn;
    const vulns = repo.sites.filter((s) => s.isVulnerable).length;
    const decoys = repo.sites.filter((s) => !s.isVulnerable).length;
    perRepoFitness.push(
      fitness({
        metrics: { truePositives: rtp, falsePositives: rfp, falseNegatives: rfn, reproduced: rtp, patchesPassing: rtp, patchesProposed: rtp, toolAgreements: rtp, novelFindings: rtp, unsafeOutputs: 0, costUnits: costOfInvariant(genome), timeToFinding: 1 },
        groundTruthCount: vulns,
        decoyCount: decoys,
        baselineFalsePositiveRate,
        costBudget: COST_BUDGET,
        timeBudget: TIME_BUDGET,
      }).fitness,
    );
  }

  const gt = corpus.repos.reduce((n, r) => n + r.sites.filter((s) => s.isVulnerable).length, 0);
  const dc = corpus.repos.reduce((n, r) => n + r.sites.filter((s) => !s.isVulnerable).length, 0);
  const breakdown = fitness({
    metrics: { truePositives: tp, falsePositives: fp, falseNegatives: fn, reproduced: tp, patchesPassing: tp, patchesProposed: tp, toolAgreements: tp, novelFindings: tp, unsafeOutputs: 0, costUnits: costOfInvariant(genome), timeToFinding: 1 },
    groundTruthCount: gt,
    decoyCount: dc,
    baselineFalsePositiveRate,
    costBudget: COST_BUDGET,
    timeBudget: TIME_BUDGET,
  });

  return { genome, falsifications, findings, metrics: { truePositives: tp, falsePositives: fp, falseNegatives: fn }, perRepoFitness, breakdown };
}

/** Deterministic cost proxy: more invariant kinds and more fuzz budget cost more. */
export function costOfInvariant(genome: InvariantGenome): number {
  return round6(genome.kinds.length * 1.0 + genome.fuzzBudgetSeconds / 60 + genome.strength * 2);
}

/** The fixed baseline invariant genome (a single weak assertion class). */
export function baselineInvariantGenome(): InvariantGenome {
  return { id: 'inv-baseline', kinds: ['input-constraint'], strength: 0.5, fuzzBudgetSeconds: 30, safetyProfile: 'strict-defensive' };
}

const INV_BOUNDS = { strength: [0.1, 0.99] as const, fuzz: [10, 600] as const };

export function mutateInvariant(parent: InvariantGenome, rng: () => number, gen: number, idx: number): InvariantGenome {
  const k = INVARIANT_KINDS[Math.floor(rng() * INVARIANT_KINDS.length)];
  const kinds = parent.kinds.includes(k) ? parent.kinds.filter((x) => x !== k) : [...parent.kinds, k];
  const safeKinds = kinds.length > 0 ? kinds : [k];
  return {
    id: `iv${gen}_${idx}_${fnv1a(`${parent.id}${gen}${idx}`).toString(36).slice(0, 4)}`,
    parentId: parent.id,
    kinds: [...new Set(safeKinds)],
    strength: round6(clamp(parent.strength + (rng() < 0.5 ? 0.1 : -0.1), INV_BOUNDS.strength[0], INV_BOUNDS.strength[1])),
    fuzzBudgetSeconds: clamp(Math.round(parent.fuzzBudgetSeconds * (rng() < 0.5 ? 2 : 0.5)), INV_BOUNDS.fuzz[0], INV_BOUNDS.fuzz[1]),
    safetyProfile: 'strict-defensive',
  };
}

export function isInvariantGenomeValid(g: InvariantGenome): boolean {
  return (
    g.safetyProfile === 'strict-defensive' &&
    g.kinds.length > 0 &&
    g.kinds.every((k) => INVARIANT_KINDS.includes(k)) &&
    g.strength >= INV_BOUNDS.strength[0] && g.strength <= INV_BOUNDS.strength[1] &&
    g.fuzzBudgetSeconds >= INV_BOUNDS.fuzz[0] && g.fuzzBudgetSeconds <= INV_BOUNDS.fuzz[1]
  );
}

export interface InvariantEvolveResult {
  champion: InvariantRunResult;
  baseline: InvariantRunResult;
  history: number[];
  /** Paired-bootstrap verdict: champion vs baseline invariant genome. */
  promote: boolean;
  lower95: number;
  cyclesRun: number;
}

/** Evolve the invariant genome; promote the champion only if statistically superior. */
export function evolveInvariants(
  corpus: Corpus,
  fuzz: FuzzOracle,
  opts: { population?: number; cycles?: number; seed?: number; baselineFalsePositiveRate?: number } = {},
): InvariantEvolveResult {
  const population = opts.population ?? 12;
  const cycles = opts.cycles ?? 30;
  const seed = opts.seed ?? 0;
  const fpRate = opts.baselineFalsePositiveRate ?? 0.5;
  const rng = makeRng(seed);

  const base = baselineInvariantGenome();
  const baseline = runInvariantHarness(base, corpus, fuzz, fpRate);
  let champion = baseline;
  const history: number[] = [];

  let pop: InvariantGenome[] = [base];
  for (let i = 1; i < population; i += 1) pop.push(mutateInvariant(base, rng, 0, i));

  const eliteCount = Math.max(1, Math.floor(population * 0.25));
  for (let c = 0; c < cycles; c += 1) {
    const scored = pop.map((g) => runInvariantHarness(g, corpus, fuzz, fpRate)).sort((a, b) => b.breakdown.fitness - a.breakdown.fitness);
    if (scored[0].breakdown.fitness > champion.breakdown.fitness) champion = scored[0];
    history.push(champion.breakdown.fitness);
    const elites = scored.slice(0, eliteCount).map((s) => s.genome);
    const next = [...elites];
    let idx = 0;
    while (next.length < population) {
      next.push(mutateInvariant(elites[idx % elites.length], rng, c + 1, next.length));
      idx += 1;
    }
    pop = next;
  }

  const boot = bootstrapDelta(baseline.perRepoFitness, champion.perRepoFitness, { seed });
  return { champion, baseline, history, promote: boot.promote && champion.metrics.falsePositives === 0, lower95: boot.lower95, cyclesRun: cycles };
}

/**
 * Promote a fuzzer-falsified invariant into a DURABLE detector candidate (a
 * taint-heuristic artifact), closing the loop: a violated assertion becomes a
 * reusable detector that flows into the self-writing promotion gate + ruVector.
 * The artifact is defensive and carries no exploit (asserted + checked here).
 */
export function falsificationToDetector(f: Falsification): GeneratedDetectorCandidate {
  const artifact = [
    `# durable detector synthesized from a fuzzer-falsified invariant`,
    `covers: ${f.weakness}`,
    `precision: 0.95`,
    `# origin: ${f.kind} invariant violated at ${f.file}:${f.symbol}`,
  ].join('\n');
  // Defensive invariant: a durable detector never embeds weaponized content.
  if (detectUnsafe(artifact).length > 0) throw new Error('refusing to synthesize unsafe detector');
  return {
    id: `det-${f.invariantId}`,
    surface: 'taint-heuristic',
    artifact,
    prompt: `derive a durable detector from the falsified ${f.kind} invariant at ${f.symbol}`,
    model: 'invariant-falsification',
    seed: 0,
  };
}
