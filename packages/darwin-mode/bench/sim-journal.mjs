// SPDX-License-Identifier: MIT
// Synthetic persistence microbenchmark, not a model-performance claim.
// Run: npm run bench:sim-journal -w @metaharness/darwin
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SimMemory } from '../dist/sim-memory.js';
import { SimJournal } from '../dist/sim-journal.js';

const count = Math.min(2000, Math.max(10, Number(process.env.SIM_BENCH_RECORDS || 500)));
const scope = { ownerId: 'bench-owner', repoId: 'bench-repo', interfaceId: 'darwin-v1',
  modelId: 'model', benchmarkId: 'benchmark', harnessVersion: 'v1' };
const row = (id) => ({
  id: 'id-' + id, createdAt: '2026-11-20T00:00:00.000Z', scope,
  problemKey: 'timeout', diagnosis: 'synthetic timeout', variantId: 'variant-' + id,
  parentId: 'baseline', mutationSurface: 'retryPolicy', rationale: 'bounded retry',
  predictedDelta: null, observedDelta: -0.02, finalScore: 0.4, promoted: false,
  evidenceIds: ['fixture:' + id],
});
const root = await mkdtemp(join(tmpdir(), 'sim-journal-bench-'));
try {
  const outputs = [];
  for (const [name, store] of [
    ['snapshot', new SimMemory(join(root, 'snapshot.json'))],
    ['journal_fsync', new SimJournal(join(root, 'journal.jsonl'))],
  ]) {
    await store.load();
    const start = performance.now();
    for (let i = 0; i < count; i++) await store.append(row(i));
    const elapsed = performance.now() - start;
    const replayStart = performance.now();
    const reloaded = name === 'snapshot'
      ? new SimMemory(store.filePath) : new SimJournal(store.filePath);
    await reloaded.load();
    const replayMs = performance.now() - replayStart;
    if (reloaded.all().length !== count) throw new Error('benchmark: replay count mismatch');
    outputs.push({ mode: name, records: count, appendMs: +elapsed.toFixed(2),
      recordsPerSecond: +(count * 1000 / elapsed).toFixed(1), replayMs: +replayMs.toFixed(2) });
  }
  console.log(JSON.stringify({
    kind: 'synthetic_local_disk_persistence_not_model_performance',
    count, durablePerRecord: true, singleProcess: true,
    results: outputs, speedup: +(outputs[1].recordsPerSecond / outputs[0].recordsPerSecond).toFixed(2),
  }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
