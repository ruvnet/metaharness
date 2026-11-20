// SPDX-License-Identifier: MIT
import { mkdtemp, readFile, rm, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SimJournal } from '../src/sim-journal.js';
import type { SimAttemptInput } from '../src/sim-memory.js';

const dirs: string[] = [];
async function journal() {
  const dir = await mkdtemp(join(tmpdir(), 'sim-journal-'));
  dirs.push(dir);
  const file = join(dir, 'memory.jsonl');
  return { file, store: new SimJournal(file) };
}
function row(id: string, delta = -0.05): SimAttemptInput {
  return {
    id, createdAt: '2026-11-20T00:00:00.000Z',
    scope: { ownerId: 'tenant-a', repoId: 'repo-a', interfaceId: 'v1', modelId: 'model-a',
      benchmarkId: 'benchmark-a', harnessVersion: 'v1' },
    problemKey: 'retry', diagnosis: 'timeout', variantId: 'v-' + id, parentId: 'baseline',
    mutationSurface: 'retryPolicy', rationale: 'bounded retry experiment',
    predictedDelta: null, observedDelta: delta, finalScore: 0.5 + delta,
    promoted: delta > 0, evidenceIds: ['archive:' + id],
  };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((x) => rm(x, { recursive: true, force: true }))); });

describe('SIM append journal', () => {
  it('roundtrips negative and positive attempts without snapshot rewrites', async () => {
    const { file, store } = await journal();
    const first = await store.append(row('failure'));
    const second = await store.append(row('success', 0.1));
    expect(second.previousHash).toBe(first.hash);
    const loaded = new SimJournal(file);
    expect(await loaded.load()).toEqual({ records: 2, recoveredTailBytes: 0 });
    expect(loaded.all().map((x) => x.observedDelta)).toEqual([-0.05, 0.1]);
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('recovers an incomplete tail and safely appends a new event', async () => {
    const { file, store } = await journal();
    await store.append(row('a'));
    await appendFile(file, '{"schema":"metaharness.sim.journal.v1","record":');
    const next = new SimJournal(file);
    const report = await next.load();
    expect(report.records).toBe(1);
    expect(report.recoveredTailBytes).toBeGreaterThan(0);
    await next.append(row('b'));
    const replay = new SimJournal(file);
    expect((await replay.load()).records).toBe(2);
    expect(replay.all().map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('rejects a corrupt complete event rather than truncating valid history', async () => {
    const { file, store } = await journal();
    await store.append(row('a'));
    const data = await readFile(file, 'utf8');
    await writeFile(file, data.replace('-0.05', '0.99'));
    await expect(new SimJournal(file).load()).rejects.toThrow(/hash/);
  });

  it('rejects malformed values and duplicate ids before writing', async () => {
    const { file, store } = await journal();
    await expect(store.append(row('bad', Number.NaN))).rejects.toThrow();
    await store.append(row('a'));
    await expect(store.append(row('a'))).rejects.toThrow(/duplicate/);
    const reload = new SimJournal(file);
    expect((await reload.load()).records).toBe(1);
  });

  it('serializes 50 concurrent appends and maintains an intact chain', async () => {
    const { file, store } = await journal();
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.append(row('id-' + i))));
    const next = new SimJournal(file);
    await next.load();
    const records = next.all();
    expect(records).toHaveLength(50);
    expect(records.every((x, i) => x.previousHash === (i ? records[i - 1].hash : null))).toBe(true);
  });
});
