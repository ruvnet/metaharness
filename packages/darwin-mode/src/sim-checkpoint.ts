// SPDX-License-Identifier: MIT
// Versioned checkpoint manifests for the SIM journal (#522).
// A manifest is a hint, never an authority: readers verify it against the
// journal bytes and fall back to full verified replay when it does not match.
import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const CHECKPOINT_FORMAT = 'metaharness.sim.checkpoint.v1';
const JOURNAL_FORMAT = 'metaharness.sim.journal.v1';
const MAX_MANIFEST_BYTES = 4 * 1024;

export interface SimCheckpointManifest {
  format: typeof CHECKPOINT_FORMAT;
  journalFormat: typeof JOURNAL_FORMAT;
  /** Byte length of the covered journal prefix. Always ends on a record boundary. */
  offset: number;
  /** Number of records in the covered prefix. */
  records: number;
  /** Hash of the last record in the prefix (null when the prefix is empty). */
  chainHead: string | null;
  /** sha256 over the covered prefix bytes. */
  prefixSha256: string;
  createdAt: string;
}

/** How the last load used the checkpoint manifest. Separate from `JournalRecovery` to keep that contract stable. */
export interface SimCheckpointStatus {
  status: 'disabled' | 'absent' | 'used' | 'rejected';
  /** Why a present manifest was not used (rejected only). */
  reason?: string;
  /** Records covered by the manifest and accepted after prefix verification (no per-record re-verification). */
  checkpointRecords: number;
  /** Records fully re-verified (schema, hash, chain) during the last load. Bounded by records after the checkpoint. */
  replayedRecords: number;
}

/** Test-only fault injection for checkpoint installation. Throwing simulates a crash at that point. */
export interface SimCheckpointFaults {
  beforeCheckpointSync?(): void | Promise<void>;
  beforeCheckpointRename?(): void | Promise<void>;
}

export const checkpointPathFor = (journalPath: string): string => journalPath + '.checkpoint';

export async function syncDir(dir: string): Promise<void> {
  // Windows cannot open a directory for fsync; NTFS metadata is journaled.
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Atomically replaces `path` with `data`: temp file, fsync, rename, directory fsync. */
export async function writeFileAtomic(path: string, data: string | Buffer, faults: SimCheckpointFaults = {}): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await faults.beforeCheckpointSync?.();
      await handle.sync();
    } finally { await handle.close(); }
    await faults.beforeCheckpointRename?.();
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await syncDir(dirname(path));
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** Parses a manifest. Returns a reason string for anything malformed instead of throwing. */
export function parseCheckpointManifest(raw: string): SimCheckpointManifest | string {
  if (Buffer.byteLength(raw) > MAX_MANIFEST_BYTES) return 'manifest too large';
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return 'manifest is not JSON'; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'manifest is not an object';
  const m = value as Record<string, unknown>;
  if (m.format !== CHECKPOINT_FORMAT) return 'unsupported manifest format';
  if (m.journalFormat !== JOURNAL_FORMAT) return 'unsupported journal format';
  if (!Number.isSafeInteger(m.offset) || (m.offset as number) < 0) return 'invalid offset';
  if (!Number.isSafeInteger(m.records) || (m.records as number) < 0) return 'invalid record count';
  if (m.chainHead !== null && !isHex64(m.chainHead)) return 'invalid chain head';
  if ((m.records === 0) !== (m.chainHead === null) || (m.records === 0) !== (m.offset === 0)) return 'inconsistent empty prefix';
  if (!isHex64(m.prefixSha256)) return 'invalid prefix hash';
  if (typeof m.createdAt !== 'string') return 'invalid createdAt';
  return m as unknown as SimCheckpointManifest;
}

/** Reads the manifest next to a journal. `null` when there is none. */
export async function readCheckpointManifest(journalPath: string): Promise<SimCheckpointManifest | string | null> {
  let raw: string;
  try { raw = await readFile(checkpointPathFor(journalPath), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return parseCheckpointManifest(raw);
}

/**
 * Checks a parsed manifest against the complete (newline-terminated) journal bytes.
 * Returns the reason it cannot be used, or null when the covered prefix matches byte for byte.
 */
export function checkManifestAgainst(manifest: SimCheckpointManifest, complete: Buffer): string | null {
  if (manifest.offset > complete.length) return 'offset beyond committed journal';
  if (manifest.offset > 0 && complete[manifest.offset - 1] !== 10) return 'offset not on a record boundary';
  const digest = createHash('sha256').update(complete.subarray(0, manifest.offset)).digest('hex');
  if (digest !== manifest.prefixSha256) return 'prefix hash mismatch';
  return null;
}

export function buildCheckpointManifest(offset: number, records: number, chainHead: string | null, prefixSha256: string): SimCheckpointManifest {
  return {
    format: CHECKPOINT_FORMAT, journalFormat: JOURNAL_FORMAT,
    offset, records, chainHead, prefixSha256, createdAt: new Date().toISOString(),
  };
}
