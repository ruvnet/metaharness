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

  // Labels stay with the scorer. These paired queries deliberately omit them.
  const masked = [
    'the agent stopped before delivering the requested artifact',
    'the worker repeated a failed operation without making progress',
    'the dispatcher selected the wrong specialist',
    'earlier instructions were lost as the conversation grew',
  ];
  if (masked.length !== problems.length || masked.some(q => problems.some(p => q.includes(p)))) {
    throw new Error('masked query contains a fixture label or has no paired label');
  }

  async function arm(name, mode, queries, native = false) {
    const started = performance.now();
    let totalCorrect = 0, totalSelected = 0, totalTokens = 0;
    for (const [i, problem] of problems.entries()) {
      // Target model and benchmark change, but the executable interface remains compatible.
      const query = {
        scope: { ...scope, modelId: 'target-model', benchmarkId: 'target-task' },
        mode, query: queries[i], maxTokens: 320,
        embedder: native ? embedder : undefined, vectorIndex: native ? index : undefined,
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
      retrievalProvider: mode === 'retrieval' ? (native ? 'native_rvf' : 'lexical') : 'none',
      relevantSelected: totalCorrect,
      allSelected: totalSelected,
      precision: totalSelected ? Number((totalCorrect / totalSelected).toFixed(4)) : null,
      recallAtContextBudget: Number((totalCorrect / inputs.length).toFixed(4)),
      meanApproxTokens: Math.round(totalTokens / problems.length),
      meanRetrievalLatencyMs: Number(((performance.now() - started) / problems.length).toFixed(3)),
    };
  }
  const results = [];
  for (const [querySet, queries] of [['label_present', problems], ['label_absent', masked]]) {
    const arms = [
      await arm('harness_only', null, queries),
      await arm('structured_SIM', 'full', queries),
      await arm('lexical_only', 'retrieval', queries),
    ];
    if (index) arms.push(await arm('SIM_with_retrieval', 'retrieval', queries, true));
    for (const result of arms) results.push({ querySet, ...result });
  }
  console.log(JSON.stringify({
    kind: 'synthetic_retrieval_ablation_not_model_performance',
    seed, fixtureSha256: hash, totalExperiences: inputs.length,
    querySets: { label_present: problems, label_absent: masked }, nativeAvailable: Boolean(index), fixedContextTokenBudget: 320,
    heldoutModelScores: 'NOT_MEASURED',
    results,
  }, null, 2));
} finally {
  if (index) await index.close();
  await rm(root, { recursive: true, force: true });
}
