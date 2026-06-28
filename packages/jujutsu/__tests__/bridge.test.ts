// SPDX-License-Identifier: MIT
//
// Offline bridge tests — exercise the full dual-state lifecycle with mock
// adapters (no jj CLI, no native addon, no rvf-node).

import { describe, it, expect } from 'vitest';
import {
  DualStateBridge,
  MockOpProvider,
  MockMemoryProvider,
  MockQueryProvider,
  HashEmbedder,
} from '../src/index.js';

function makeBridge(seedOps = 3) {
  const op = new MockOpProvider(seedOps);
  const mem = new MockMemoryProvider();
  const query = new MockQueryProvider(mem);
  const bridge = new DualStateBridge(op, mem, { queryProvider: query, embedder: new HashEmbedder(64) });
  return { op, mem, query, bridge };
}

describe('DualStateBridge lifecycle', () => {
  it('spawn creates both an op branch and a memory branch', async () => {
    const { bridge } = makeBridge();
    const b = await bridge.spawn('alice');
    expect(b.agentId).toBe('alice');
    expect(b.op).not.toBeNull();
    expect(b.mem).not.toBeNull();
    expect(bridge.status()).toEqual({ opPlane: true, memPlane: true, nativeAnn: false });
  });

  it('rejects double-spawn of the same agent', async () => {
    const { bridge } = makeBridge();
    await bridge.spawn('alice');
    await expect(bridge.spawn('alice')).rejects.toThrow(/already spawned/);
  });

  it('learn embeds the op-sequence into the memory branch', async () => {
    const { bridge, mem } = makeBridge(4);
    const b = await bridge.spawn('alice');
    const res = await bridge.learn('alice', 0.9, 'good run');
    expect(res.opCount).toBe(4);
    expect(res.ingested).toBe(4);
    expect(res.opPlane && res.memPlane).toBe(true);
    const delta = await mem.diff(b.mem!);
    expect(delta.added.length).toBe(4);
  });

  it('revert drops the memory delta back to the spawn checkpoint', async () => {
    const { bridge, mem } = makeBridge(3);
    const b = await bridge.spawn('alice');
    await bridge.learn('alice', 0.5);
    expect((await mem.diff(b.mem!)).added.length).toBe(3);
    await bridge.revert('alice');
    expect((await mem.diff(b.mem!)).added.length).toBe(0);
  });

  it('merge promotes the winning delta into the base and closes the agent', async () => {
    const { bridge, mem } = makeBridge(2);
    await bridge.spawn('alice');
    await bridge.learn('alice', 1.0);
    const promo = await bridge.merge('alice');
    expect(promo.ingested).toBe(2);
    expect(mem.base.size).toBe(2);
    // agent is gone after merge
    await expect(bridge.merge('alice')).rejects.toThrow(/not spawned/);
  });

  it('queryMemory returns ranked hits via the (stubbed) query plane', async () => {
    const { bridge } = makeBridge(5);
    await bridge.spawn('alice');
    await bridge.learn('alice', 0.8);
    const q = bridge.embed('commit alice step 0');
    const hits = await bridge.queryMemory('alice', q, 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(3);
    // sorted ascending by distance
    for (let i = 1; i < hits.length; i++) expect(hits[i].distance).toBeGreaterThanOrEqual(hits[i - 1].distance);
  });

  it('queryMemory without a provider fails with a clear stub message', async () => {
    const op = new MockOpProvider();
    const mem = new MockMemoryProvider();
    const bridge = new DualStateBridge(op, mem); // no queryProvider
    await bridge.spawn('bob');
    await expect(bridge.queryMemory('bob', [1, 2, 3])).rejects.toThrow(/stubbed plane|PR #617/);
  });
});

describe('degraded planes', () => {
  it('works memory-only when the op plane is unavailable', async () => {
    const op = { available: false } as unknown as MockOpProvider;
    const mem = new MockMemoryProvider();
    const bridge = new DualStateBridge(op, mem);
    const b = await bridge.spawn('solo');
    expect(b.op).toBeNull();
    expect(b.mem).not.toBeNull();
    const res = await bridge.learn('solo', 0.7);
    expect(res.opPlane).toBe(false);
    expect(res.memPlane).toBe(true);
    expect(res.ingested).toBe(0); // no op-sequence to embed
  });
});
