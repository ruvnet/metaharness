// @metaharness/flywheel — hard admission budgets, charged BEFORE external work.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Units are positive safe integers (e.g. microdollars or bounded calls), never an
 * estimated bill settled afterward. An adapter must cap its actual operation at
 * the reserved units. Retries and fallback calls require separate reservations. */
export interface BudgetReservation {
  operationId: string;
  kind: 'proposer' | 'evaluator';
  evaluatorId: string;
  units: number;
}

/** Reserved means the operation may be pending, inflight, completed, or uncertain.
 * All four states consume the FULL reservation forever. In particular, a process
 * crash does not prove a call was never executed. There is intentionally no refund,
 * expiry, or retry-admission API, including for calls that fail or never start. */
export interface ReservedBudgetOperation extends BudgetReservation {
  state: 'reserved';
}

export interface BudgetSnapshot {
  ledgerId: string;
  total: number;
  reserved: number;
  remaining: number;
  operations: ReservedBudgetOperation[];
}

export interface BudgetLimiter {
  readonly durable: boolean;
  /** Resolves only after irrevocable admission. A duplicate operationId REJECTS:
   * returning success for a duplicate would authorize a second uncharged call. */
  reserve(request: BudgetReservation): Promise<void>;
  snapshot(): Promise<BudgetSnapshot>;
}

export type BudgetErrorCode =
  | 'BUDGET_EXCEEDED' | 'BUDGET_DUPLICATE_OPERATION' | 'BUDGET_INVALID_INPUT'
  | 'BUDGET_LEDGER_CORRUPT' | 'BUDGET_LEDGER_MISMATCH' | 'BUDGET_LOCK_TIMEOUT'
  | 'BUDGET_IO_ERROR' | 'BUDGET_UNSUPPORTED_PLATFORM';

export class BudgetLedgerError extends Error {
  readonly code: BudgetErrorCode;
  constructor(code: BudgetErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BudgetLedgerError';
    this.code = code;
  }
}

export class BudgetExceededError extends BudgetLedgerError {
  constructor() {
    super('BUDGET_EXCEEDED', 'The operation exceeds the remaining hard budget.');
    this.name = 'BudgetExceededError';
  }
}

function invalid(message: string): never {
  throw new BudgetLedgerError('BUDGET_INVALID_INPUT', message);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
}

function validateTotal(total: number): void {
  if (!Number.isSafeInteger(total) || total < 0) invalid('Budget total must be a nonnegative safe integer.');
}

function copyRequest(request: BudgetReservation): BudgetReservation {
  if (!request || !validId(request.operationId) || !validId(request.evaluatorId)
      || (request.kind !== 'proposer' && request.kind !== 'evaluator')
      || !Number.isSafeInteger(request.units) || request.units <= 0) {
    invalid('A reservation requires operationId, evaluatorId, proposer/evaluator kind, and positive safe-integer units.');
  }
  return { operationId: request.operationId, kind: request.kind, evaluatorId: request.evaluatorId, units: request.units };
}

function snapshot(ledgerId: string, total: number, operations: ReservedBudgetOperation[]): BudgetSnapshot {
  const reserved = operations.reduce((sum, operation) => sum + operation.units, 0);
  return { ledgerId, total, reserved, remaining: total - reserved, operations: operations.map((operation) => ({ ...operation })) };
}

function checkAdmission(state: BudgetSnapshot, request: BudgetReservation): void {
  if (state.operations.some((operation) => operation.operationId === request.operationId)) {
    throw new BudgetLedgerError('BUDGET_DUPLICATE_OPERATION', `Operation ${request.operationId} is already charged; its execution state is unknown.`);
  }
  if (request.units > state.remaining) throw new BudgetExceededError();
}

/** For deterministic offline/research use only; not a restart-safe production budget. */
export class InMemoryBudgetLimiter implements BudgetLimiter {
  readonly durable = false;
  private readonly total: number;
  private readonly ledgerId: string;
  private readonly operations: ReservedBudgetOperation[] = [];

  constructor(total: number, ledgerId: string = randomUUID()) {
    validateTotal(total);
    if (!validId(ledgerId)) invalid('ledgerId must be a nonempty string.');
    this.total = total;
    this.ledgerId = ledgerId;
  }

  async reserve(request: BudgetReservation): Promise<void> {
    const operation = copyRequest(request);
    checkAdmission(snapshot(this.ledgerId, this.total, this.operations), operation);
    // No await between the check and mutation: simultaneous callers cannot oversubscribe.
    this.operations.push({ ...operation, state: 'reserved' });
  }

  async snapshot(): Promise<BudgetSnapshot> {
    return snapshot(this.ledgerId, this.total, this.operations);
  }
}

export interface FileBudgetLimiterOptions {
  /** Ledger file in an existing durable directory. Its .head and .lock siblings
   * belong to the same ledger. */
  path: string;
  total: number;
  /** Optional expected identity. An existing ledger must match; it is never reset. */
  ledgerId?: string;
  /** Maximum time to wait for another owner, default 5 seconds. A timeout never
   * steals the lock, even when its owner appears dead. */
  lockTimeoutMs?: number;
}

type Paths = { directory: string; ledger: string; head: string; lock: string };
type Header = { version: 1; ledgerId: string; total: number; hash: string };
type Entry = ReservedBudgetOperation & { sequence: number; previousHash: string; hash: string };
type Head = { version: 1; ledgerId: string; sequence: number; hash: string };
type State = { snapshot: BudgetSnapshot; head: Head };

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function corrupt(message: string): never {
  throw new BudgetLedgerError('BUDGET_LEDGER_CORRUPT', message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return corrupt('Budget ledger contains invalid JSON.'); }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readRegularFile(path: string): Promise<string | null> {
  // Do not follow a ledger symlink: aliases could otherwise use different locks.
  try {
    const info = await lstat(path);
    if (!info.isFile()) corrupt('Budget ledger and head must be regular files.');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await file.readFile('utf8'); } finally { await file.close(); }
}

/** Durable append-only admission ledger for cooperating processes on a local
 * POSIX filesystem with atomic mkdir/rename and working file+directory fsync.
 * Intended for Linux/macOS; Windows is rejected synchronously before filesystem
 * access with BUDGET_UNSUPPORTED_PLATFORM. Node's Windows filesystem API does not
 * provide the directory fsync contract required here; durability is NEVER weakened
 * to silently accept Windows. Use an independently durable injected limiter there.
 * Network filesystems or malicious writers are outside this implementation's contract.
 *
 * The hash chain plus independently synced head detects malformed, reordered,
 * partially written, and cleanly truncated tails. A failure during a write leaves
 * the lock in place. Never automatically remove stale locks: recovery requires
 * an operator to reconcile the ledger/head and external execution first. Even a
 * reconciled unused reservation must stay charged. Back up ledger and head as a
 * pair; replacing/deleting both is not supported recovery. Signed checkpoints
 * should bind ledgerId and the operation history to detect whole-ledger rollback.
 */
export class FileBudgetLimiter implements BudgetLimiter {
  readonly durable = true;
  private readonly options: FileBudgetLimiterOptions;
  private pathsPromise?: Promise<Paths>;

  constructor(options: FileBudgetLimiterOptions) {
    if (process.platform === 'win32' || typeof constants.O_NOFOLLOW !== 'number') {
      throw new BudgetLedgerError('BUDGET_UNSUPPORTED_PLATFORM', 'FileBudgetLimiter requires POSIX file and directory fsync; Windows is unsupported.');
    }
    if (!options || !validId(options.path)) invalid('A ledger path is required.');
    validateTotal(options.total);
    if (options.ledgerId !== undefined && !validId(options.ledgerId)) invalid('ledgerId must be a nonempty string.');
    if (options.lockTimeoutMs !== undefined && (!Number.isSafeInteger(options.lockTimeoutMs) || options.lockTimeoutMs < 0)) {
      invalid('lockTimeoutMs must be a nonnegative safe integer.');
    }
    this.options = { ...options };
  }

  async reserve(request: BudgetReservation): Promise<void> {
    // Freeze the validated values before yielding to filesystem work.
    const operation = copyRequest(request);
    await this.withLock(async (paths, write) => {
      const state = await this.readState(paths, write);
      checkAdmission(state.snapshot, operation);
      const body = { ...operation, state: 'reserved' as const, sequence: state.head.sequence + 1, previousHash: state.head.hash };
      const entry: Entry = { ...body, hash: hash(body) };
      await write(async () => {
        const file = await open(paths.ledger, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
        try {
          await file.writeFile(`${JSON.stringify(entry)}\n`);
          await file.sync();
        } finally { await file.close(); }
        await this.writeHead(paths, { ...state.head, sequence: entry.sequence, hash: entry.hash });
      });
    });
  }

  async snapshot(): Promise<BudgetSnapshot> {
    return this.withLock(async (paths, write) => (await this.readState(paths, write)).snapshot);
  }

  private paths(): Promise<Paths> {
    this.pathsPromise ??= (async () => {
      const path = resolve(this.options.path);
      // Parent-directory symlink aliases must all coordinate on the same lock.
      const directory = await realpath(dirname(path));
      const ledger = join(directory, basename(path));
      return { directory, ledger, head: `${ledger}.head`, lock: `${ledger}.lock` };
    })();
    return this.pathsPromise;
  }

  private async withLock<T>(work: (paths: Paths, write: (fn: () => Promise<void>) => Promise<void>) => Promise<T>): Promise<T> {
    let paths: Paths;
    try { paths = await this.paths(); }
    catch (error) { throw new BudgetLedgerError('BUDGET_IO_ERROR', 'Cannot open the budget ledger directory.', { cause: error }); }
    const deadline = performance.now() + (this.options.lockTimeoutMs ?? 5000);
    for (;;) {
      try { await mkdir(paths.lock); break; }
      catch (error) {
        if (errorCode(error) !== 'EEXIST') throw new BudgetLedgerError('BUDGET_IO_ERROR', 'Cannot acquire budget ledger lock.', { cause: error });
        if (performance.now() >= deadline) throw new BudgetLedgerError('BUDGET_LOCK_TIMEOUT', 'Budget lock is busy or stale; refusing to steal it.');
        await delay(Math.min(10, Math.max(1, deadline - performance.now())));
      }
    }
    let uncertainWrite = false;
    const write = async (fn: () => Promise<void>): Promise<void> => {
      uncertainWrite = true;
      await fn();
      uncertainWrite = false;
    };
    try {
      // Persist ownership before any ledger mutation; failure leaves a closed lock.
      await write(() => syncDirectory(paths.directory));
      return await work(paths, write);
    } catch (error) {
      if (error instanceof BudgetLedgerError) throw error;
      throw new BudgetLedgerError('BUDGET_IO_ERROR', 'Budget ledger I/O failed; no operation is admitted.', { cause: error });
    } finally {
      if (!uncertainWrite) {
        await rmdir(paths.lock);
        await syncDirectory(paths.directory);
      }
    }
  }

  private async writeHead(paths: Paths, head: Head): Promise<void> {
    // The temporary file stays INSIDE the lock, so uncertain writes cannot leave
    // an uncoordinated sibling that another caller might mistake for a new ledger.
    const temporary = join(paths.lock, 'next-head');
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(head)}\n`);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, paths.head);
    await syncDirectory(paths.directory);
  }

  private async readState(paths: Paths, write: (fn: () => Promise<void>) => Promise<void>): Promise<State> {
    const ledgerText = await readRegularFile(paths.ledger);
    const headText = await readRegularFile(paths.head);
    if (ledgerText === null && headText === null) {
      const body = { version: 1 as const, ledgerId: this.options.ledgerId ?? randomUUID(), total: this.options.total };
      const header: Header = { ...body, hash: hash(body) };
      const head: Head = { version: 1, ledgerId: body.ledgerId, sequence: 0, hash: header.hash };
      await write(async () => {
        const file = await open(paths.ledger, 'wx', 0o600);
        try {
          await file.writeFile(`${JSON.stringify(header)}\n`);
          await file.sync();
        } finally { await file.close(); }
        await this.writeHead(paths, head);
      });
      return { snapshot: snapshot(body.ledgerId, body.total, []), head };
    }
    if (ledgerText === null || headText === null) corrupt('Budget ledger or its committed head is missing.');
    if (!ledgerText.endsWith('\n')) corrupt('Budget ledger has an incomplete final record.');
    const lines = ledgerText.slice(0, -1).split('\n');
    const rawHeader = parseJson(lines.shift()!);
    if (!isObject(rawHeader) || !hasKeys(rawHeader, ['version', 'ledgerId', 'total', 'hash'])
        || rawHeader.version !== 1 || !validId(rawHeader.ledgerId)
        || !Number.isSafeInteger(rawHeader.total) || (rawHeader.total as number) < 0) corrupt('Invalid budget ledger header.');
    const header = rawHeader as unknown as Header;
    if (header.hash !== hash({ version: header.version, ledgerId: header.ledgerId, total: header.total })) corrupt('Budget ledger header checksum mismatch.');
    if (header.total !== this.options.total || (this.options.ledgerId !== undefined && this.options.ledgerId !== header.ledgerId)) {
      throw new BudgetLedgerError('BUDGET_LEDGER_MISMATCH', 'Budget total or identity differs from the existing ledger.');
    }
    const operations: ReservedBudgetOperation[] = [];
    const ids = new Set<string>();
    let previousHash = header.hash;
    let reserved = 0;
    for (const line of lines) {
      const rawEntry = parseJson(line);
      if (!isObject(rawEntry) || !hasKeys(rawEntry, ['operationId', 'kind', 'evaluatorId', 'units', 'state', 'sequence', 'previousHash', 'hash'])) {
        corrupt('Invalid budget reservation record.');
      }
      const entry = rawEntry as unknown as Entry;
      let operation: BudgetReservation;
      try { operation = copyRequest(entry); } catch { return corrupt('Invalid persisted budget reservation.'); }
      const body = { ...operation, state: entry.state, sequence: entry.sequence, previousHash: entry.previousHash };
      if (entry.state !== 'reserved' || entry.sequence !== operations.length + 1
          || entry.previousHash !== previousHash || entry.hash !== hash(body)
          || ids.has(entry.operationId) || entry.units > header.total - reserved) {
        corrupt('Budget reservation history is corrupt or exceeds its limit.');
      }
      ids.add(entry.operationId);
      reserved += entry.units;
      previousHash = entry.hash;
      operations.push({ ...operation, state: 'reserved' });
    }
    const rawHead = parseJson(headText);
    if (!isObject(rawHead) || !hasKeys(rawHead, ['version', 'ledgerId', 'sequence', 'hash'])
        || rawHead.version !== 1 || rawHead.ledgerId !== header.ledgerId
        || rawHead.sequence !== operations.length || rawHead.hash !== previousHash) {
      corrupt('Budget ledger does not match its committed head.');
    }
    return { snapshot: snapshot(header.ledgerId, header.total, operations), head: rawHead as unknown as Head };
  }
}
