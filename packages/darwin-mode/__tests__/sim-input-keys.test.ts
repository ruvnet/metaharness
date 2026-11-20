// SPDX-License-Identifier: MIT
// A stored SimAttempt (with hash/previousHash) or any unknown field passed to append()
// used to be written, then fail hash verification on the next load, making the whole
// journal or snapshot unreadable. Append now rejects such input before writing anything.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SimJournal } from '../src/sim-journal.js';
import { SimMemory, validateSimAttemptInput } from '../src/sim-memory.js';
import type { SimAttemptInput } from '../src/sim-memory.js';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c().catch(() => undefined)));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'sim-keys-'));
  dirs.push(d);
  return d;
}
function row(id: string): SimAttemptInput {
  return {
    id, createdAt: '2026-11-20T00:00:00.000Z',
    scope: { ownerId: 'tenant-a', repoId: 'repo-a', interfaceId: 'v1', modelId: 'model-a', benchmarkId: 'b', harnessVersion: 'v1' },
    problemKey: 'retry', diagnosis: 'timeout', variantId: 'v-' + id, parentId: 'baseline',
    mutationSurface: 'retryPolicy', rationale: 'bounded retry', predictedDelta: null,
    observedDelta: -0.03, finalScore: 0.47, promoted: false, evidenceIds: ['archive:' + id],
  };
}

interface Store {
  append(input: SimAttemptInput): Promise<{ id: string; hash: string; previousHash: string | null }>;
  all(): Array<{ id: string; hash: string }>;
}
const backends: Array<[string, (file: string) => Store, (file: string) => Promise<Array<{ id: string; hash: string }>>]> = [
  ['SimJournal', (file) => { const j = new SimJournal(file); closers.push(() => j.close()); return j; },
    async (file) => { const j = new SimJournal(file); await j.load(); return j.all(); }],
  ['SimMemory snapshot', (file) => new SimMemory(file),
    async (file) => { const m = new SimMemory(file); await m.load(); return m.all(); }],
  ['SimMemory journal', (file) => { const m = new SimMemory(file, { persistence: 'journal' }); closers.push(() => m.close()); return m; },
    async (file) => { const m = new SimMemory(file, { persistence: 'journal' }); await m.load(); return m.all(); }],
];

describe.each(backends)('%s append rejects fields outside SimAttemptInput', (_name, make, reload) => {
  const bad: Array<[string, (stored: SimAttemptInput & { hash: string; previousHash: string | null }) => unknown]> = [
    ['a stored SimAttempt (hash + previousHash)', (stored) => ({ ...stored, id: 'again' })],
    ['hash only', (stored) => ({ ...row('h'), hash: stored.hash })],
    ['previousHash only', (stored) => ({ ...row('p'), previousHash: stored.hash })],
    ['an unknown top-level key', () => ({ ...row('u'), note: 'extra' })],
    ['an unknown scope key', () => ({ ...row('s'), scope: { ...row('s').scope, region: 'eu' } })],
    ['a toJSON that adds a key', () => ({ ...row('t'), toJSON() { return { ...row('t'), hash: 'x' }; } })],
  ];
  for (const [label, build] of bad) {
    it(`rejects ${label}; nothing is written and the store still loads`, async () => {
      const file = join(await dir(), 'store');
      const store = make(file);
      const first = await store.append(row('first'));
      const before = await readFile(file);
      const input = build(first as SimAttemptInput & { hash: string; previousHash: string | null });
      await expect(store.append(input as SimAttemptInput)).rejects.toThrow(/unsupported field|invalid/);
      expect(await readFile(file)).toEqual(before);
      expect(store.all().map((r) => r.id)).toEqual(['first']);
      // A valid append afterwards still chains onto the first record, and the file reloads.
      const second = await store.append(row('second'));
      expect(second.previousHash).toBe(first.hash);
      expect((await reload(file)).map((r) => r.id)).toEqual(['first', 'second']);
    });
  }
});

describe('validateSimAttemptInput', () => {
  it('accepts exactly the SimAttemptInput fields and leaves valid input unchanged', () => {
    const input = row('ok');
    const copy = JSON.parse(JSON.stringify(input));
    expect(() => validateSimAttemptInput(input)).not.toThrow();
    expect(input).toEqual(copy);
  });

  it('names the offending fields', () => {
    expect(() => validateSimAttemptInput({ ...row('x'), hash: 'a', previousHash: null }))
      .toThrow('unsupported field(s) hash, previousHash');
  });

  it('a rejected journal append does not take the writer lease', async () => {
    const file = join(await dir(), 'lease.jsonl');
    const journal = new SimJournal(file);
    closers.push(() => journal.close());
    await expect(journal.append({ ...row('x'), hash: 'a' } as SimAttemptInput)).rejects.toThrow('unsupported field');
    expect(journal.holdsLease()).toBe(false);
  });
});
