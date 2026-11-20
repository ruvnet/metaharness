// SPDX-License-Identifier: MIT
// Optional append-only journal for SIM, guarded by a cross-process single-writer lease.
// The existing SimMemory snapshot remains the default for backward compatibility.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { open, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { validateSimAttempt } from './sim-memory.js';
import type { SimAttempt, SimAttemptInput } from './sim-memory.js';

const MAX_LINE = 32 * 1024;
const MAX_RECORDS = 100_000;
const MAX_FILE_BYTES = MAX_RECORDS * MAX_LINE;
const FORMAT = 'metaharness.sim.journal.v1';
const LEASE_FORMAT = 'metaharness.sim.lease.v1';
const DEFAULT_STALE_MS = 10_000;
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
  /** Bytes of an unterminated final record. Never acknowledged; removed only by the lease holder. */
  recoveredTailBytes: number;
}

export interface SimJournalLease {
  format: typeof LEASE_FORMAT;
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
}

/** Test-only fault injection at each write boundary. Throwing simulates a crash at that point. */
export interface SimJournalFaults {
  beforeWrite?(): void | Promise<void>;
  afterPartialWrite?(): void | Promise<void>;
  beforeSync?(): void | Promise<void>;
  beforeClose?(): void | Promise<void>;
}

export interface SimJournalOptions {
  /** Age after which an unreadable (half-written) lease file counts as abandoned. Default 10s. */
  staleLeaseMs?: number;
  faults?: SimJournalFaults;
}

/** Another live writer, or a writer on another host, owns the journal. */
export class SimJournalLockedError extends Error {
  readonly code = 'SIM_JOURNAL_LOCKED';
  constructor(readonly lockPath: string, readonly owner: Partial<SimJournalLease> | null) {
    super(`SIM journal: ${lockPath} is held by ${owner ? `pid ${owner.pid} on ${owner.host}` : 'an unknown writer'}`);
  }
}

// Leases this process holds, released synchronously if the process exits without close().
const held = new Map<string, string>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const [lockPath, token] of held) {
      try { if (JSON.parse(readFileSync(lockPath, 'utf8')).token === token) unlinkSync(lockPath); } catch { /* best effort */ }
    }
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function syncDir(dir: string): Promise<void> {
  // Windows cannot open a directory for fsync; NTFS metadata is journaled.
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readLease(lockPath: string): Promise<{ raw: string; lease: SimJournalLease | null; ageMs: number } | null> {
  try {
    const [raw, info] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    let lease: SimJournalLease | null = null;
    try {
      const parsed = JSON.parse(raw) as SimJournalLease;
      if (parsed?.format === LEASE_FORMAT && Number.isInteger(parsed.pid) && typeof parsed.token === 'string') lease = parsed;
    } catch { /* half-written lease: judged by age */ }
    return { raw, lease, ageMs: Date.now() - info.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Append-only, fsync-on-every-record journal with a single-writer lease.
 *
 * - `load()` is read-only and never modifies the file; any process may read.
 * - The first `append()` (or `acquire()`) takes an exclusive lease file
 *   (`<journal>.lock`, created with O_EXCL). A second writer gets
 *   `SimJournalLockedError`. A lease left by a dead process on this host is
 *   broken under a separate `.break` mutex; leases from other hosts are never
 *   broken automatically (fail closed).
 * - Every append is fenced: it re-reads the lease token and checks the file
 *   size it last committed. If either changed, the instance poisons itself and
 *   commits nothing.
 * - An unterminated final record is never acknowledged. The lease holder copies
 *   it aside (`<journal>.torn-*`) and truncates it; a complete corrupt record is fatal.
 *
 * Local filesystems only. NFS/SMB lock-file semantics and power-loss durability are not verified.
 */
export class SimJournal {
  private records: SimAttempt[] = [];
  private ids = new Set<string>();
  private loaded = false;
  private poisoned = false;
  private closed = false;
  private token: string | null = null;
  private committedSize = 0;
  private pending: Promise<void> = Promise.resolve();
  private recovery: JournalRecovery = { records: 0, recoveredTailBytes: 0 };
  readonly lockPath: string;
  constructor(readonly filePath: string, private readonly options: SimJournalOptions = {}) {
    this.lockPath = filePath + '.lock';
  }

  /** Reads and verifies committed records. Read-only: an incomplete tail is reported, not removed. */
  async load(): Promise<JournalRecovery> {
    if (this.loaded) return { ...this.recovery };
    await this.read();
    return { ...this.recovery };
  }

  private async read(): Promise<number> {
    let bytes: Buffer;
    try {
      const info = await stat(this.filePath);
      if (info.size > MAX_FILE_BYTES) throw new Error('SIM journal: file too large');
      bytes = await readFile(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.records = []; this.ids = new Set(); this.loaded = true;
      this.recovery = { records: 0, recoveredTailBytes: 0 };
      return 0;
    }
    const newline = bytes.lastIndexOf(10);
    const complete = newline < 0 ? Buffer.alloc(0) : bytes.subarray(0, newline + 1);
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
    this.records = parsed;
    this.ids = ids;
    this.loaded = true;
    this.recovery = { records: parsed.length, recoveredTailBytes: bytes.length - complete.length };
    return complete.length;
  }

  /** Takes the single-writer lease, then recovers the journal under it. Idempotent. */
  async acquire(): Promise<void> {
    if (this.closed) throw new Error('SIM journal: closed');
    if (this.token) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const token = randomBytes(16).toString('hex');
    const lease: SimJournalLease = { format: LEASE_FORMAT, pid: process.pid, host: hostname(), token, acquiredAt: new Date().toISOString() };
    for (let attempt = 0; ; attempt++) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(lease)); await handle.sync(); } finally { await handle.close(); }
        await syncDir(dirname(this.lockPath));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const current = await readLease(this.lockPath);
      if (!current) continue; // released between our create and read; retry
      if (attempt >= 3 || !this.isStale(current)) throw new SimJournalLockedError(this.lockPath, current.lease);
      await this.breakStale(current.raw);
    }
    this.token = token;
    held.set(this.lockPath, token);
    installExitHook();
    try { await this.recoverUnderLease(); }
    catch (error) { await this.release(); throw error; }
  }

  private isStale(current: { lease: SimJournalLease | null; ageMs: number }): boolean {
    if (!current.lease) return current.ageMs > (this.options.staleLeaseMs ?? DEFAULT_STALE_MS);
    if (current.lease.host !== hostname()) return false; // cannot probe a remote pid
    // Our own pid: live only if an instance in this process still holds that token
    // (otherwise it is a leftover from an earlier process that reused this pid).
    if (current.lease.pid === process.pid) return held.get(this.lockPath) !== current.lease.token;
    return !isAlive(current.lease.pid);
  }

  // Remove a stale lease only while holding the break mutex, and only if it is
  // byte-identical to the one judged stale (so a fresh lease is never removed).
  private async breakStale(observed: string): Promise<void> {
    const breaker = this.lockPath + '.break';
    let handle;
    try { handle = await open(breaker, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await stat(breaker).catch(() => null);
      if (info && Date.now() - info.mtimeMs > (this.options.staleLeaseMs ?? DEFAULT_STALE_MS)) await unlink(breaker).catch(() => undefined);
      return;
    }
    try {
      await handle.close();
      const again = await readLease(this.lockPath);
      if (again && again.raw === observed) await unlink(this.lockPath);
    } finally { await unlink(breaker).catch(() => undefined); }
  }

  private async recoverUnderLease(): Promise<void> {
    const committed = await this.read();
    const tail = this.recovery.recoveredTailBytes;
    if (tail) {
      // Preserve the unacknowledged bytes for audit, then cut them off.
      const bytes = await readFile(this.filePath);
      const aside = `${this.filePath}.torn-${Date.now()}-${randomBytes(4).toString('hex')}`;
      await writeFile(aside, bytes.subarray(committed), { flag: 'wx', mode: 0o600 });
      const handle = await open(this.filePath, 'r+');
      try { await handle.truncate(committed); await handle.sync(); } finally { await handle.close(); }
    }
    this.committedSize = committed;
  }

  // Fencing: refuse to write unless this instance still owns the lease and the
  // file still ends exactly where this instance last committed.
  private async fence(): Promise<void> {
    const current = await readLease(this.lockPath);
    if (!current?.lease || current.lease.token !== this.token) throw new Error('SIM journal: lease lost; another writer took over');
    const size = await stat(this.filePath).then((s) => s.size, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return 0; throw e; });
    if (size !== this.committedSize) throw new Error('SIM journal: file changed outside this writer');
  }

  async append(input: SimAttemptInput): Promise<SimAttempt> {
    let result: SimAttempt | undefined;
    const faults = this.options.faults ?? {};
    const operation = this.pending.then(async () => {
      if (this.poisoned) throw new Error('SIM journal: previous write failed; close, reopen and recover before retry');
      await this.acquire();
      if (this.records.length >= MAX_RECORDS) throw new Error('SIM journal: capacity exceeded');
      if (this.ids.has(input.id)) throw new Error('SIM journal: duplicate ID');
      validateSimAttempt(input);
      const safe = JSON.parse(JSON.stringify(input)) as SimAttemptInput;
      const unsigned = { ...safe, previousHash: this.records.at(-1)?.hash ?? null };
      const record: SimAttempt = { ...unsigned, hash: sha(unsigned) };
      const buffer = Buffer.from(JSON.stringify({ schema: FORMAT, record }) + '\n');
      if (buffer.length > MAX_LINE) throw new Error('SIM journal: oversized line');
      // Any failure from here on may leave an unterminated record, so poison
      // the instance rather than commit behind a partial line.
      try {
        await this.fence();
        const created = this.committedSize === 0;
        const handle = await open(this.filePath, 'a', 0o600);
        try {
          await faults.beforeWrite?.();
          let written = 0;
          while (written < buffer.length) {
            const chunk = written === 0 && faults.afterPartialWrite ? Math.max(1, buffer.length >> 1) : buffer.length - written;
            const outcome = await handle.write(buffer, written, chunk);
            if (outcome.bytesWritten <= 0) throw new Error('SIM journal: short write');
            written += outcome.bytesWritten;
            if (written < buffer.length) await faults.afterPartialWrite?.();
          }
          await faults.beforeSync?.();
          await handle.sync();
          await faults.beforeClose?.();
        } finally { await handle.close(); }
        if (created) await syncDir(dirname(this.filePath));
      } catch (error) {
        this.poisoned = true;
        throw error;
      }
      this.committedSize += buffer.length;
      this.records.push(record);
      this.ids.add(record.id);
      result = record;
    });
    this.pending = operation.catch(() => undefined);
    await operation;
    return JSON.parse(JSON.stringify(result)) as SimAttempt;
  }

  /** Waits for in-flight appends, then releases the lease. A poisoned instance must be closed before reopening. */
  async close(): Promise<void> {
    await this.pending;
    this.closed = true;
    await this.release();
  }

  private async release(): Promise<void> {
    const token = this.token;
    this.token = null;
    if (!token) return;
    if (held.get(this.lockPath) === token) held.delete(this.lockPath);
    const current = await readLease(this.lockPath);
    if (current?.lease?.token === token) await unlink(this.lockPath);
  }

  holdsLease(): boolean { return this.token !== null; }
  all(): SimAttempt[] { return JSON.parse(JSON.stringify(this.records)) as SimAttempt[]; }
  count(): number { return this.records.length; }
}
