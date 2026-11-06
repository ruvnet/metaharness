// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { mkdtemp, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryStore } from '../src/trajectory.js';

describe('TrajectoryStore', () => {
  it('append + readAll round-trips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traj-'));
    const s = new TrajectoryStore(join(dir, 'log.jsonl'));
    await s.append({ ts: '2026-06-13T00:00:00Z', phase: 'Retrieve', outcome: 'success' });
    await s.append({ ts: '2026-06-13T00:00:01Z', phase: 'Judge', outcome: 'success', output: { judge_score: 0.8 } });
    const all = await s.readAll();
    expect(all.length).toBe(2);
    expect(all[0]!.phase).toBe('Retrieve');
    expect(all[1]!.output).toEqual({ judge_score: 0.8 });
  });

  it('readAll on missing file returns []', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traj-'));
    const s = new TrajectoryStore(join(dir, 'never.jsonl'));
    expect(await s.readAll()).toEqual([]);
  });

  it('rotateIfLarger no-op when smaller', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traj-'));
    const s = new TrajectoryStore(join(dir, 'log.jsonl'));
    await s.append({ ts: 't', phase: 'Retrieve', outcome: 'success' });
    expect(await s.rotateIfLarger(1_000_000)).toBe(false);
  });

  it('rotateIfLarger rotates and resets when over', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traj-'));
    const s = new TrajectoryStore(join(dir, 'log.jsonl'));
    for (let i = 0; i < 100; i++) {
      await s.append({ ts: 't', phase: 'Retrieve', outcome: 'success', output: { i } });
    }
    expect(await s.rotateIfLarger(100)).toBe(true);
    expect(await s.size()).toBe(0);
  });

  it('readAll skips an already-terminated corrupted line instead of throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traj-'));
    const path = join(dir, 'log.jsonl');
    const s = new TrajectoryStore(path);
    await s.append({ ts: '2026-06-13T00:00:00Z', phase: 'Retrieve', outcome: 'success' });
    // A truncated, unparseable JSON fragment that already has its own
    // trailing newline (e.g. read some time after a crash, before any
    // further append() call lands) — the common case this fix targets.
    await appendFile(path, '{"ts":"2026-06-13T00:00:01Z","phase":"Judge","outcome":"succ\n', 'utf-8');
    await s.append({ ts: '2026-06-13T00:00:02Z', phase: 'Distill', outcome: 'success' });

    const all = await s.readAll();
    expect(all.length).toBe(2);
    expect(all[0]!.phase).toBe('Retrieve');
    expect(all[1]!.phase).toBe('Distill');
  });

  it('KNOWN LIMITATION: a torn write with no trailing newline, followed immediately ' +
     'by another append(), merges the torn tail and the next record into one ' +
     'unparseable line — both are lost, not just the torn one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traj-'));
    const path = join(dir, 'log.jsonl');
    const s = new TrajectoryStore(path);
    await s.append({ ts: '2026-06-13T00:00:00Z', phase: 'Retrieve', outcome: 'success' });
    // A real torn write: the process died mid-`appendFile`, so the tail has
    // NO trailing newline. The next append() (no repair/reopen step exists
    // between crash and resume) concatenates directly onto it.
    await appendFile(path, '{"ts":"2026-06-13T00:00:01Z","phase":"Judge","outcome":"succ', 'utf-8');
    await s.append({ ts: '2026-06-13T00:00:02Z', phase: 'Distill', outcome: 'success' });

    const { records, corruptLines } = await s.readAllWithDiagnostics();
    // Only the first record survives: the torn tail AND the otherwise-good
    // "Distill" record merged into a single unparseable line and both are
    // gone. Documented, not silently fixed — see readAll()'s doc comment.
    expect(records.length).toBe(1);
    expect(records[0]!.phase).toBe('Retrieve');
    expect(corruptLines).toEqual([2]);
  });

  it('readAllWithDiagnostics reports the 1-based corrupt line number', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traj-'));
    const path = join(dir, 'log.jsonl');
    const s = new TrajectoryStore(path);
    await s.append({ ts: 't1', phase: 'Retrieve', outcome: 'success' });
    await appendFile(path, 'not json at all\n', 'utf-8');
    await s.append({ ts: 't2', phase: 'Judge', outcome: 'success' });

    const { records, corruptLines } = await s.readAllWithDiagnostics();
    expect(records.length).toBe(2);
    expect(corruptLines).toEqual([2]);
  });

  it('readAllWithDiagnostics reports no corrupt lines for a clean file (byte-identical to readAll)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traj-'));
    const s = new TrajectoryStore(join(dir, 'log.jsonl'));
    await s.append({ ts: 't1', phase: 'Retrieve', outcome: 'success' });
    await s.append({ ts: 't2', phase: 'Judge', outcome: 'success' });

    const { records, corruptLines } = await s.readAllWithDiagnostics();
    expect(corruptLines).toEqual([]);
    expect(records).toEqual(await s.readAll());
  });
});
