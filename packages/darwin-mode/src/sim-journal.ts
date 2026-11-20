// SPDX-License-Identifier: MIT
// Optional append-only journal for SIM. A single writer owns each journal path.
// The existing SimMemory snapshot remains the default for backward compatibility.
import { createHash } from 'node:crypto';
import { open, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateSimAttempt } from './sim-memory.js';
import type { SimAttempt, SimAttemptInput } from './sim-memory.js';

const MAX_LINE = 32 * 1024;
const MAX_RECORDS = 100_000;
const FORMAT = 'metaharness.sim.journal.v1';
const sha = (record: Omit<SimAttempt, 'hash'>): string =>
  createHash('sha256').update(JSON.stringify(record)).digest('hex');

function verify(candidate: unknown, previous: string | null): asserts candidate is SimAttempt {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('SIM journal: invalid record');
  const row = candidate as Record<string, unknown>;
  if (row.previousHash !== previous || typeof row.hash !== 'string') throw new Error('SIM journal: broken chain');
  const { hash, ...unsigned } = row;
  if (sha(unsigned as unknown as Omit<SimAttempt, 'hash'>) !== hash) throw new Error('SIM journal: invalid hash');
}

export interface JournalRecovery {
  records: number;
  recoveredTailBytes: number;
}

/**
 * Append-only, fsync-on-every-record journal. Recovery only truncates a final
 * incomplete line; a complete malformed line is fatal. Not multi-process safe.
 * Do not share a journal path across writers without an external lock.
 */
export class SimJournal {
  private records: SimAttempt[] = [];
  private ids = new Set<string>();
  private loaded = false;
  private pending: Promise<void> = Promise.resolve();
  private recovery: JournalRecovery = { records: 0, recoveredTailBytes: 0 };
  constructor(readonly filePath: string) {}

  async load(): Promise<JournalRecovery> {
    if (this.loaded) return { ...this.recovery };
    let bytes: Buffer;
    try { bytes = await readFile(this.filePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.loaded = true;
      return { ...this.recovery };
    }
    const newline = bytes.lastIndexOf(10);
    const complete = newline < 0 ? Buffer.alloc(0) : bytes.subarray(0, newline + 1);
    const tail = bytes.length - complete.length;
    let previous: string | null = null;
    const ids = new Set<string>();
    const parsed: SimAttempt[] = [];
    for (const line of complete.toString('utf8').split('\n')) {
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_LINE) throw new Error('SIM journal: oversized line');
      let envelope: unknown;
      try { envelope = JSON.parse(line); } catch { throw new Error('SIM journal: corrupt committed line'); }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('SIM journal: corrupt envelope');
      const item = envelope as { schema?: unknown; record?: unknown };
      if (item.schema !== FORMAT) throw new Error('SIM journal: incompatible schema');
      validateSimAttempt(item.record);
      verify(item.record, previous);
      const record = item.record as SimAttempt;
      if (ids.has(record.id)) throw new Error('SIM journal: duplicate ID');
      ids.add(record.id);
      parsed.push(record);
      previous = record.hash;
      if (parsed.length > MAX_RECORDS) throw new Error('SIM journal: capacity exceeded');
    }
    if (tail) {
      // Incomplete final line is not committed. Remove it before next append.
      const handle = await open(this.filePath, 'r+');
      try { await handle.truncate(complete.length); await handle.sync(); } finally { await handle.close(); }
    }
    this.records = parsed;
    this.ids = ids;
    this.loaded = true;
    this.recovery = { records: parsed.length, recoveredTailBytes: tail };
    return { ...this.recovery };
  }

  async append(input: SimAttemptInput): Promise<SimAttempt> {
    let result: SimAttempt | undefined;
    const operation = this.pending.then(async () => {
      await this.load();
      if (this.records.length >= MAX_RECORDS) throw new Error('SIM journal: capacity exceeded');
      if (this.ids.has(input.id)) throw new Error('SIM journal: duplicate ID');
      validateSimAttempt(input);
      const safe = JSON.parse(JSON.stringify(input)) as SimAttemptInput;
      const unsigned = { ...safe, previousHash: this.records.at(-1)?.hash ?? null };
      const record: SimAttempt = { ...unsigned, hash: sha(unsigned) };
      const line = JSON.stringify({ schema: FORMAT, record }) + '\n';
      if (Buffer.byteLength(line) > MAX_LINE) throw new Error('SIM journal: oversized line');
      await mkdir(dirname(this.filePath), { recursive: true });
      const handle = await open(this.filePath, 'a', 0o600);
      try {
        const buffer = Buffer.from(line);
        let written = 0;
        while (written < buffer.length) {
          const outcome = await handle.write(buffer, written, buffer.length - written);
          if (outcome.bytesWritten <= 0) throw new Error('SIM journal: short write');
          written += outcome.bytesWritten;
        }
        await handle.sync();
      } finally { await handle.close(); }
      this.records.push(record);
      this.ids.add(record.id);
      result = record;
    });
    this.pending = operation.catch(() => undefined);
    await operation;
    return JSON.parse(JSON.stringify(result)) as SimAttempt;
  }

  all(): SimAttempt[] { return JSON.parse(JSON.stringify(this.records)) as SimAttempt[]; }
  count(): number { return this.records.length; }
}

