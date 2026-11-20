// SPDX-License-Identifier: MIT
// Explicit, verified moves between the SIM snapshot (metaharness.sim.v1) and the
// append-only journal (#522). Records are copied verbatim, so every field — negative
// outcomes, evidence ids, scope — and the hash chain survive unchanged.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SimJournal } from './sim-journal.js';
import { SimMemory, validateSimAttempt } from './sim-memory.js';
import type { SimAttempt } from './sim-memory.js';
import { writeFileAtomic } from './sim-checkpoint.js';

const JOURNAL_FORMAT = 'metaharness.sim.journal.v1';
const SNAPSHOT_FORMAT = 'metaharness.sim.v1';
const SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;

export interface SimMigrationResult {
  /** `migrated` wrote the target; `unchanged` found an identical target and wrote nothing. */
  status: 'migrated' | 'unchanged';
  records: number;
  chainHead: string | null;
}

function chainHead(records: SimAttempt[]): string | null { return records.at(-1)?.hash ?? null; }

/** Throws unless `records` is a well-formed, hash-linked SIM chain with unique ids. */
export function verifySimChain(records: SimAttempt[]): void {
  let previous: string | null = null;
  const ids = new Set<string>();
  for (const record of records) {
    validateSimAttempt(record);
    if (record.previousHash !== previous || typeof record.hash !== 'string') throw new Error('SIM migrate: broken chain');
    const { hash, ...unsigned } = record;
    if (createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') !== hash) throw new Error('SIM migrate: invalid hash');
    if (ids.has(record.id)) throw new Error('SIM migrate: duplicate id');
    ids.add(record.id);
    previous = hash;
  }
}

function sameChain(a: SimAttempt[], b: SimAttempt[]): boolean {
  return a.length === b.length && a.every((r, i) => r.hash === b[i].hash && r.id === b[i].id);
}

function distinct(a: string, b: string): void {
  if (resolve(a) === resolve(b)) throw new Error('SIM migrate: source and target must be different files');
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; });
}

/**
 * Writes an already-hashed SIM chain to a new journal in one atomic step
 * (temp file + fsync + rename + directory fsync), under the journal's writer lease,
 * then installs a checkpoint covering it. Idempotent: an identical existing journal
 * is left untouched; a different non-empty journal is refused.
 */
export async function writeSimJournal(records: SimAttempt[], journalPath: string): Promise<SimMigrationResult> {
  verifySimChain(records);
  const target = new SimJournal(journalPath);
  try {
    await target.acquire();
    const existing = target.all();
    if (existing.length > 0) {
      if (!sameChain(existing, records)) throw new Error('SIM migrate: target journal already holds different records');
      return { status: 'unchanged', records: existing.length, chainHead: chainHead(existing) };
    }
    const body = records.map((record) => JSON.stringify({ schema: JOURNAL_FORMAT, record })).join('\n');
    await writeFileAtomic(journalPath, records.length ? body + '\n' : '');
  } finally { await target.close(); }
  // Reopen: recovery re-verifies the whole file and recomputes the committed hash.
  const check = new SimJournal(journalPath, { checkpoints: false });
  try {
    await check.acquire();
    if (!sameChain(check.all(), records)) throw new Error('SIM migrate: verification after write failed');
    await check.checkpoint();
  } finally { await check.close(); }
  return { status: 'migrated', records: records.length, chainHead: chainHead(records) };
}

/** Snapshot → journal. The snapshot is read and fully verified, and never modified. */
export async function migrateSimSnapshotToJournal(snapshotPath: string, journalPath: string): Promise<SimMigrationResult> {
  distinct(snapshotPath, journalPath);
  if (!(await exists(snapshotPath))) throw new Error('SIM migrate: snapshot not found');
  const source = new SimMemory(snapshotPath);
  await source.load();
  const records = source.all();
  const result = await writeSimJournal(records, journalPath);
  if (result.records !== records.length || result.chainHead !== chainHead(records)) throw new Error('SIM migrate: count or chain head mismatch');
  return result;
}

/**
 * Journal → snapshot (rollback). Holds the journal's writer lease while copying so no
 * append can land mid-copy. Fails closed if the result would exceed the snapshot's
 * 16 MB limit. The journal is never modified. An identical existing snapshot is left
 * untouched; a different existing snapshot is refused.
 */
export async function rollbackSimJournalToSnapshot(journalPath: string, snapshotPath: string): Promise<SimMigrationResult> {
  distinct(snapshotPath, journalPath);
  const journal = new SimJournal(journalPath, { checkpoints: false });
  try {
    await journal.acquire();
    const records = journal.all();
    if (await exists(snapshotPath)) {
      const current = new SimMemory(snapshotPath);
      await current.load();
      if (!sameChain(current.all(), records)) throw new Error('SIM migrate: target snapshot already holds different records');
      return { status: 'unchanged', records: records.length, chainHead: chainHead(records) };
    }
    // Same layout SimMemory.persist() writes.
    const data = JSON.stringify({ schema: SNAPSHOT_FORMAT, records }, null, 2);
    if (Buffer.byteLength(data, 'utf8') > SNAPSHOT_MAX_BYTES) {
      throw new Error(`SIM migrate: ${records.length} records exceed the snapshot's 16 MB limit; keep the journal`);
    }
    await writeFileAtomic(snapshotPath, data);
    const check = new SimMemory(snapshotPath);
    await check.load();
    if (!sameChain(check.all(), records)) throw new Error('SIM migrate: verification after write failed');
    // Byte-level guard: the snapshot must hold exactly what was written.
    if ((await readFile(snapshotPath, 'utf8')) !== data) throw new Error('SIM migrate: snapshot changed during rollback');
    return { status: 'migrated', records: records.length, chainHead: chainHead(records) };
  } finally { await journal.close(); }
}
