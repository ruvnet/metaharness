// SPDX-License-Identifier: MIT
//
// Darwin Shield — REAL evolutionary loop (ADR-155 Addendum A, Phase 2 §capstone).
// The ADR thesis end-to-end with a real tool: a population of detector genomes
// (rule-sets) is mutated, SCORED BY REAL `semgrep --json` over a labeled corpus,
// selected by elitism, and evolved for N generations — the model is frozen, only
// the harness (the detector configuration) evolves, and the champion is certified
// against the baseline by the paired seeded bootstrap. Proof is in replay:
// deterministic for a fixed seed + semgrep version. Optional: skips when semgrep
// is absent. Semgrep calls are seconds each, so identical rule-sets are cached.

import { makeRng, fnv1a, round6 } from './util.js';
import { bootstrapDelta, type BootstrapResult } from './stats.js';
import { SemgrepDetectorOracle, type LabeledTarget } from './semgrep-oracle.js';
import { generateSemgrepRule, type RulePatternKey } from './real-loop.js';

/** The default weakness vocabulary the detector population draws from. */
export const ALL_PATTERNS: RulePatternKey[] = ['eval', 'exec', 'shell-true', 'yaml-load', 'pickle-loads'];

/** The full weakness vocabulary, including command/crypto/temp-file classes. */
export const FULL_VOCABULARY: RulePatternKey[] = [
  'eval', 'exec', 'shell-true', 'yaml-load', 'pickle-loads', 'os-system', 'weak-hash', 'mktemp',
];

/** A detector genome: a set of weakness patterns the harness chose to cover. */
export interface DetectorGenome {
  id: string;
  parentId?: string;
  patterns: RulePatternKey[];
}

export interface ScoredDetector {
  genome: DetectorGenome;
  perFile: number[];
  mean: number;
  falsePositives: number;
}

export interface RealEvolveResult {
  available: boolean;
  version: string;
  champion: { patterns: RulePatternKey[]; mean: number; falsePositives: number };
  baseline: { patterns: RulePatternKey[]; mean: number; falsePositives: number };
  /** Best champion fitness per generation (the learning curve). */
  history: number[];
  /** Champion lineage (genome ids, baseline → champion). */
  lineage: string[];
  generations: number;
  evaluations: number;
  /** Real semgrep oracle calls actually made (≤ evaluations, thanks to caching). */
  oracleCalls: number;
  bootstrapVsBaseline: BootstrapResult;
  promotedOverBaseline: boolean;
  receiptHash: string;
  reason?: string;
}

export interface RealEvolveConfig {
  corpus: LabeledTarget;
  generations?: number;
  population?: number;
  seed?: number;
  /** Starting rule-set (default: a deliberately weak eval-only detector). */
  baseline?: RulePatternKey[];
  eliteFraction?: number;
  oracle?: SemgrepDetectorOracle;
  /** Weakness vocabulary to evolve over (default ALL_PATTERNS). */
  vocabulary?: RulePatternKey[];
}

const key = (p: RulePatternKey[]): string => [...new Set(p)].sort().join(',');

const mean = (xs: number[]): number => (xs.length ? round6(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

/** Toggle one pattern on/off — the bounded mutation operator (deterministic). */
function mutatePatterns(patterns: RulePatternKey[], rng: () => number, vocab: RulePatternKey[]): RulePatternKey[] {
  const set = new Set(patterns);
  const pick = vocab[Math.floor(rng() * vocab.length)];
  if (set.has(pick)) set.delete(pick);
  else set.add(pick);
  return vocab.filter((p) => set.has(p)); // canonical order
}

/**
 * Evolve a detector population with REAL Semgrep as the fitness oracle. Returns
 * the champion, learning curve, lineage, and a bootstrap certification vs the
 * baseline. Gracefully returns `available:false` when semgrep is absent.
 */
export function evolveDetectorsReal(cfg: RealEvolveConfig): RealEvolveResult {
  const oracle = cfg.oracle ?? new SemgrepDetectorOracle();
  const avail = oracle.availability();
  const empty: BootstrapResult = { meanDelta: 0, lower95: 0, upper95: 0, promote: false, samples: 0, pValue: 1 };
  if (!avail.available) {
    return {
      available: false, version: '', champion: { patterns: [], mean: 0, falsePositives: 0 },
      baseline: { patterns: [], mean: 0, falsePositives: 0 }, history: [], lineage: [], generations: 0,
      evaluations: 0, oracleCalls: 0, bootstrapVsBaseline: empty, promotedOverBaseline: false, receiptHash: '', reason: avail.reason,
    };
  }

  const corpus = cfg.corpus;
  const generations = cfg.generations ?? 5;
  const popSize = cfg.population ?? 6;
  const seed = cfg.seed ?? 0;
  const eliteFraction = cfg.eliteFraction ?? 0.34;
  const baselinePatterns = cfg.baseline ?? ['eval'];
  const vocab = cfg.vocabulary ?? ALL_PATTERNS;
  const rng = makeRng(seed);

  // OPTIMIZATION: one-shot per-pattern precompute. Semgrep rules match
  // INDEPENDENTLY, so a rule-set's detections are exactly the UNION of its
  // patterns' detections. We therefore run semgrep ONCE over the whole vocabulary,
  // bucket findings by rule-id (`ds-<pattern>`), and then score every candidate in
  // memory with zero further semgrep calls — identical results, O(1) oracle cost
  // instead of one invocation per evaluated rule-set.
  let oracleCalls = 0;
  const perPattern = new Map<RulePatternKey, Set<string>>();
  for (const p of vocab) perPattern.set(p, new Set<string>());
  if (vocab.length > 0) {
    oracleCalls += 1;
    for (const f of oracle.run(generateSemgrepRule(vocab), corpus.dir)) {
      const pat = f.ruleId.replace(/^ds-/, '') as RulePatternKey;
      perPattern.get(pat)?.add(f.path);
    }
  }

  // Fitness cache (cheap in-memory union scoring; cache avoids recomputation).
  const fitnessCache = new Map<string, { perFile: number[]; falsePositives: number }>();
  const score = (patterns: RulePatternKey[]): { perFile: number[]; falsePositives: number } => {
    const k = key(patterns);
    const cached = fitnessCache.get(k);
    if (cached) return cached;
    const detected = new Set<string>();
    for (const p of patterns) for (const file of perPattern.get(p) ?? []) detected.add(file);
    const perFile: number[] = [];
    let falsePositives = 0;
    for (const label of corpus.labels) {
      const hit = detected.has(label.file);
      if (label.vulnerable) perFile.push(hit ? 1 : 0);
      else {
        perFile.push(hit ? 0 : 1);
        if (hit) falsePositives += 1;
      }
    }
    const result = { perFile, falsePositives };
    fitnessCache.set(k, result);
    return result;
  };

  const toScored = (g: DetectorGenome): ScoredDetector => {
    const s = score(g.patterns);
    return { genome: g, perFile: s.perFile, mean: mean(s.perFile), falsePositives: s.falsePositives };
  };
  // Champion ranking: higher mean, then fewer patterns (parsimony), then lex.
  const better = (a: ScoredDetector, b: ScoredDetector): number =>
    b.mean - a.mean || a.genome.patterns.length - b.genome.patterns.length || key(a.genome.patterns).localeCompare(key(b.genome.patterns));

  const baseGenome: DetectorGenome = { id: 'baseline', patterns: [...new Set(baselinePatterns)].sort() as RulePatternKey[] };
  const baselineScored = toScored(baseGenome);

  // Initial population: baseline + seeded-random rule-sets. Intentionally sparse
  // (low inclusion probability) so the optimum is reached by EVOLUTION across
  // generations rather than handed out at init — a climbing curve is the evidence.
  let population: DetectorGenome[] = [baseGenome];
  for (let i = 1; i < popSize; i += 1) {
    const subset = vocab.filter(() => rng() < 0.2);
    population.push({ id: `g0-${i}`, parentId: 'baseline', patterns: subset });
  }

  const lineageParent = new Map<string, string>();
  let champion = baselineScored;
  const history: number[] = [];
  let evaluations = 0;
  const eliteCount = Math.max(1, Math.floor(popSize * eliteFraction));

  for (let gen = 0; gen < generations; gen += 1) {
    const scored = population.map((g) => {
      evaluations += 1;
      return toScored(g);
    });
    scored.sort(better);
    if (better(scored[0], champion) < 0) champion = scored[0];
    history.push(champion.mean);

    const elites = scored.slice(0, eliteCount).map((s) => s.genome);
    const next: DetectorGenome[] = [...elites];
    let idx = 0;
    while (next.length < popSize) {
      const parent = elites[idx % elites.length];
      const childPatterns = mutatePatterns(parent.patterns, rng, vocab);
      const child: DetectorGenome = { id: `g${gen + 1}-${next.length}`, parentId: parent.id, patterns: childPatterns };
      lineageParent.set(child.id, parent.id);
      next.push(child);
      idx += 1;
    }
    population = next;
  }

  // Certify the champion against the baseline with the paired seeded bootstrap.
  const boot = bootstrapDelta(baselineScored.perFile, champion.perFile, { seed });
  const promotedOverBaseline = boot.lower95 > 0 && champion.falsePositives <= baselineScored.falsePositives;

  // Lineage reconstruction.
  const lineage: string[] = [];
  let cur: string | undefined = champion.genome.id;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    lineage.unshift(cur);
    guard.add(cur);
    cur = lineageParent.get(cur);
  }
  if (lineage[0] !== 'baseline') lineage.unshift('baseline');

  const receiptHash = fnv1a(JSON.stringify({
    v: avail.version, champ: key(champion.genome.patterns), perFile: champion.perFile, fp: champion.falsePositives, history,
  })).toString(16).padStart(8, '0');

  return {
    available: true,
    version: avail.version,
    champion: { patterns: champion.genome.patterns, mean: champion.mean, falsePositives: champion.falsePositives },
    baseline: { patterns: baselineScored.genome.patterns, mean: baselineScored.mean, falsePositives: baselineScored.falsePositives },
    history,
    lineage,
    generations,
    evaluations,
    oracleCalls,
    bootstrapVsBaseline: boot,
    promotedOverBaseline,
    receiptHash,
  };
}
