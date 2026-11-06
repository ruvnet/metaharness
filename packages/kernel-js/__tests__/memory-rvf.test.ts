// SPDX-License-Identifier: MIT
//
// Real-import tests: @ruvector/rvf is a devDependency of kernel-js, so these
// run against the actual native RVF store, write to disk, reopen and compare
// against brute force. The fallback path (rvf absent) is tested by mocking
// the import to fail.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRvfBackend, isRvfAvailable, type RvfBackend } from '../src/memory-rvf.js';

const DIM = 32;

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

function vectors(n: number, seed: number): Float32Array[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => Float32Array.from({ length: DIM }, () => r() * 2 - 1));
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
}

function bruteTopK(q: Float32Array, data: Map<string, Float32Array>, k: number): string[] {
  return [...data].map(([id, v]) => [id, cosine(q, v)] as const)
    .sort((x, y) => y[1] - x[1]).slice(0, k).map(([id]) => id);
}

const dirs: string[] = [];
const backends: RvfBackend[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'kernel-rvf-test-'));
  dirs.push(d);
  return d;
}
async function open(dir: string): Promise<RvfBackend> {
  const b = await createRvfBackend({ dimensions: DIM, dir });
  expect(b).not.toBeNull();
  backends.push(b!);
  return b!;
}

afterEach(async () => {
  for (const b of backends.splice(0)) await b.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('memory-rvf against an installed @ruvector/rvf', () => {
  it('rvf is installed and usable', async () => {
    expect(await isRvfAvailable()).toBe(true);
  });

  it('stores N items, reopens from disk, and recalls the correct top-k', async () => {
    const dir = freshDir();
    const N = 600;
    const vs = vectors(N, 1);
    const data = new Map(vs.map((v, i) => [`mem-${i}`, v] as const));

    const w = await open(dir);
    await w.insertBatch([...data].map(([id, embedding]) => ({ id, embedding })));
    await w.insert('single', vs[0]);
    expect(await w.size()).toBe(N + 1);
    await w.close();

    const r = await open(dir);
    expect(await r.size()).toBe(N + 1);
    expect(r.namespaces()).toEqual(['default']);
    data.set('single', vs[0]);

    let hnswHits = 0;
    const queries = vectors(40, 2);
    for (const q of queries) {
      const truth = bruteTopK(q, data, 10);
      const exact = await r.search(q, 10, 'default', { exact: true });
      expect(exact.map(h => h.id)).toEqual(truth);
      for (const h of exact) {
        expect(h.score).toBeCloseTo(cosine(q, data.get(h.id)!), 4);
        expect(typeof h.storedAt).toBe('number');
        expect(h.namespace).toBe('default');
      }
      const approx = await r.search(q, 10);
      hnswHits += approx.filter(h => truth.includes(h.id)).length;
    }
    // HNSW is approximate; at N=600 it should be near-exact.
    expect(hnswHits / (queries.length * 10)).toBeGreaterThanOrEqual(0.9);

    // A stored vector's nearest neighbour is itself.
    const self = await r.search(vs[123], 1);
    expect(self[0].id).toBe('mem-123');
    expect(self[0].score).toBeCloseTo(1, 5);
  });

  it('delete and upsert persist across reopen', async () => {
    const dir = freshDir();
    const vs = vectors(50, 3);
    const w = await open(dir);
    await w.insertBatch(vs.map((embedding, i) => ({ id: `m${i}`, embedding })));
    expect(await w.delete(['m7', 'missing'])).toBe(1);
    const moved = vectors(1, 4)[0];
    await w.insert('m8', moved);
    await w.close();

    const r = await open(dir);
    expect(await r.size()).toBe(49);
    expect((await r.search(vs[7], 50, 'default', { exact: true })).map(h => h.id)).not.toContain('m7');
    expect((await r.search(moved, 1))[0].id).toBe('m8');
    expect((await r.search(vs[8], 1, 'default', { exact: true }))[0].id).not.toBe('m8');
  });

  it('keeps namespaces separate, one file each', async () => {
    const dir = freshDir();
    const [a, b] = vectors(2, 5);
    const w = await open(dir);
    await w.insert('x', a, 'alpha');
    await w.insert('y', b, 'beta');
    expect(w.namespaces()).toEqual(['alpha', 'beta']);
    expect(existsSync(join(dir, 'alpha.rvf'))).toBe(true);
    expect((await w.search(a, 5, 'beta')).map(h => h.id)).toEqual(['y']);
    expect(await w.search(a, 5, 'never-written')).toEqual([]);
    expect(await w.size('alpha')).toBe(1);
    expect(await w.size()).toBe(2);
    expect(existsSync(join(dir, 'never-written.rvf'))).toBe(false);
  });

  it('rejects bad input instead of storing it', async () => {
    const w = await open(freshDir());
    await expect(w.insert('a', [1, 2, 3])).rejects.toThrow(/dims/);
    await expect(w.insert('a', new Float32Array(DIM).fill(NaN))).rejects.toThrow(/finite/);
    await expect(w.insert('a', vectors(1, 6)[0], '../escape')).rejects.toThrow(/namespace/);
    await expect(w.search(vectors(1, 6)[0], 0)).rejects.toThrow(/k must/);
  });

  it('refuses a dimension mismatch and a second writer on the same file', async () => {
    const dir = freshDir();
    const w = await open(dir);
    await w.insert('a', vectors(1, 7)[0]);
    const second = await open(dir);
    await expect(second.insert('b', vectors(1, 8)[0])).rejects.toThrow();
    await w.close();
    const other = await createRvfBackend({ dimensions: DIM + 1, dir });
    backends.push(other!);
    await expect(other!.size('default')).rejects.toThrow(/dims/);
  });

  it('without dir it uses a temporary directory and removes it on close', async () => {
    const b = await createRvfBackend({ dimensions: DIM });
    expect(b!.persistent).toBe(false);
    await b!.insert('a', vectors(1, 9)[0]);
    expect(existsSync(b!.dir)).toBe(true);
    await b!.close();
    expect(existsSync(b!.dir)).toBe(false);
  });
});

describe('memory-rvf fallback when @ruvector/rvf is absent', () => {
  afterEach(() => {
    vi.doUnmock('@ruvector/rvf');
    vi.resetModules();
  });

  it('isRvfAvailable is false and createRvfBackend returns null without throwing', async () => {
    vi.resetModules();
    vi.doMock('@ruvector/rvf', () => {
      throw new Error("Cannot find package '@ruvector/rvf'");
    });
    const mod = await import('../src/memory-rvf.js');
    expect(await mod.isRvfAvailable()).toBe(false);
    expect(await mod.createRvfBackend({ dimensions: DIM, dir: freshDir() })).toBeNull();
  });

  it('a module without RvfDatabase also counts as absent', async () => {
    vi.resetModules();
    vi.doMock('@ruvector/rvf', () => ({ createIndex: () => null }));
    const mod = await import('../src/memory-rvf.js');
    expect(await mod.isRvfAvailable()).toBe(false);
    expect(await mod.createRvfBackend({ dimensions: DIM })).toBeNull();
  });
});
