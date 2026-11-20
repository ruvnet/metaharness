// SPDX-License-Identifier: MIT
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SimMemory, indexSimAttempt } from '../src/sim-memory.js';
import type { SimAttemptInput, SimScope, SimVectorIndex } from '../src/sim-memory.js';
import { openRvfSimIndex } from '../src/sim-rvf.js';

const dirs: string[] = [];
const scope: SimScope = {
  ownerId: 'tenant-A', repoId: 'ruvnet/metaharness', interfaceId: 'darwin-v1',
  modelId: 'model-a', benchmarkId: 'coding-a', harnessVersion: '0.14.0',
};
async function store(): Promise<SimMemory> {
  const root = await mkdtemp(join(tmpdir(), 'metaharness-sim-'));
  dirs.push(root);
  const result = new SimMemory(join(root, 'sim.json'));
  await result.load();
  return result;
}
function attempt(id: string, overrides: Partial<SimAttemptInput> = {}): SimAttemptInput {
  return {
    id, createdAt: '2026-11-20T00:00:00.000Z',
    scope: { ...scope }, problemKey: 'completion-check',
    diagnosis: 'Stopped early before verified deliverable',
    variantId: 'v-' + id, parentId: 'baseline',
    mutationSurface: 'reviewer', rationale: 'Check the submitted output after execution',
    predictedDelta: null, observedDelta: -0.15, finalScore: 0.53, promoted: false,
    evidenceIds: ['archive:v-' + id], ...overrides,
  };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SIM opt-in optimizer experience memory', () => {
  it('persists and reloads a hash linked negative experience without losing its evidence', async () => {
    const db = await store();
    const first = await db.append(attempt('failure'));
    const second = await db.append(attempt('success', {
      observedDelta: 0.2, finalScore: 0.88, promoted: true, predictedDelta: 0.1,
    }));
    expect(first.promoted).toBe(false);
    expect(first.observedDelta).toBe(-0.15);
    expect(second.previousHash).toBe(first.hash);
    const again = new SimMemory(db.filePath);
    await again.load();
    expect(again.all().map((x) => x.id)).toEqual(['failure', 'success']);
    expect(again.all()[0].evidenceIds).toEqual(['archive:v-failure']);
    const all = await again.context({ scope, query: 'completion', mode: 'full', maxTokens: 500 });
    expect(all.records.some((x) => x.observedDelta < 0)).toBe(true);
    expect(all.context).toContain('UNTRUSTED');
  });

  it('rejects corruption in persisted evidence and duplicate IDs', async () => {
    const db = await store();
    await db.append(attempt('first'));
    await expect(db.append(attempt('first'))).rejects.toThrow(/duplicate/);
    const original = await readFile(db.filePath, 'utf8');
    await writeFile(db.filePath, original.replace('-0.15', '0.99'));
    await expect(new SimMemory(db.filePath).load()).rejects.toThrow(/hash mismatch/);
  });

  it('rejects malformed records, invalid predictions, NaN scores, and invalid timestamps', async () => {
    const db = await store();
    await expect(db.append(attempt('x', { predictedDelta: Infinity }))).rejects.toThrow();
    await expect(db.append(attempt('y', { observedDelta: Number.NaN }))).rejects.toThrow();
    await expect(db.append(attempt('z', { createdAt: 'not-a-date' }))).rejects.toThrow();
    await expect(db.append(attempt('f', { evidenceIds: Array(25).fill('x') }))).rejects.toThrow();
    expect(db.all()).toEqual([]);
  });

  it('serializes concurrent appends without loss or forked hash chains', async () => {
    const db = await store();
    await Promise.all(Array.from({ length: 12 }, (_, i) => db.append(attempt('r' + i))));
    const reloaded = new SimMemory(db.filePath);
    await reloaded.load();
    expect(reloaded.all()).toHaveLength(12);
    const chain = reloaded.all();
    expect(chain.every((item, i) => item.previousHash === (i ? chain[i - 1].hash : null))).toBe(true);
  });

  it('recalls compatible model transitions, but never crosses owner or interface', async () => {
    const db = await store();
    await db.append(attempt('same'));
    await db.append(attempt('other-owner', { scope: { ...scope, ownerId: 'tenant-B' } }));
    await db.append(attempt('other-interface', { scope: { ...scope, interfaceId: 'incompatible-v2' } }));
    await db.append(attempt('other-repo', { scope: { ...scope, repoId: 'other/repo' } }));
    const target = { ...scope, modelId: 'model-b', benchmarkId: 'coding-b' };
    const local = await db.select({ scope: target, query: 'completion check reviewer', mode: 'retrieval' });
    expect(local.records.map((r) => r.id)).toEqual(['same']);
    const transferable = await db.select({ scope: target, query: 'completion check reviewer', mode: 'retrieval', allowCrossRepo: true });
    expect(transferable.records.map((r) => r.id).sort()).toEqual(['other-repo', 'same']);
    expect(transferable.retrieval).toBe('lexical');
  });

  it('scope-filters even malicious vector hits and stores explicit regressions', async () => {
    const db = await store();
    const valid = await db.append(attempt('valid'));
    await db.append(attempt('foreign', { scope: { ...scope, ownerId: 'other' } }));
    const ids: string[] = [];
    const index: SimVectorIndex = {
      async upsert(id) { ids.push(id); },
      async search() { return [{ id: 'foreign', score: 1 }, { id: 'valid', score: 0.7 }]; },
    };
    const embedder = { async embed() { return [0.6, 0.8]; } };
    await indexSimAttempt(valid, embedder, index);
    expect(ids).toEqual(['valid']);
    const selected = await db.context({
      scope, query: 'completion check', mode: 'retrieval', maxTokens: 512, embedder, vectorIndex: index,
    });
    expect(selected.retrieval).toBe('vector');
    expect(selected.records.map((x) => x.id)).toEqual(['valid']);
    expect(selected.context).toContain('observedDelta');
    expect(selected.context).not.toContain('foreign');
  });

  it('enforces bounded optimizer context without truncating a JSON experience', async () => {
    const db = await store();
    for (let i = 0; i < 10; i++) await db.append(attempt('m' + i));
    const result = await db.context({ scope, query: 'completion', mode: 'full', maxTokens: 120 });
    expect(result.estimatedTokens).toBeLessThanOrEqual(120);
    expect(result.records.length).toBeLessThan(10);
    expect(result.context).toContain('UNTRUSTED');
    const handoff = await db.rufloHandoff({ scope, query: 'completion', mode: 'retrieval', maxTokens: 256 });
    expect(handoff).toMatchObject({ schema: 'metaharness.sim.handoff.v1', audience: 'harness_optimizer' });
  });

  it('enforces exact small token budgets and rejects invalid budgets before embedding', async () => {
    const db = await store();
    await db.append(attempt('tiny'));
    const tiny = await db.context({ scope, query: 'completion', mode: 'retrieval', maxTokens: 1 });
    expect(tiny.estimatedTokens).toBeLessThanOrEqual(1);
    expect(tiny.records).toEqual([]);
    let embedCalls = 0;
    const embedder = { async embed() { embedCalls++; return [1, 0]; } };
    const vectorIndex: SimVectorIndex = { async upsert() {}, async search() { return []; } };
    for (const bad of [0, -1, 4001, 1.5, Number.NaN]) {
      await expect(db.context({ scope, query: 'completion', mode: 'retrieval',
        maxTokens: bad, embedder, vectorIndex })).rejects.toThrow(/maxTokens/);
    }
    expect(embedCalls).toBe(0);
  });

  it('skips oversized records to pack shorter relevant evidence', async () => {
    const db = await store();
    await db.append(attempt('short', { rationale: 'fix' }));
    await db.append(attempt('long', { rationale: 'verbose '.repeat(400) }));
    const result = await db.context({ scope, query: 'completion', mode: 'full', maxTokens: 160 });
    expect(result.records.map((x) => x.id)).toContain('short');
    expect(result.records.map((x) => x.id)).not.toContain('long');
    expect(result.estimatedTokens).toBeLessThanOrEqual(160);
  });

  it('rejects malformed query scopes and nonfinite query vectors before searching', async () => {
    const db = await store();
    await db.append(attempt('query'));
    await expect(db.select({ scope: { ...scope, ownerId: '' }, query: 'completion', mode: 'retrieval' }))
      .rejects.toThrow(/scope.ownerId/);
    let searched = false;
    const embedder = { async embed() { return [Number.NaN]; } };
    const vectorIndex: SimVectorIndex = {
      async upsert() {}, async search() { searched = true; return []; },
    };
    await expect(db.select({ scope, query: 'completion', mode: 'retrieval', embedder, vectorIndex }))
      .rejects.toThrow(/embedding/);
    expect(searched).toBe(false);
  });

  it('uses the journal backend through the same Darwin memory interface', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sim-journal-adapter-'));
    dirs.push(root);
    const path = join(root, 'optimizer.jsonl');
    const memory = new SimMemory(path, { persistence: 'journal' });
    await memory.load();
    await memory.append(attempt('regression', { observedDelta: -0.4 }));
    await memory.append(attempt('improvement', { observedDelta: 0.2, promoted: true }));
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    const restored = new SimMemory(path, { persistence: 'journal' });
    await restored.load();
    expect(restored.all().map((x) => x.id)).toEqual(['regression', 'improvement']);
    const selected = await restored.context({ scope, mode: 'retrieval', query: 'completion', maxTokens: 512 });
    expect(selected.records.some((x) => x.observedDelta < 0)).toBe(true);
  });

  it('uses real RVF when the optional SDK is installed, with a writable persistent index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metaharness-sim-rvf-'));
    dirs.push(root);
    const index = await openRvfSimIndex(join(root, 'sim.rvf'), 2);
    if (index === null) return; // bare-install optional-dependency fallback; see ADR.
    try {
      await index.upsert('record-a', [1, 0]);
      await index.upsert('record-b', [0, 1]);
      const hits = await index.search([1, 0], 2);
      expect(hits[0].id).toBe('record-a');
      await expect(index.upsert('bad', [1])).rejects.toThrow(/vector/);
    } finally { await index.close?.(); }
  });
});
