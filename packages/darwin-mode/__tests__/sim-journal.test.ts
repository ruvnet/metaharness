// SPDX-License-Identifier: MIT
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, appendFile, writeFile, readdir, stat, utimes } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SimJournal, SimJournalLockedError, networkFilesystemName } from '../src/sim-journal.js';
import type { SimJournalFaults } from '../src/sim-journal.js';
import type { SimAttemptInput } from '../src/sim-memory.js';

const dirs: string[] = [];
const open: SimJournal[] = [];
async function journal(faults?: SimJournalFaults) {
  const dir = await mkdtemp(join(tmpdir(), 'sim-journal-'));
  dirs.push(dir);
  const file = join(dir, 'memory.jsonl');
  return { dir, file, store: track(new SimJournal(file, { faults })) };
}
function track(j: SimJournal): SimJournal { open.push(j); return j; }
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
async function reload(file: string): Promise<SimJournal> {
  const j = new SimJournal(file);
  await j.load();
  return j;
}
function chainIntact(j: SimJournal): boolean {
  const records = j.all();
  return records.every((x, i) => x.previousHash === (i ? records[i - 1].hash : null));
}
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid!;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((j) => j.close().catch(() => undefined)));
  await Promise.all(dirs.splice(0).map((x) => rm(x, { recursive: true, force: true })));
});

describe('SIM append journal', () => {
  it('roundtrips negative and positive attempts without snapshot rewrites', async () => {
    const { file, store } = await journal();
    const first = await store.append(row('failure'));
    const second = await store.append(row('success', 0.1));
    expect(second.previousHash).toBe(first.hash);
    const loaded = await reload(file);
    expect(await loaded.load()).toEqual({ records: 2, recoveredTailBytes: 0 });
    expect(loaded.all().map((x) => x.observedDelta)).toEqual([-0.05, 0.1]);
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('load() is read-only: a torn tail is reported but left in place', async () => {
    const { file, store } = await journal();
    await store.append(row('a'));
    await store.close();
    await appendFile(file, '{"schema":"metaharness.sim.journal.v1","record":');
    const before = (await stat(file)).size;
    const reader = new SimJournal(file);
    const report = await reader.load();
    expect(report).toEqual({ records: 1, recoveredTailBytes: expect.any(Number) });
    expect(report.recoveredTailBytes).toBeGreaterThan(0);
    expect((await stat(file)).size).toBe(before);
  });

  it('the lease holder copies a torn tail aside, truncates it, and appends after it', async () => {
    const { dir, file, store } = await journal();
    await store.append(row('a'));
    await store.close();
    const torn = '{"schema":"metaharness.sim.journal.v1","record":';
    await appendFile(file, torn);
    const next = track(new SimJournal(file));
    await next.append(row('b'));
    const replay = await reload(file);
    expect(replay.all().map((x) => x.id)).toEqual(['a', 'b']);
    expect(chainIntact(replay)).toBe(true);
    const aside = (await readdir(dir)).filter((f) => f.startsWith('memory.jsonl.torn-'));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(dir, aside[0]), 'utf8')).toBe(torn);
  });

  it('rejects a corrupt complete event rather than truncating valid history', async () => {
    const { file, store } = await journal();
    await store.append(row('a'));
    await store.close();
    const data = await readFile(file, 'utf8');
    await writeFile(file, data.replace('-0.05', '0.99'));
    await expect(new SimJournal(file).load()).rejects.toThrow(/hash/);
    await expect(track(new SimJournal(file)).append(row('b'))).rejects.toThrow(/hash/);
    expect(await readFile(file, 'utf8')).toBe(data.replace('-0.05', '0.99'));
  });

  it('rejects malformed values and duplicate ids before writing', async () => {
    const { file, store } = await journal();
    await expect(store.append(row('bad', Number.NaN))).rejects.toThrow();
    await store.append(row('a'));
    await expect(store.append(row('a'))).rejects.toThrow(/duplicate/);
    expect((await reload(file)).count()).toBe(1);
  });

  it('serializes 50 concurrent appends and maintains an intact chain', async () => {
    const { file, store } = await journal();
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.append(row('id-' + i))));
    const next = await reload(file);
    expect(next.all()).toHaveLength(50);
    expect(chainIntact(next)).toBe(true);
  });
});

describe('SIM journal single-writer lease (#521)', () => {
  it('a second writer cannot take the lease while the first holds it', async () => {
    const { file, store } = await journal();
    await store.append(row('a'));
    const second = track(new SimJournal(file));
    await expect(second.append(row('b'))).rejects.toBeInstanceOf(SimJournalLockedError);
    expect((await reload(file)).all().map((x) => x.id)).toEqual(['a']);
    await store.close();
    await second.append(row('b'));
    expect((await reload(file)).all().map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('close() releases the lease file and is required before reopening for writes', async () => {
    const { file, store } = await journal();
    await store.append(row('a'));
    expect(store.holdsLease()).toBe(true);
    await expect(readFile(file + '.lock', 'utf8')).resolves.toContain(String(process.pid));
    await store.close();
    await expect(stat(file + '.lock')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.append(row('b'))).rejects.toThrow(/closed/);
  });

  it('breaks a lease left by a dead process on this host', async () => {
    const { file, store } = await journal();
    await writeFile(file + '.lock', JSON.stringify({
      format: 'metaharness.sim.lease.v1', pid: deadPid(), host: hostname(), token: 'stale', acquiredAt: '2026-01-01T00:00:00Z',
    }));
    await store.append(row('a'));
    expect(JSON.parse(await readFile(file + '.lock', 'utf8')).pid).toBe(process.pid);
  });

  it('never breaks a lease owned by another host, however old', async () => {
    const { file, store } = await journal();
    await writeFile(file + '.lock', JSON.stringify({
      format: 'metaharness.sim.lease.v1', pid: deadPid(), host: 'some-other-host', token: 'remote', acquiredAt: '2020-01-01T00:00:00Z',
    }));
    await expect(store.append(row('a'))).rejects.toBeInstanceOf(SimJournalLockedError);
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats a half-written lease as live until it is older than staleLeaseMs', async () => {
    const { file } = await journal();
    await writeFile(file + '.lock', '{"format":"metaharness.sim.le');
    const fresh = track(new SimJournal(file, { staleLeaseMs: 60_000 }));
    await expect(fresh.append(row('a'))).rejects.toBeInstanceOf(SimJournalLockedError);
    const old = new Date(Date.now() - 120_000);
    await utimes(file + '.lock', old, old);
    await fresh.append(row('a'));
    expect((await reload(file)).count()).toBe(1);
  });

  it('fences: a writer whose file changed underneath it commits nothing', async () => {
    const { file, store } = await journal();
    await store.append(row('a'));
    await appendFile(file, '{"foreign":true}\n');
    await expect(store.append(row('b'))).rejects.toThrow(/changed outside/);
    await expect(store.append(row('c'))).rejects.toThrow(/previous write failed/);
    expect(await readFile(file, 'utf8')).not.toContain('"id":"b"');
  });

  it('fences: a writer whose lease token was replaced commits nothing', async () => {
    const { file, store } = await journal();
    await store.append(row('a'));
    const lease = JSON.parse(await readFile(file + '.lock', 'utf8'));
    await writeFile(file + '.lock', JSON.stringify({ ...lease, token: 'usurper' }));
    await expect(store.append(row('b'))).rejects.toThrow(/lease lost/);
    expect((await reload(file)).all().map((x) => x.id)).toEqual(['a']);
  });
});

describe('SIM journal network filesystem guard', () => {
  it('maps Linux statfs magics for network filesystems', () => {
    expect(networkFilesystemName(0x6969)).toBe('nfs');
    expect(networkFilesystemName(0xff534d42)).toBe('cifs');
    expect(networkFilesystemName(0xfe534d42)).toBe('smb2');
    expect(networkFilesystemName(0xef53)).toBeNull(); // ext4
    expect(networkFilesystemName(0x01021994)).toBeNull(); // tmpfs
    expect(networkFilesystemName(null)).toBeNull();
  });

  it('refuses to write on a network filesystem and writes nothing', async () => {
    const { dir, file } = await journal();
    const store = track(new SimJournal(file, { filesystemProbe: async () => 0x6969 }));
    await expect(store.append(row('a'))).rejects.toMatchObject({ code: 'SIM_JOURNAL_UNSUPPORTED_FS' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('allows a network filesystem only with an explicit override', async () => {
    const { file } = await journal();
    const store = track(new SimJournal(file, { filesystemProbe: async () => 0x6969, allowNetworkFilesystem: true }));
    await store.append(row('a'));
    expect((await reload(file)).count()).toBe(1);
  });

  it('passes on the local test filesystem with the real probe', async () => {
    const { file, store } = await journal();
    await store.append(row('a'));
    expect((await reload(file)).count()).toBe(1);
  });
});

describe('SIM journal crash injection at every write boundary (#521)', () => {
  const boundaries = ['beforeWrite', 'afterPartialWrite', 'beforeSync', 'beforeClose'] as const;
  for (const boundary of boundaries) {
    it(`preserves every acknowledged record exactly once after a fault at ${boundary}`, async () => {
      let armed = false;
      const fault = () => { if (armed) throw new Error('injected ' + boundary); };
      const { file, store } = await journal({ [boundary]: fault });
      const acked: string[] = [];
      for (const id of ['a', 'b', 'c']) { await store.append(row(id)); acked.push(id); }
      armed = true;
      await expect(store.append(row('d'))).rejects.toThrow('injected ' + boundary);
      await expect(store.append(row('e'))).rejects.toThrow(/previous write failed/);
      await store.close();

      const next = track(new SimJournal(file));
      await next.append(row('f'));
      acked.push('f');
      const replay = await reload(file);
      const ids = replay.all().map((x) => x.id);
      for (const id of acked) expect(ids.filter((x) => x === id)).toHaveLength(1);
      expect(chainIntact(replay)).toBe(true);
      expect(ids).not.toContain('e');
      // 'd' was never acknowledged. It is absent unless the full line reached the
      // file before the fault; then it is present once and a retry is a duplicate.
      if (ids.includes('d')) {
        expect(['beforeSync', 'beforeClose']).toContain(boundary);
        await expect(next.append(row('d'))).rejects.toThrow(/duplicate/);
      } else {
        await next.append(row('d'));
      }
      expect((await reload(file)).all().filter((x) => x.id === 'd')).toHaveLength(1);
    });
  }
});

describe('SIM journal with independent writer processes (#521)', () => {
  const dist = pathToFileURL(fileURLToPath(new URL('../dist/sim-journal.js', import.meta.url))).href;
  const writer = fileURLToPath(new URL('./fixtures/sim-journal-writer.mjs', import.meta.url));
  function run(file: string, ...args: string[]) {
    const child = spawn(process.execPath, [writer, dist, file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal, out, err }));
    });
    const sees = (text: string) => new Promise<void>((resolve, reject) => {
      const check = () => { if (out.includes(text)) { resolve(); return true; } return false; };
      if (check()) return;
      child.stdout.on('data', check);
      child.on('close', () => { if (!check()) reject(new Error(`child exited before "${text}": ${out}${err}`)); });
    });
    return { done, sees };
  }
  const acks = (out: string) => out.split('\n').filter((l) => l.startsWith('ACK ')).map((l) => l.slice(4));

  it('two independent processes cannot both commit to the same journal', async () => {
    const { file } = await journal();
    const first = run(file, 'p1', '5', '-', '1500');
    await first.sees('HOLDING');
    const second = await run(file, 'p2', '5').done;
    expect(second.code).toBe(3);
    expect(second.out).toContain('LOCKED');
    expect(acks(second.out)).toEqual([]);
    const one = await first.done;
    expect(one.code).toBe(0);
    const ids = (await reload(file)).all().map((x) => x.id);
    expect(ids).toEqual(acks(one.out));
    expect(ids.every((x) => x.startsWith('p1-'))).toBe(true);
  }, 30_000);

  it('racing processes: every acknowledged record is committed exactly once', async () => {
    const { file } = await journal();
    const results = await Promise.all(['r1', 'r2', 'r3', 'r4'].map((p) => run(file, p, '20').done));
    for (const r of results) expect([0, 3]).toContain(r.code);
    expect(results.some((r) => r.code === 0)).toBe(true);
    const acked = results.flatMap((r) => acks(r.out));
    const replay = await reload(file);
    expect(replay.all().map((x) => x.id).sort()).toEqual([...acked].sort());
    expect(chainIntact(replay)).toBe(true);
  }, 60_000);

  it('a writer killed mid-record loses nothing it acknowledged; the next writer recovers', async () => {
    const { dir, file } = await journal();
    const crashed = await run(file, 'k', '10', '4').done;
    expect(crashed.signal ?? crashed.code).toBeTruthy();
    const acked = acks(crashed.out);
    expect(acked).toEqual(['k-0', 'k-1', 'k-2', 'k-3']);
    expect((await new SimJournal(file).load()).recoveredTailBytes).toBeGreaterThan(0);

    const survivor = await run(file, 's', '3').done;
    expect(survivor.code).toBe(0);
    const replay = await reload(file);
    const ids = replay.all().map((x) => x.id);
    expect(ids).toEqual([...acked, ...acks(survivor.out)]);
    expect(chainIntact(replay)).toBe(true);
    expect((await readdir(dir)).filter((f) => f.startsWith('memory.jsonl.torn-'))).toHaveLength(1);
  }, 30_000);
});
