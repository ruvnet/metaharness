// SPDX-License-Identifier: MIT
//
// Live test against the REAL agenticow package (pinned devDependency). It
// imports agenticow directly and drives AgenticowMemoryProvider +
// AgenticowQueryProvider through the full branch lifecycle, so a breaking
// change in the peer's fork({nativeAnn}) / query / promote API fails here
// instead of in a user's install.

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as agenticow from 'agenticow';
import { AgenticowMemoryProvider, AgenticowQueryProvider } from '../src/bridge/index.js';
import { probe } from '../src/index.js';
import { _resetLoaderCacheForTests } from '../src/loader.js';

const DIM = 8;
const vec = (seed: number): number[] => Array.from({ length: DIM }, (_, i) => Math.sin(seed * 7 + i) + 1.5);

const dirs: string[] = [];
const providers: AgenticowMemoryProvider[] = [];
afterEach(() => {
  for (const p of providers.splice(0)) p.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  _resetLoaderCacheForTests();
});

async function makeProvider(): Promise<AgenticowMemoryProvider> {
  const dir = mkdtempSync(join(tmpdir(), 'mh-jujutsu-cow-'));
  dirs.push(dir);
  const p = await AgenticowMemoryProvider.create({ basePath: join(dir, 'base.rvf'), dimension: DIM, metric: 'l2' });
  providers.push(p);
  return p;
}

describe('agenticow (real package) — peer API contract', () => {
  it('is the version the peer range pins', () => {
    // agenticow's exports map has no "./package.json", so locate it on disk the
    // way Node's resolver does: nearest node_modules/agenticow walking upward.
    let dir = dirname(fileURLToPath(import.meta.url));
    let pkgPath = '';
    for (;;) {
      const cand = join(dir, 'node_modules', 'agenticow', 'package.json');
      if (existsSync(cand)) { pkgPath = cand; break; }
      const up = dirname(dir);
      if (up === dir) throw new Error('agenticow not installed');
      dir = up;
    }
    const installed = JSON.parse(readFileSync(pkgPath, 'utf8')).version as string;
    const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      peerDependencies: Record<string, string>;
    };
    expect(installed).toBe(own.peerDependencies.agenticow);
    expect(typeof agenticow.open).toBe('function');
  });

  it('probe() sees the memory plane and native ANN', async () => {
    const rep = await probe();
    expect(rep.memory).toBe(true);
    expect(rep.annAcrossBranch).toBe(true);
  });

  it('branch → ingest → native cross-branch query → checkpoint/rollback → promote', async () => {
    const provider = await makeProvider();
    expect(provider.available).toBe(true);

    const h = await provider.branch('agent-a');
    // fork({nativeAnn:true}) must yield a native-COW child.
    expect(provider._memory(h).nativeAnn).toBe(true);

    const ingested = await provider.ingest(h, [1, 2, 3].map((id) => ({ id, vector: vec(id) })));
    expect(ingested.accepted).toBe(3);

    const query = new AgenticowQueryProvider(provider);
    expect(query.nativeAnn).toBe(true);
    const hits = await query.queryAcrossBranches(h, vec(2), 3);
    expect(hits.length).toBe(3);
    expect(hits[0].id).toBe(2);
    for (const hit of hits) {
      expect(typeof hit.distance).toBe('number');
      expect(typeof hit.branch).toBe('string');
    }

    const delta = await provider.diff(h);
    expect([...delta.added].sort()).toEqual([1, 2, 3]);

    const ck = await provider.checkpoint(h, 'after-3');
    expect(typeof ck.id).toBe('string');
    await provider.ingest(h, [{ id: 4, vector: vec(4) }]);
    expect((await provider.diff(h)).added).toEqual([4]);
    // Rollback re-roots the working node on the checkpoint: the delta is empty.
    await provider.rollback(h, ck.id);
    expect((await provider.diff(h)).added).toEqual([]);

    // Rollback with no id returns to the empty post-spawn checkpoint.
    await provider.rollback(h);
    expect((await provider.diff(h)).added).toEqual([]);

    await provider.ingest(h, [{ id: 9, vector: vec(9) }]);
    const promoted = await provider.promote(h);
    expect(promoted.ingested).toBe(1);
    const baseHits = provider.baseMemory!.query(Float32Array.from(vec(9)), 1);
    expect(baseHits[0].id).toBe(9);
  });
});
