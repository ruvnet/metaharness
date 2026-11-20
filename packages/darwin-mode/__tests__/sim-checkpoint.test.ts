// SPDX-License-Identifier: MIT
// #522: checkpoint manifests, bounded replay, and snapshot <-> journal migration.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SimJournal } from '../src/sim-journal.js';
import { SimMemory } from '../src/sim-memory.js';
import type { SimAttempt, SimAttemptInput } from '../src/sim-memory.js';
import { checkpointPathFor, parseCheckpointManifest } from '../src/sim-checkpoint.js';
import type { SimCheckpointManifest } from '../src/sim-checkpoint.js';
import {
  migrateSimSnapshotToJournal, rollbackSimJournalToSnapshot, writeSimJournal,
} from '../src/sim-migrate.js';

const dirs: string[] = [];
const open: SimJournal[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sim-checkpoint-'));
  dirs.push(dir);
  return dir;
}
function track(j: SimJournal): SimJournal { open.push(j); return j; }
afterEach(async () => {
  await Promise.all(open.splice(0).map((j) => j.close().catch(() => undefined)));
  await Promise.all(dirs.splice(0).map((x) => rm(x, { recursive: true, force: true })));
});

function row(id: string, i = 0): SimAttemptInput {
  const delta = i % 3 === 0 ? -0.04 : 0.02; // keep regressions in every fixture
  return {
    id, createdAt: '2026-11-20T00:00:00.000Z',
    scope: { ownerId: 'tenant-a', repoId: i % 2 ? 'repo-b' : 'repo-a', interfaceId: 'v1', modelId: 'model-a',
      benchmarkId: 'benchmark-a', harnessVersion: 'v1' },
    problemKey: 'retry', diagnosis: 'timeout', variantId: 'v-' + id, parentId: 'baseline',
    mutationSurface: 'retryPolicy', rationale: 'bounded retry experiment',
    predictedDelta: i % 5 === 0 ? 0.01 : null, observedDelta: delta, finalScore: 0.5 + delta,
    promoted: delta > 0, evidenceIds: ['archive:' + id, 'trace:' + i],
  };
}
// Builds a hash-linked chain the same way SimJournal.append() does, without fsyncing each record.
function chain(count: number, prefix = 'h'): SimAttempt[] {
  const out: SimAttempt[] = [];
  let previousHash: string | null = null;
  for (let i = 0; i < count; i++) {
    const unsigned = { ...row(`${prefix}-${i}`, i), previousHash };
    const hash = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    out.push({ ...unsigned, hash });
    previousHash = hash;
  }
  return out;
}
async function manifestOf(file: string): Promise<SimCheckpointManifest> {
  const parsed = parseCheckpointManifest(await readFile(checkpointPathFor(file), 'utf8'));
  if (typeof parsed === 'string') throw new Error(parsed);
  return parsed;
}
async function loaded(file: string, checkpoints = true): Promise<SimJournal> {
  const j = new SimJournal(file, { checkpoints });
  await j.load();
  return j;
}
const intact = (records: SimAttempt[]) => records.every((x, i) => x.previousHash === (i ? records[i - 1].hash : null));

describe('SIM journal checkpoints (#522)', () => {
  it('writes a manifest that matches the journal and replays only records after it', async () => {
    const file = join(await tempDir(), 'm.jsonl');
    const writer = track(new SimJournal(file, { checkpointEvery: 10 }));
    for (let i = 0; i < 25; i++) await writer.append(row('r' + i, i));
    const manifest = await manifestOf(file);
    expect(manifest).toMatchObject({ format: 'metaharness.sim.checkpoint.v1', records: 20 });
    expect(manifest.chainHead).toBe(writer.all()[19].hash);
    expect(manifest.prefixSha256).toBe(createHash('sha256').update((await readFile(file)).subarray(0, manifest.offset)).digest('hex'));
    await writer.close();

    const reader = await loaded(file);
    expect(reader.checkpointStatus()).toEqual({ status: 'used', checkpointRecords: 20, replayedRecords: 5 });
    expect(reader.count()).toBe(25);
    expect(reader.all()).toEqual((await loaded(file, false)).all());
    expect(reader.all()[manifest.records - 1].hash).toBe(manifest.chainHead);
    expect(intact(reader.all())).toBe(true);
  });

  it('replay work after a checkpoint does not grow with history', async () => {
    const counts: number[] = [];
    for (const history of [200, 5_000]) {
      const file = join(await tempDir(), 'h.jsonl');
      await writeSimJournal(chain(history), file); // installs a checkpoint at `history`
      const writer = track(new SimJournal(file));
      for (let i = 0; i < 7; i++) await writer.append(row('tail-' + i, i));
      await writer.close();
      const reader = await loaded(file);
      expect(reader.count()).toBe(history + 7);
      expect(reader.checkpointStatus().checkpointRecords).toBe(history);
      counts.push(reader.checkpointStatus().replayedRecords);
    }
    expect(counts).toEqual([7, 7]);
  });

  it('rejects corrupt, tampered, foreign or out-of-range manifests and falls back to full verified replay', async () => {
    const dir = await tempDir();
    const file = join(dir, 'c.jsonl');
    const writer = track(new SimJournal(file));
    for (let i = 0; i < 12; i++) await writer.append(row('c' + i, i));
    const good = await writer.checkpoint();
    await writer.close();
    const expected = (await loaded(file, false)).all();
    const other = join(dir, 'other.jsonl');
    await writeSimJournal(chain(12, 'foreign'), other);
    const cases: Array<[string, string]> = [
      ['not json', '{"format":'],
      ['bad hash', JSON.stringify({ ...good, prefixSha256: 'f'.repeat(64) })],
      ['beyond', JSON.stringify({ ...good, offset: good.offset + 4096 })],
      ['boundary', JSON.stringify({ ...good, offset: good.offset - 1 })],
      ['count', JSON.stringify({ ...good, records: good.records - 1 })],
      ['head', JSON.stringify({ ...good, chainHead: 'a'.repeat(64) })],
      ['foreign', await readFile(checkpointPathFor(other), 'utf8')],
      ['format', JSON.stringify({ ...good, format: 'metaharness.sim.checkpoint.v0' })],
    ];
    for (const [name, raw] of cases) {
      await writeFile(checkpointPathFor(file), raw);
      const reader = await loaded(file);
      expect(reader.checkpointStatus().status, name).toBe('rejected');
      expect(reader.checkpointStatus().replayedRecords, name).toBe(12);
      expect(reader.all(), name).toEqual(expected);
    }
  });

  it('a stale (older) manifest is still valid and simply replays more', async () => {
    const file = join(await tempDir(), 's.jsonl');
    const writer = track(new SimJournal(file));
    for (let i = 0; i < 5; i++) await writer.append(row('s' + i, i));
    await writer.checkpoint();
    for (let i = 5; i < 9; i++) await writer.append(row('s' + i, i));
    await writer.close();
    const reader = await loaded(file);
    expect(reader.checkpointStatus()).toEqual({ status: 'used', checkpointRecords: 5, replayedRecords: 4 });
    expect(reader.count()).toBe(9);
  });

  it('a crash while installing a checkpoint leaves the previous manifest intact', async () => {
    const dir = await tempDir();
    const file = join(dir, 'f.jsonl');
    let crash = false;
    const writer = track(new SimJournal(file, { faults: { beforeCheckpointRename() { if (crash) throw new Error('crash'); } } }));
    for (let i = 0; i < 3; i++) await writer.append(row('f' + i, i));
    const before = await writer.checkpoint();
    await writer.append(row('f3', 3));
    crash = true;
    await expect(writer.checkpoint()).rejects.toThrow('crash');
    expect(await manifestOf(file)).toEqual(before);
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    crash = false;
    await writer.append(row('f4', 4)); // the journal itself is unaffected
    await writer.close();
    const reader = await loaded(file);
    expect(reader.checkpointStatus()).toMatchObject({ status: 'used', checkpointRecords: 3, replayedRecords: 2 });
  });

  it('a failed automatic checkpoint never fails the durable append', async () => {
    const file = join(await tempDir(), 'a.jsonl');
    const writer = track(new SimJournal(file, { checkpointEvery: 2, faults: { beforeCheckpointSync() { throw new Error('disk'); } } }));
    for (let i = 0; i < 4; i++) await writer.append(row('a' + i, i));
    expect(writer.lastCheckpointError()?.message).toBe('disk');
    await writer.close();
    expect((await loaded(file)).count()).toBe(4);
  });
});

describe('SIM snapshot <-> journal migration (#522)', () => {
  async function snapshotWith(dir: string, n: number): Promise<{ path: string; records: SimAttempt[] }> {
    const path = join(dir, 'snapshot.json');
    const memory = new SimMemory(path);
    for (let i = 0; i < n; i++) await memory.append(row('m' + i, i));
    return { path, records: memory.all() };
  }

  it('round-trips every field and the hash chain, and never touches the source', async () => {
    const dir = await tempDir();
    const { path, records } = await snapshotWith(dir, 30);
    expect(records.some((r) => r.observedDelta < 0 && !r.promoted)).toBe(true);
    const sourceBytes = await readFile(path);
    const journalPath = join(dir, 'events.jsonl');
    const head = records.at(-1)!.hash;
    expect(await migrateSimSnapshotToJournal(path, journalPath)).toEqual({ status: 'migrated', records: 30, chainHead: head });
    expect(await readFile(path)).toEqual(sourceBytes);

    const journal = await loaded(journalPath);
    expect(journal.all()).toEqual(records);
    expect(journal.checkpointStatus()).toEqual({ status: 'used', checkpointRecords: 30, replayedRecords: 0 });
    // The journal-backed SimMemory serves the same records and keeps appending to the same chain.
    const adapter = new SimMemory(journalPath, { persistence: 'journal' });
    const next = await adapter.append(row('after', 1));
    expect(next.previousHash).toBe(head);
    await adapter.close();

    const back = join(dir, 'rollback.json');
    const rolled = await rollbackSimJournalToSnapshot(journalPath, back);
    expect(rolled).toEqual({ status: 'migrated', records: 31, chainHead: next.hash });
    const restored = new SimMemory(back);
    await restored.load();
    expect(restored.all()).toEqual([...records, next]);
  });

  it('is idempotent, and refuses a different target or the same path', async () => {
    const dir = await tempDir();
    const { path } = await snapshotWith(dir, 4);
    const journalPath = join(dir, 'events.jsonl');
    await migrateSimSnapshotToJournal(path, journalPath);
    const bytes = await readFile(journalPath);
    expect((await migrateSimSnapshotToJournal(path, journalPath)).status).toBe('unchanged');
    expect(await readFile(journalPath)).toEqual(bytes);

    const foreign = join(dir, 'foreign.jsonl');
    await writeSimJournal(chain(2, 'x'), foreign);
    await expect(migrateSimSnapshotToJournal(path, foreign)).rejects.toThrow('different records');
    await expect(migrateSimSnapshotToJournal(path, path)).rejects.toThrow('different files');
    await expect(rollbackSimJournalToSnapshot(foreign, path)).rejects.toThrow('different records');
    expect((await rollbackSimJournalToSnapshot(journalPath, path)).status).toBe('unchanged');
  });

  it('rollback fails closed when the journal exceeds the snapshot size limit', async () => {
    const dir = await tempDir();
    const journalPath = join(dir, 'big.jsonl');
    await writeSimJournal(chain(25_000), journalPath);
    await expect(rollbackSimJournalToSnapshot(journalPath, join(dir, 'big.json'))).rejects.toThrow('16 MB');
    expect((await readdir(dir)).filter((f) => f === 'big.json' || f.startsWith('.big.json.'))).toEqual([]);
  }, 60_000);

  it('refuses a writer-held journal: migration takes the lease', async () => {
    const dir = await tempDir();
    const journalPath = join(dir, 'held.jsonl');
    const holder = track(new SimJournal(journalPath));
    await holder.acquire();
    await expect(writeSimJournal(chain(1), journalPath)).rejects.toThrow('held by');
  });
});

describe('SIM journal 100k-record endurance under interruption (#522)', () => {
  const dist = pathToFileURL(fileURLToPath(new URL('../dist/sim-journal.js', import.meta.url))).href;
  const writer = fileURLToPath(new URL('./fixtures/sim-journal-writer.mjs', import.meta.url));
  function run(file: string, ...args: string[]) {
    const child = spawn(process.execPath, [writer, dist, file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal, out, err }));
    });
  }
  const acks = (out: string) => out.split('\n').filter((l) => l.startsWith('ACK ')).map((l) => l.slice(4));

  // History is seeded with one bulk write + fsync (writeSimJournal); the live part is a
  // separate writer process doing fsynced, acknowledged appends with automatic
  // checkpoints, SIGKILLed partway through the 100,000th record. Per-record-fsync
  // throughput over the whole 100k lives in bench/sim-endurance.mjs.
  it('100,000 records: a writer killed mid-record loses no acknowledged event; recovery is checkpoint-bounded', async () => {
    const file = join(await tempDir(), 'endurance.jsonl');
    const seed = chain(99_900);
    expect((await writeSimJournal(seed, file)).records).toBe(99_900);

    const crashed = await run(file, 'live', '100', '99', '-', '25');
    expect(crashed.signal ?? crashed.code).toBeTruthy();
    const acked = acks(crashed.out);
    expect(acked).toHaveLength(99);
    const manifest = await manifestOf(file);
    expect(manifest.records).toBe(99_900 + 75); // last automatic checkpoint before the kill

    const reader = await loaded(file);
    expect(await reader.load()).toEqual({ records: 99_999, recoveredTailBytes: expect.any(Number) });
    expect(reader.checkpointStatus()).toEqual({ status: 'used', checkpointRecords: manifest.records, replayedRecords: 24 });
    const ids = reader.all().map((r) => r.id);
    expect(ids.slice(99_900)).toEqual(acked);
    expect(reader.all()[manifest.records - 1].hash).toBe(manifest.chainHead);

    const survivor = await run(file, 'after', '1');
    expect(survivor.code).toBe(0);
    const final = await loaded(file);
    expect(final.count()).toBe(100_000);
    expect(final.all().map((r) => r.id).slice(99_900)).toEqual([...acked, 'after-0']);
    expect(intact(final.all())).toBe(true);
    // Full verified replay agrees with the checkpointed view.
    const full = await loaded(file, false);
    expect(full.checkpointStatus().replayedRecords).toBe(100_000);
    expect(full.all().at(-1)!.hash).toBe(final.all().at(-1)!.hash);
  }, 120_000);
});
