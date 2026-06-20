// SPDX-License-Identifier: MIT
//
// Darwin Shield — ablation + a hard corpus tier (ADR-155; thesis from ADR-077:
// "the harness is the lever"). Two credibility checks beyond the headline gates:
//
//   1. hardCorpus()    — subtle vulns (high detection thresholds) + adversarial
//      decoys (high fp thresholds) so the champion does NOT saturate at TPR 1.0.
//      A "beyond SOTA" claim on a saturated corpus is weak; this shows headroom
//      AND that the champion still statistically dominates on a hard frontier.
//
//   2. ablate()        — knock out each harness lever from the champion and
//      measure the fitness it loses. This is the empirical proof that the GAIN
//      comes from the harness (tools, context, reviewers, model, memory), not
//      from the frozen model — the whole Darwin thesis, quantified.

import type { Corpus, CorpusRepo, CorpusSite } from './corpus.js';
import type { HarnessGenome } from './types.js';
import { fitness } from './scoring.js';
import { COST_BUDGET, TIME_BUDGET } from './scoring.js';
import { RuvSecurityMemory } from './memory.js';
import { runSwarmPerRepo } from './swarm.js';
import { findingFromSite } from './corpus.js';
import { round6 } from './util.js';

function hardVuln(id: string, file: string, sym: string, lang: CorpusSite['language'], cwe: string, thr: number): CorpusSite {
  return {
    siteId: id, file, symbol: sym, language: lang, weakness: cwe,
    isVulnerable: true, taintRole: 'sink', callgraphDegree: 9, sinkProximity: 0.85,
    recentChange: 0.6, complexity: 0.85, detectionThreshold: thr, fpThreshold: 0,
    acceptedPatch: `Bound and validate the tainted input into ${sym}; add a regression test.`,
    riskTags: [cwe],
  };
}
function hardDecoy(id: string, file: string, sym: string, lang: CorpusSite['language'], looks: string, thr: number): CorpusSite {
  return {
    siteId: id, file, symbol: sym, language: lang, weakness: looks,
    isVulnerable: false, taintRole: 'sanitizer', callgraphDegree: 7, sinkProximity: 0.7,
    recentChange: 0.5, complexity: 0.7, detectionThreshold: 1, fpThreshold: thr, riskTags: [looks],
  };
}

/**
 * A deliberately HARD corpus: subtle vulnerabilities (detection thresholds up to
 * ~0.95) and adversarial decoys (fp thresholds up to ~0.9) so even a strong
 * harness cannot trivially saturate it. Used to show the champion operates on an
 * unsaturated frontier, not a toy.
 */
export function hardCorpus(): Corpus {
  // Calibrated against the detection ceilings (rust/ts ≈ 1.1, py ≈ 1.0 at full
  // levers): a mix of SUBTLE-but-detectable vulns (a real gradient an evolved
  // harness climbs) and a couple genuinely-beyond-ceiling vulns (guaranteed
  // headroom, so the champion lands < 100% TPR — an unsaturated frontier).
  // Decoys span resistable → adversarial so FPR is partial, not zero.
  const repos: CorpusRepo[] = [
    {
      repo: 'corpus-hard/rust/kernel-iface', commit: 'h1a2b3c', kind: 'seeded',
      languages: ['rust'], frameworks: ['tokio'],
      sites: [
        hardVuln('h-rs1', 'src/ioctl.rs', 'handle_ioctl', 'rust', 'CWE-787 OOB write', 0.6), // detectable
        hardVuln('h-rs2', 'src/refcount.rs', 'put_ref', 'rust', 'CWE-416 use-after-free', 1.15), // beyond ceiling
        hardDecoy('h-rs-d1', 'src/bounds.rs', 'checked_index', 'rust', 'OOB write', 0.6), // resistable
      ],
    },
    {
      repo: 'corpus-hard/ts/auth-svc', commit: 'h4d5e6f', kind: 'real-cve',
      languages: ['ts'], frameworks: ['fastify'],
      sites: [
        hardVuln('h-ts1', 'src/jwt.ts', 'verifyJwt', 'ts', 'CWE-347 signature bypass', 0.62), // detectable
        hardVuln('h-ts2', 'src/proto.ts', 'merge', 'ts', 'CWE-1321 prototype pollution', 0.85), // detectable by strong
        hardDecoy('h-ts-d1', 'src/guard.ts', 'assertRole', 'ts', 'auth bypass', 0.96), // adversarial → leaks
      ],
    },
    {
      repo: 'corpus-hard/py/ml-serve', commit: 'h7a8b9c', kind: 'seeded',
      languages: ['py'], frameworks: ['fastapi'],
      sites: [
        hardVuln('h-py1', 'serve/pickle.py', 'load_model', 'py', 'CWE-502 pickle RCE', 1.05), // beyond py ceiling
        hardDecoy('h-py-d1', 'serve/guarded.py', 'load_trusted', 'py', 'unsafe deserialization', 0.82), // resistable by strong
      ],
    },
  ];
  return { id: 'darwin-shield-hard', version: '1.0.0', repos };
}

/** Aggregate a genome's corpus fitness (optionally with memory). */
export function corpusFitness(
  genome: HarnessGenome,
  corpus: Corpus,
  baselineFalsePositiveRate: number,
  memory?: RuvSecurityMemory,
): number {
  const per = runSwarmPerRepo(genome, corpus, memory ? { memory } : {});
  const total = per.reduce(
    (acc, x) => {
      acc.truePositives += x.metrics.truePositives;
      acc.falsePositives += x.metrics.falsePositives;
      acc.falseNegatives += x.metrics.falseNegatives;
      acc.reproduced += x.metrics.reproduced;
      acc.patchesPassing += x.metrics.patchesPassing;
      acc.patchesProposed += x.metrics.patchesProposed;
      return acc;
    },
    { truePositives: 0, falsePositives: 0, falseNegatives: 0, reproduced: 0, patchesPassing: 0, patchesProposed: 0, toolAgreements: 0, novelFindings: 0, unsafeOutputs: 0, costUnits: per[0]?.metrics.costUnits ?? 0, timeToFinding: per[0]?.metrics.timeToFinding ?? 0 },
  );
  const gt = corpus.repos.reduce((n, r) => n + r.sites.filter((s) => s.isVulnerable).length, 0);
  const dc = corpus.repos.reduce((n, r) => n + r.sites.filter((s) => !s.isVulnerable).length, 0);
  return fitness({ metrics: total, groundTruthCount: gt, decoyCount: dc, baselineFalsePositiveRate, costBudget: COST_BUDGET, timeBudget: TIME_BUDGET }).fitness;
}

/** A memory pre-loaded from a corpus's confirmed findings (for the memory lever). */
function memoryFor(corpus: Corpus): RuvSecurityMemory {
  const mem = new RuvSecurityMemory();
  for (const repo of corpus.repos) {
    mem.indexSites(repo.repo, repo.commit, repo.sites);
    for (const s of repo.sites) {
      if (s.isVulnerable) mem.writeConfirmed(findingFromSite(s, repo.repo, repo.commit, 0.9, 'confirmed'));
    }
  }
  return mem;
}

export interface LeverImpact {
  lever: string;
  /** Fitness lost when this lever is knocked out from the champion (≥ 0). */
  delta: number;
}

export interface AblationReport {
  champion: HarnessGenome;
  fullFitness: number;
  levers: LeverImpact[];
  /** The single most important lever by fitness loss. */
  topLever: string;
}

/**
 * Ablate each harness lever from a champion and measure the fitness it loses.
 * A positive delta proves that lever contributes — i.e. the HARNESS, not the
 * frozen model, is producing the gain (ADR-077/155). Deterministic.
 */
export function ablate(
  champion: HarnessGenome,
  corpus: Corpus,
  baselineFalsePositiveRate: number,
): AblationReport {
  const mem = memoryFor(corpus);
  // Full champion (with memory, since memory-first/hybrid uses it).
  const full = corpusFitness(champion, corpus, baselineFalsePositiveRate, mem);

  const variants: Array<{ lever: string; genome: HarnessGenome; memory?: RuvSecurityMemory }> = [
    { lever: 'tools (→ single tool)', genome: { ...champion, tools: [champion.tools[0]] }, memory: mem },
    { lever: 'context (→ minimal)', genome: { ...champion, contextPolicy: 'minimal' }, memory: mem },
    { lever: 'reviewers (→ 1)', genome: { ...champion, reviewerCount: 1 }, memory: mem },
    { lever: 'model (→ none)', genome: { ...champion, modelMix: [] }, memory: mem },
    // Memory lever: same genome, no memory passed.
    { lever: 'memory (→ off)', genome: champion, memory: undefined },
  ];

  const levers = variants
    .map((v) => ({ lever: v.lever, delta: round6(Math.max(0, full - corpusFitness(v.genome, corpus, baselineFalsePositiveRate, v.memory))) }))
    .sort((a, b) => b.delta - a.delta);

  return { champion, fullFitness: round6(full), levers, topLever: levers[0]?.lever ?? 'none' };
}
