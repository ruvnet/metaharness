// SPDX-License-Identifier: MIT
//
// ADR-241 §2.3 — recoverable session log: resume determinism, crash
// detection, fork/replay independence, canonical-hash stability, and the
// committed cross-language hash fixture the Rust mirror will pin.

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionLog, canonicalJson } from '../src/session.js';

const tmp = () => mkdtemp(join(tmpdir(), 'session-'));
const HERE = dirname(fileURLToPath(import.meta.url));

describe('SessionLog (ADR-241 §2.3)', () => {
  it('append N → reopen (resume) → identical stateHash', async () => {
    const path = join(await tmp(), 'session.jsonl');
    const log = new SessionLog(path);
    for (let i = 0; i < 5; i++) {
      const e = await log.append('turn', { i, text: `event ${i}` });
      expect(e.index).toBe(i);
      expect(e.branch).toBe('main');
    }
    const before = log.stateHash('main');
    expect(before).toMatch(/^[0-9a-f]{64}$/);

    const resumed = await SessionLog.open(path);
    expect(resumed.stateHash('main')).toBe(before);
    expect(resumed.replay('main')).toEqual({ eventCount: 5, stateHash: before });
    expect(await resumed.validate()).toEqual([]);
  });

  it('crash mid-write (truncated line) → validate cites the 1-based line', async () => {
    const path = join(await tmp(), 'session.jsonl');
    const log = new SessionLog(path);
    await log.append('turn', { a: 1 });
    await log.append('turn', { a: 2 });
    // Simulate a crash mid-append: the third line is cut off.
    const raw = await readFile(path, 'utf-8');
    await writeFile(path, raw + '{"index":2,"branch":"main","kind":"tu', 'utf-8');

    const dirty = new SessionLog(path);
    const errors = await dirty.validate();
    expect(errors).toEqual(['session: line 3: corrupted line (invalid JSON)']);
    await expect(SessionLog.open(path)).rejects.toThrow(/^session: line 3/);
  });

  it('fork at k → branches share the prefix, diverge after, replay independently', async () => {
    const path = join(await tmp(), 'session.jsonl');
    const main = new SessionLog(path);
    for (let i = 0; i < 4; i++) await main.append('turn', { i });
    const hashAtFork = main.stateHash('main');

    const side = await main.fork(3, 'side');
    // fork() itself emits the branch's synthetic first event (matching Rust):
    // index 0, parent {branch, index}, kind 'fork', payload null.
    const forkEvents = side.replay('side');
    expect(forkEvents.eventCount).toBe(5); // main[0..3] + side fork event
    const first = await side.append('turn', { i: 4, via: 'side' });
    expect(first.index).toBe(1);
    expect(first.parent).toBeUndefined();
    await main.append('turn', { i: 4, via: 'main' });

    // Prefix (main[0..3]) is shared: forking at the tip means the side
    // branch's lineage starts from the same 4 events.
    expect(main.replay('main').eventCount).toBe(5);
    expect(side.replay('side').eventCount).toBe(6);
    expect(main.stateHash('main')).not.toBe(side.stateHash('side'));
    expect(main.stateHash('main')).not.toBe(hashAtFork);

    // Resume from disk: both branches reconstruct identically + validate clean.
    const resumed = await SessionLog.open(path);
    expect(resumed.stateHash('main')).toBe(main.stateHash('main'));
    expect(resumed.stateHash('side')).toBe(side.stateHash('side'));
    expect(await resumed.validate()).toEqual([]);
  });

  it('payload key order does not change the hash (canonicalization)', async () => {
    const dir = await tmp();
    const a = new SessionLog(join(dir, 'a.jsonl'));
    const b = new SessionLog(join(dir, 'b.jsonl'));
    await a.append('turn', { alpha: 1, beta: { x: [1, 2], y: 'z' } });
    await b.append('turn', { beta: { y: 'z', x: [1, 2] }, alpha: 1 });
    expect(a.stateHash('main')).toBe(b.stateHash('main'));
  });

  it('canonical JSON sorts keys by UTF-8 byte order (matching Rust)', () => {
    // U+FF61 (EF BD A1 in UTF-8) sorts BEFORE U+10348 (F0 90 8D 88) in byte
    // order, even though the default .sort() (UTF-16 code-unit order) would
    // put the astral key first (lead surrogate 0xD800 < 0xFF61). The Rust
    // mirror asserts this exact string.
    expect(canonicalJson({ '\u{10348}gothic': 2, '｡half': 1 })).toBe(
      '{"｡half":1,"\u{10348}gothic":2}',
    );
  });

  it('rejects appending an event containing an unpaired surrogate', async () => {
    const path = join(await tmp(), 'session.jsonl');
    const log = new SessionLog(path);
    await expect(log.append('turn', '\uD800')).rejects.toThrow(
      'session: event contains an unpaired surrogate (not valid UTF-8)',
    );
    // A properly paired surrogate (astral char) is fine.
    const ok = await log.append('turn', { text: 'thumbs \u{1F44D} up' });
    expect(ok.index).toBe(0);
  });

  it('rejects OPENING a log whose line decodes to an unpaired surrogate (read-path parity with serde_json)', async () => {
    const path = join(await tmp(), 'session.jsonl');
    // Hand-crafted file: valid JSON per JSON.parse, but serde_json rejects
    // the lone `\ud800` escape — the TS mirror must reject it too.
    await writeFile(
      path,
      '{"index":0,"branch":"main","kind":"turn","payload":"\\ud800"}\n',
      'utf-8',
    );
    await expect(SessionLog.open(path)).rejects.toThrow(
      'session: line 1: corrupted line (contains an unpaired surrogate, not valid UTF-8)',
    );
    // A paired escape (\ud83d\ude00 = 😀) is valid for both sides.
    await writeFile(
      path,
      '{"index":0,"branch":"main","kind":"turn","payload":"\\ud83d\\ude00"}\n',
      'utf-8',
    );
    const log = await SessionLog.open(path);
    expect(await log.validate()).toEqual([]);
  });

  it('skips whitespace-only lines (still counted for line numbers)', async () => {
    const path = join(await tmp(), 'session.jsonl');
    await writeFile(
      path,
      '{"index":0,"branch":"main","kind":"turn","payload":1}\n   \n\t\n{"index":1,"branch":"main","kind":"turn","payload":2}\n',
      'utf-8',
    );
    const log = await SessionLog.open(path);
    expect(await log.validate()).toEqual([]);
    expect(log.replay('main').eventCount).toBe(2);
  });

  it('rejects a root branch whose first event carries a parent', async () => {
    const path = join(await tmp(), 'session.jsonl');
    await writeFile(
      path,
      '{"index":0,"branch":"main","parent":{"branch":"ghost","index":0},"kind":"turn","payload":1}\n',
      'utf-8',
    );
    expect(await new SessionLog(path).validate()).toEqual([
      "session: line 1: root branch 'main' must not carry a parent",
    ]);
  });

  it('a single index gap reports exactly one error (resync, matching Rust)', async () => {
    const path = join(await tmp(), 'session.jsonl');
    await writeFile(
      path,
      [0, 1, 3, 4]
        .map(i => `{"index":${i},"branch":"main","kind":"turn","payload":${i}}`)
        .join('\n') + '\n',
      'utf-8',
    );
    expect(await new SessionLog(path).validate()).toEqual([
      'session: line 3: branch "main" index 3 is not monotonic (expected 2)',
    ]);
  });

  it('rejects non-monotonic and duplicate (branch,index) on resume', async () => {
    const path = join(await tmp(), 'session.jsonl');
    await writeFile(
      path,
      [
        '{"index":0,"branch":"main","kind":"turn","payload":1}',
        '{"index":0,"branch":"main","kind":"turn","payload":2}',
        '{"index":2,"branch":"main","kind":"turn","payload":3}',
        '{"index":0,"branch":"side","kind":"turn","payload":4}',
      ].join('\n') + '\n',
      'utf-8',
    );
    const errors = await new SessionLog(path).validate();
    expect(errors).toEqual([
      'session: line 2: duplicate event (main, 0)',
      'session: line 3: branch "main" index 2 is not monotonic (expected 1)',
      'session: line 4: first event of branch "side" must carry a parent reference',
    ]);
  });

  it('non-root branch parent must reference an existing (branch,index)', async () => {
    const path = join(await tmp(), 'session.jsonl');
    await writeFile(
      path,
      [
        '{"index":0,"branch":"main","kind":"turn","payload":1}',
        '{"index":0,"branch":"side","parent":{"branch":"main","index":9},"kind":"turn","payload":2}',
      ].join('\n') + '\n',
      'utf-8',
    );
    expect(await new SessionLog(path).validate()).toEqual([
      'session: line 2: parent (main, 9) does not exist',
    ]);
  });

  it('serializes lines in exact wire key order (index, branch, parent, kind, payload)', async () => {
    const path = join(await tmp(), 'session.jsonl');
    const log = new SessionLog(path);
    await log.append('turn', { z: 1 });
    const fork = await log.fork(0, 'side');
    await fork.append('note', null);
    const lines = (await readFile(path, 'utf-8')).trim().split('\n');
    expect(lines[0]).toBe('{"index":0,"branch":"main","kind":"turn","payload":{"z":1}}');
    expect(lines[1]).toBe(
      '{"index":0,"branch":"side","parent":{"branch":"main","index":0},"kind":"fork","payload":null}',
    );
    expect(lines[2]).toBe('{"index":1,"branch":"side","kind":"note","payload":null}');
  });

  it('reproduces the committed cross-language hash fixture', async () => {
    // The Rust mirror pins the SAME fixture — the fold definition in
    // src/session.ts must keep producing exactly this hash.
    const fixture = join(HERE, 'fixtures', 'session-fixture.jsonl');
    const expected = (await readFile(join(HERE, 'fixtures', 'session-fixture.hash'), 'utf-8')).trim();
    const log = await SessionLog.open(fixture);
    expect(log.stateHash('main')).toBe(expected);
  });
});
