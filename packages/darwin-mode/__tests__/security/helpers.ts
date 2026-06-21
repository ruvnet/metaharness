// SPDX-License-Identifier: MIT
//
// Test helpers for the Darwin Shield ruVector compounding acceptance. Builds a
// corpus with a "tricky" decoy whose false-positive threshold is above what
// reviewers + tools + context can resist alone — only NEGATIVE MEMORY (having
// seen a similar false positive before) crosses it. This isolates the compounding
// value of ruVector memory (ADR-155 §evolution advantage).

import type { Corpus, CorpusRepo } from '../../src/security/corpus.js';
import { RuvSecurityMemory } from '../../src/security/memory.js';
import { runSwarm } from '../../src/security/swarm.js';
import type { HarnessGenome, RunMetrics } from '../../src/security/types.js';

function strongGenome(): HarnessGenome {
  return {
    id: 'strong',
    parentId: 'baseline',
    planner: 'memory-first',
    contextPolicy: 'hybrid',
    reviewerCount: 5,
    retryBudget: 6,
    fuzzBudgetSeconds: 300,
    tools: ['semgrep', 'codeql', 'osv-scanner', 'trivy', 'npm-audit'],
    modelMix: ['claude'],
    validationPipeline: ['static', 'fuzz', 'repro-test', 'review'],
    safetyProfile: 'strict-defensive',
  };
}

/** A one-repo corpus carrying a single tricky decoy (fpThreshold above 0.9). */
function trickyCorpus(): { corpus: Corpus; trickyText: string } {
  const repo: CorpusRepo = {
    repo: 'corpus/ts/tricky',
    commit: 'deadbee',
    kind: 'clean',
    languages: ['ts'],
    frameworks: [],
    sites: [
      {
        siteId: 'tricky-d1',
        file: 'src/normalize.ts',
        symbol: 'normalizePath',
        language: 'ts',
        weakness: 'path traversal',
        isVulnerable: false,
        taintRole: 'sanitizer',
        callgraphDegree: 4,
        sinkProximity: 0.5,
        recentChange: 0.4,
        complexity: 0.5,
        detectionThreshold: 1,
        fpThreshold: 0.95, // beyond reviewers+tools+context alone
        riskTags: ['path traversal'],
      },
    ],
  };
  return {
    corpus: { id: 'tricky', version: '1.0.0', repos: [repo] },
    trickyText: 'path traversal normalizePath src/normalize.ts path traversal',
  };
}

export interface MemoryAdvantage {
  withoutMemory: RunMetrics;
  withMemory: RunMetrics;
}

/**
 * Run the strong harness on the tricky corpus twice: once memoryless, once with
 * a pre-recorded false positive for the same pattern. With negative memory the
 * decoy is resisted; without it, the decoy leaks as a false positive.
 */
export function strongMemoryAdvantage(_seedCorpus: Corpus): MemoryAdvantage {
  const { corpus, trickyText } = trickyCorpus();
  const g = strongGenome();

  const withoutMemory = runSwarm(g, corpus, 'no-mem', {}).metrics;

  const mem = new RuvSecurityMemory();
  mem.writeFalsePositive({
    id: 'prior-fp',
    repo: 'corpus/ts/other',
    commit: 'cafef00',
    file: 'src/normalize.ts',
    symbol: 'normalizePath',
    weakness: 'path traversal',
    confidence: 0.4,
    evidence: [trickyText],
    verdict: 'false_positive',
    exploitCodeAllowed: false,
  });
  const withMemory = runSwarm(g, corpus, 'mem', { memory: mem }).metrics;

  return { withoutMemory, withMemory };
}
