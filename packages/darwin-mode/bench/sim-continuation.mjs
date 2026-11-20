// SPDX-License-Identifier: MIT
// Offline, synthetic retrieval ablation ONLY. Not a held-out RSI score claim.
// Run: npm run bench:sim -w @metaharness/darwin
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SimMemory, indexSimAttempt } from '../dist/sim-memory.js';
import { openRvfSimIndex } from '../dist/sim-rvf.js';

const problems = ['completion', 'retry', 'routing', 'context'];
const seed = 17;
const scope = {
  ownerId: 'synthetic-test-owner', repoId: 'synthetic/optimizer', interfaceId: 'darwin-v1',
  modelId: 'source-model', benchmarkId: 'source-task', harnessVersion: 'fixture-1',
};
const inputs = [];
for (let n = 0; n < 40; n++) {
  const topic = problems[n % problems.length];
  inputs.push({
    id: 'fixture-' + n,
    createdAt: new Date(Date.UTC(2026, 10, 20, 0, 0, n)).toISOString(),
    scope, problemKey: topic,
    diagnosis: topic + ' harness weakness',
    variantId: 'v' + n, parentId: 'v' + Math.max(0, n - 1),
    mutationSurface: topic === 'routing' ? 'toolPolicy' : 'reviewer',
    rationale: topic + ' optimization attempt and diagnostic',
    predictedDelta: null, observedDelta: n % 3 ? -0.01 : 0.02,
    finalScore: 0.4 + n / 1000, promoted: n % 3 === 0,
    evidenceIds: ['fixture:' + n],
  });
}
const hash = createHash('sha256').update(JSON.stringify({ seed, inputs })).digest('hex');
const embedder = {
  async embed(text) {
    const out = problems.map((p) => text.toLowerCase().includes(p) ? 1 : 0);
    return out.some(Boolean) ? out : [0.01, 0.01, 0.01, 0.01];
  },
};
const root = await mkdtemp(join(tmpdir(), 'metaharness-sim-ablation-'));
let index = null;
try {
  const store = new SimMemory(join(root, 'sim.json'));
  await store.load();
  for (const input of inputs) await store.append(input);
  index = await openRvfSimIndex(join(root, 'experiences.rvf'), problems.length);
  if (index) {
    for (const record of store.all()) await indexSimAttempt(record, embedder, index);
  }

  async function arm(name, mode) {
    const started = performance.now();
    let totalCorrect = 0, totalSelected = 0, totalTokens = 0;
    for (const problem of problems) {
      // Target model and benchmark change, but the executable interface remains compatible.
      const query = {
        scope: { ...scope, modelId: 'target-model', benchmarkId: 'target-task' },
        mode, query: problem, maxTokens: 320,
        embedder: index ? embedder : undefined, vectorIndex: index ?? undefined,
      };
      const context = mode ? await store.context(query) : {
        records: [], estimatedTokens: 0, retrieval: 'none',
      };
      totalTokens += context.estimatedTokens;
      totalSelected += context.records.length;
      totalCorrect += context.records.filter((r) => r.problemKey === problem).length;
    }
    return {
      arm: name,
      retrievalProvider: mode === 'retrieval' ? (index ? 'native_rvf' : 'lexical_fallback') : 'none',
      relevantSelected: totalCorrect,
      allSelected: totalSelected,
      precision: totalSelected ? Number((totalCorrect / totalSelected).toFixed(4)) : null,
      recallAtContextBudget: Number((totalCorrect / inputs.length).toFixed(4)),
      meanApproxTokens: Math.round(totalTokens / problems.length),
      meanRetrievalLatencyMs: Number(((performance.now() - started) / problems.length).toFixed(3)),
    };
  }
  const results = [
    await arm('harness_only', null),
    await arm('structured_SIM', 'full'),
    await arm('SIM_with_retrieval', 'retrieval'),
  ];
  console.log(JSON.stringify({
    kind: 'synthetic_retrieval_ablation_not_model_performance',
    seed, fixtureSha256: hash, totalExperiences: inputs.length,
    queries: problems, fixedContextTokenBudget: 320,
    heldoutModelScores: 'NOT_MEASURED',
    results,
  }, null, 2));
} finally {
  if (index) await index.close();
  await rm(root, { recursive: true, force: true });
}
