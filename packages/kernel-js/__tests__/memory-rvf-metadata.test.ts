// SPDX-License-Identifier: MIT
//
// Per-vector metadata on the RVF backend (@ruvector/rvf >= 0.4.7, ruvector
// #704). The first block runs against the installed native store; the
// fallback block mocks an older @ruvector/rvf to check that the backend then
// behaves exactly as kernel 0.1.5 did.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRvfBackend, type RvfBackend } from '../src/memory-rvf.js';
import { rankWithDecay } from '../src/memory.js';

const DIM = 16;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function vectors(n: number, seed: number, dim = DIM): Float32Array[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => Float32Array.from({ length: dim }, () => r() * 2 - 1));
}

const dirs: string[] = [];
const backends: RvfBackend[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'kernel-rvf-meta-test-'));
  dirs.push(d);
  return d;
}
async function open(dir: string, dimensions = DIM): Promise<RvfBackend> {
  const b = await createRvfBackend({ dimensions, dir });
  expect(b).not.toBeNull();
  backends.push(b!);
  return b!;
}
afterEach(async () => {
  for (const b of backends.splice(0)) await b.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('memory-rvf metadata against an installed @ruvector/rvf >= 0.4.7', () => {
  it('stores storedAt and caller metadata, and both survive a reopen', async () => {
    const dir = freshDir();
    const [a, b] = vectors(2, 11);
    const w = await open(dir);
    expect(w.metadataSupported).toBe(true);
    const before = Date.now();
    await w.insert('a', a, 'notes', { storedAt: NOW - DAY, metadata: { source: 'chat', tags: ['x', 'y'], weight: 2.5 } });
    await w.insertBatch([{ id: 'b', embedding: b }], 'notes'); // storedAt defaults to now
    const after = Date.now();
    await w.close();

    const r = await open(dir);
    const [ha] = await r.search(a, 1, 'notes', { exact: true });
    expect(ha.id).toBe('a');
    expect(ha.storedAt).toBe(NOW - DAY);
    expect(ha.metadata).toEqual({ source: 'chat', tags: ['x', 'y'], weight: 2.5 });
    const [hb] = await r.search(b, 1, 'notes', { exact: true });
    expect(hb.id).toBe('b');
    expect(hb.storedAt).toBeGreaterThanOrEqual(before);
    expect(hb.storedAt).toBeLessThanOrEqual(after);
    expect(hb.metadata).toBeUndefined();
  });

  it('decay ranks an older near-duplicate below a newer one', async () => {
    const dir = freshDir();
    const [q, ...noise] = vectors(40, 12);
    const near = Float32Array.from(q, (x, i) => x + 0.02 * (noise[0][i]));
    const w = await open(dir);
    await w.insertBatch([
      { id: 'old-exact', embedding: q, storedAt: NOW - 30 * DAY },
      { id: 'new-near', embedding: near, storedAt: NOW - HOUR },
      ...noise.slice(1).map((embedding, i) => ({ id: `n${i}`, embedding, storedAt: NOW - 2 * DAY })),
    ]);
    await w.close();

    const r = await open(dir);
    const hits = await r.search(q, 5);
    // Raw similarity: the older exact copy wins.
    expect(hits.slice(0, 2).map(h => h.id)).toEqual(['old-exact', 'new-near']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);

    const decayed = await rankWithDecay(hits, { now: NOW, halfLifeMs: 7 * DAY });
    expect(decayed[0].id).toBe('new-near');
    expect(decayed.findIndex(h => h.id === 'old-exact')).toBeGreaterThan(0);
    // Without decay the raw order is kept.
    expect((await rankWithDecay(hits, { useDecay: false }))[0].id).toBe('old-exact');
  });

  it('filters on caller metadata and on storedAt', async () => {
    const dir = freshDir();
    const vs = vectors(30, 13);
    const w = await open(dir);
    await w.insertBatch(vs.map((embedding, i) => ({
      id: `m${i}`,
      embedding,
      storedAt: NOW - i * DAY,
      metadata: { source: i % 3 === 0 ? 'tool' : 'chat' },
    })));
    const tool = await w.search(vs[1], 30, 'default', { exact: true, filter: { op: 'eq', field: 'source', value: 'tool' } });
    expect(tool.map(h => h.id).sort()).toEqual(['m0', 'm12', 'm15', 'm18', 'm21', 'm24', 'm27', 'm3', 'm6', 'm9']);
    for (const h of tool) expect(h.metadata).toEqual({ source: 'tool' });

    const recent = await w.search(vs[1], 30, 'default', {
      exact: true,
      filter: { op: 'ge', field: 'storedAt', value: NOW - 4 * DAY },
    });
    expect(recent.map(h => h.id).sort()).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);

    const both = await w.search(vs[1], 30, 'default', {
      exact: true,
      filter: { op: 'and', exprs: [
        { op: 'eq', field: 'source', value: 'chat' },
        { op: 'lt', field: 'storedAt', value: NOW - 25 * DAY },
      ] },
    });
    expect(both.map(h => h.id).sort()).toEqual(['m26', 'm28', 'm29']);
  });

  it('rejects a metadata type conflict, a reserved key and a bad storedAt', async () => {
    const w = await open(freshDir());
    const [a, b] = vectors(2, 14);
    await w.insert('a', a, 'default', { metadata: { source: 'chat' } });
    const err = await w.insert('b', b, 'default', { metadata: { source: 7 } }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: number }).code).toBe(0xff09); // MetadataTypeConflict
    await expect(w.insert('b', b, 'default', { metadata: { storedAt: 1 } })).rejects.toThrow(/reserved/);
    await expect(w.insert('b', b, 'default', { storedAt: Number.NaN })).rejects.toThrow(/storedAt/);
    expect(await w.size()).toBe(1);
  });

  it('opens a store written by kernel 0.1.5 on @ruvector/rvf 0.4.6', async () => {
    // Fixture: kernel 0.1.5 + rvf 0.4.6 wrote 20 vectors (dim 8) to namespace
    // "legacy" with this generator, then deleted legacy-19.
    let s = 42;
    const r = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s / 4294967296) * 2 - 1; };
    const rows = Array.from({ length: 20 }, () => Array.from({ length: 8 }, r));
    const dir = freshDir();
    cpSync(fileURLToPath(new URL('./fixtures/rvf-0.4.6', import.meta.url)), dir, { recursive: true });

    const b = await open(dir, 8);
    expect(b.namespaces()).toEqual(['legacy']);
    expect(await b.size('legacy')).toBe(19);
    const [h] = await b.search(rows[3], 1, 'legacy', { exact: true });
    expect(h.id).toBe('legacy-3');
    expect(h.score).toBeCloseTo(1, 5);
    expect(h.storedAt).toBeUndefined();
    expect(h.metadata).toBeUndefined();
    const all = await b.search(rows[0], 20, 'legacy', { exact: true });
    expect(all.map(x => x.id)).not.toContain('legacy-19');

    const fresh = vectors(1, 15, 8)[0];
    await b.insert('new', fresh, 'legacy', { storedAt: NOW, metadata: { source: 'v016' } });
    await b.close();

    const again = await open(dir, 8);
    expect(await again.size('legacy')).toBe(20);
    const [hn] = await again.search(fresh, 1, 'legacy', { exact: true });
    expect(hn).toMatchObject({ id: 'new', storedAt: NOW, metadata: { source: 'v016' } });
    const [hl] = await again.search(rows[5], 1, 'legacy', { exact: true });
    expect(hl.id).toBe('legacy-5');
    expect(hl.storedAt).toBeUndefined();
  });
});

// ---- fallback: an @ruvector/rvf without per-vector metadata ----

interface FakeRow { id: string; vector: number[]; metadata?: Record<string, unknown> }

function fakeRvf(opts: { declaresTypeConflict: boolean }) {
  const ingested: FakeRow[][] = [];
  const stores = new Map<string, Map<string, number[]>>();
  const makeDb = (path: string) => {
    const store = stores.get(path) ?? new Map<string, number[]>();
    stores.set(path, store);
    return {
      async ingestBatch(rows: Array<{ id: string; vector: Float32Array; metadata?: Record<string, unknown> }>) {
        if (rows.some(x => x.metadata && Object.keys(x.metadata).length > 0)) {
          throw Object.assign(new Error('MetadataNotSupported'), { code: 0xff04 });
        }
        ingested.push(rows.map(x => ({ id: x.id, vector: [...x.vector], metadata: x.metadata })));
        for (const x of rows) store.set(x.id, [...x.vector]);
        return { accepted: rows.length, rejected: 0 };
      },
      async query(v: Float32Array, k: number) {
        return [...store].slice(0, k).map(([id]) => ({ id, distance: 0 }));
      },
      async delete(ids: string[]) { let n = 0; for (const id of ids) if (store.delete(id)) n++; return { deleted: n }; },
      async status() { return { totalVectors: store.size }; },
      async dimension() { return 4; },
      async close() {},
    };
  };
  const RvfErrorCode: Record<string, number> = { MetadataNotSupported: 0xff04 };
  if (opts.declaresTypeConflict) RvfErrorCode.MetadataTypeConflict = 0xff09;
  return {
    ingested,
    module: {
      RvfErrorCode,
      RvfDatabase: { create: async (p: string) => makeDb(p), open: async (p: string) => makeDb(p) },
    },
  };
}

describe('memory-rvf on an @ruvector/rvf without metadata support', () => {
  afterEach(() => {
    vi.doUnmock('@ruvector/rvf');
    vi.resetModules();
  });

  it('rvf 0.4.6 SDK: writes without metadata, hits carry no storedAt, nothing throws', async () => {
    const fake = fakeRvf({ declaresTypeConflict: false });
    vi.resetModules();
    vi.doMock('@ruvector/rvf', () => fake.module);
    const mod = await import('../src/memory-rvf.js');
    const b = (await mod.createRvfBackend({ dimensions: 4, dir: freshDir() }))!;
    expect(b.metadataSupported).toBe(false);
    await b.insert('a', [1, 0, 0, 0], 'default', { storedAt: NOW, metadata: { source: 'chat' } });
    expect(fake.ingested).toEqual([[{ id: 'a', vector: [1, 0, 0, 0], metadata: undefined }]]);
    const hits = await b.search([1, 0, 0, 0], 1);
    expect(hits).toEqual([{ id: 'a', score: 1, decayedScore: 1, distance: 0, namespace: 'default' }]);
    await expect(b.search([1, 0, 0, 0], 1, 'default', { filter: { op: 'eq', field: 'source', value: 'chat' } }))
      .rejects.toThrow(/0\.4\.7/);
    await b.close();
  });

  it('rvf 0.4.7 SDK on an old rvf-node: MetadataNotSupported is caught once and the write retried', async () => {
    const fake = fakeRvf({ declaresTypeConflict: true });
    vi.resetModules();
    vi.doMock('@ruvector/rvf', () => fake.module);
    const mod = await import('../src/memory-rvf.js');
    const b = (await mod.createRvfBackend({ dimensions: 4, dir: freshDir() }))!;
    expect(b.metadataSupported).toBe(true);
    await b.insertBatch([{ id: 'a', embedding: [1, 0, 0, 0], storedAt: NOW }, { id: 'b', embedding: [0, 1, 0, 0] }]);
    expect(b.metadataSupported).toBe(false);
    expect(fake.ingested.map(batch => batch.map(r => r.id))).toEqual([['a', 'b']]);
    await b.insert('c', [0, 0, 1, 0]);
    expect(fake.ingested.length).toBe(2);
    expect(await b.size('default')).toBe(3);
    for (const h of await b.search([1, 0, 0, 0], 3)) expect(h.storedAt).toBeUndefined();
    await b.close();
  });
});
