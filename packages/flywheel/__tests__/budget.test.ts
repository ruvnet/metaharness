import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import {
  BudgetExceededError, FileBudgetLimiter, InMemoryBudgetLimiter,
  type BudgetLimiter, type BudgetReservation,
} from '../src/budget.js';

// Wrap only rename so a filesystem failure can be injected at the actual commit
// boundary. Every non-faulted call still uses Node's real filesystem operation.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const directories: string[] = [];
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'flywheel-budget-'));
  directories.push(path);
  return path;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function operation(operationId: string, units = 1): BudgetReservation {
  return { operationId, kind: 'evaluator', evaluatorId: 'offline-fixture-v1', units };
}

const supportsFileBudget = process.platform !== 'win32' && typeof constants.O_NOFOLLOW === 'number';
// Every platform tests memory admission. Durability cases are defined only where
// the public file implementation is supported; Windows explicitly tests denial.
const implementations = supportsFileBudget ? ['memory', 'file'] as const : ['memory'] as const;
for (const implementation of implementations) {
  describe(`${implementation} hard operation budget`, () => {
    async function limiter(total: number): Promise<BudgetLimiter> {
      return implementation === 'memory'
        ? new InMemoryBudgetLimiter(total, 'test-ledger')
        : new FileBudgetLimiter({ path: join(await directory(), 'ledger'), total, ledgerId: 'test-ledger' });
    }

    it('admits before execution and rejects before an overspending call starts', async () => {
      const budget = await limiter(3);
      const calls: string[] = [];
      const evaluate = async (id: string, units: number) => {
        await budget.reserve(operation(id, units));
        calls.push(id); // Offline stand-in; never invokes a model or remote service.
      };
      await evaluate('root', 2);
      await expect(evaluate('candidate', 2)).rejects.toBeInstanceOf(BudgetExceededError);
      expect(calls).toEqual(['root']);
      expect(await budget.snapshot()).toMatchObject({ total: 3, reserved: 2, remaining: 1 });
    });

    it('counts proposer and evaluator reservations against the same total', async () => {
      const budget = await limiter(2);
      await budget.reserve({ ...operation('propose'), kind: 'proposer' });
      await budget.reserve(operation('evaluate'));
      await expect(budget.reserve(operation('anchor'))).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
      expect((await budget.snapshot()).operations.map((entry) => entry.kind)).toEqual(['proposer', 'evaluator']);
    });

    it('does not refund failures or pending/uncertain execution', async () => {
      const budget = await limiter(3);
      await budget.reserve(operation('not-yet-started'));
      await expect((async () => {
        await budget.reserve(operation('executed-and-failed'));
        throw new Error('external call failed after spending');
      })()).rejects.toThrow('external call failed');
      await budget.reserve(operation('response-lost'));
      await expect(budget.reserve(operation('retry'))).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
      const state = await budget.snapshot();
      expect(state).toMatchObject({ reserved: 3, remaining: 0 });
      expect(state.operations.every((entry) => entry.state === 'reserved')).toBe(true);
    });

    it('does not admit duplicate execution, even with a changed cost or caller', async () => {
      const budget = await limiter(10);
      await budget.reserve(operation('same-id', 2));
      for (const duplicate of [operation('same-id', 2), { ...operation('same-id'), kind: 'proposer' as const, evaluatorId: 'different' }]) {
        await expect(budget.reserve(duplicate)).rejects.toMatchObject({ code: 'BUDGET_DUPLICATE_OPERATION' });
      }
      expect((await budget.snapshot()).reserved).toBe(2);
    });

    it('never exceeds total under concurrent admission', async () => {
      const budget = await limiter(7);
      const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => budget.reserve(operation(`concurrent-${i}`, 2))));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
      expect((await budget.snapshot()).reserved).toBe(6);
    });

    it('returns detached snapshots and freezes arguments before async work', async () => {
      const budget = await limiter(5);
      const request = operation('original', 2);
      const admission = budget.reserve(request);
      request.units = 5;
      request.operationId = 'mutated';
      await admission;
      const first = await budget.snapshot();
      first.operations[0].units = 0;
      first.operations.splice(0, 1);
      first.total = 900;
      expect(await budget.snapshot()).toEqual({
        ledgerId: 'test-ledger', total: 5, reserved: 2, remaining: 3,
        operations: [{ ...operation('original', 2), state: 'reserved' }],
      });
    });

    it('treats a zero limit as zero available work', async () => {
      const budget = await limiter(0);
      await expect(budget.reserve(operation('root'))).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
      expect((await budget.snapshot()).reserved).toBe(0);
    });

    it.each([0, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid reservation units %s', async (units) => {
      const budget = await limiter(5);
      await expect(budget.reserve(operation('invalid', units))).rejects.toMatchObject({ code: 'BUDGET_INVALID_INPUT' });
      expect((await budget.snapshot()).reserved).toBe(0);
    });

    it('rejects invalid operation identity and kind', async () => {
      const budget = await limiter(5);
      for (const input of [operation(''), { ...operation('ok'), evaluatorId: '' }, { ...operation('ok'), kind: 'unknown' }]) {
        await expect(budget.reserve(input as BudgetReservation)).rejects.toMatchObject({ code: 'BUDGET_INVALID_INPUT' });
      }
    });

    it('handles maximum safe integer without overflow admission', async () => {
      const budget = await limiter(Number.MAX_SAFE_INTEGER);
      await budget.reserve(operation('large', Number.MAX_SAFE_INTEGER));
      await expect(budget.reserve(operation('overflow'))).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
      expect((await budget.snapshot()).remaining).toBe(0);
    });
  });
}

describe('durable budget ledger', () => {
  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid totals %s', (total) => {
    expect(() => new InMemoryBudgetLimiter(total)).toThrow();
    expect(() => new FileBudgetLimiter({ path: 'ledger', total })).toThrow();
  });

  it('fails closed on Windows before any file writes or operation execution', async () => {
    const dir = await directory();
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    let operationStarted = false;
    let failure: unknown;
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
      try {
        new FileBudgetLimiter({ path: join(dir, 'ledger'), total: 1 });
        operationStarted = true;
      } catch (error) { failure = error; }
    } finally { Object.defineProperty(process, 'platform', descriptor); }
    expect(failure).toMatchObject({ code: 'BUDGET_UNSUPPORTED_PLATFORM' });
    expect(operationStarted).toBe(false);
    expect(await readdir(dir)).toEqual([]);
    expect(new InMemoryBudgetLimiter(1).durable).toBe(false);
  });

  // This is explicit capability coverage, not a skipped durability claim on Windows.
  if (!supportsFileBudget) {
    it('rejects native unsupported-platform file admission and snapshot setup', async () => {
      const dir = await directory();
      for (const path of [join(dir, 'new-ledger'), join(dir, 'restored-ledger')]) {
        expect(() => new FileBudgetLimiter({ path, total: 1 })).toThrow('Windows is unsupported');
      }
      expect(await readdir(dir)).toEqual([]);
    });
    return;
  }

  it('distinguishes restart-safe from in-memory admission', async () => {
    expect(new InMemoryBudgetLimiter(1).durable).toBe(false);
    expect(new FileBudgetLimiter({ path: join(await directory(), 'ledger'), total: 1 }).durable).toBe(true);
  });

  it('restores identical spend and identity on restart without requiring a supplied identity', async () => {
    const path = join(await directory(), 'ledger');
    const first = new FileBudgetLimiter({ path, total: 3 });
    await first.reserve(operation('already-executed', 2));
    const checkpoint = await first.snapshot();
    const resumed = new FileBudgetLimiter({ path, total: 3 });
    expect(await resumed.snapshot()).toEqual(checkpoint);
    await expect(resumed.reserve(operation('already-executed', 2))).rejects.toMatchObject({ code: 'BUDGET_DUPLICATE_OPERATION' });
    await expect(resumed.reserve(operation('after-restart', 2))).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    await resumed.reserve(operation('last-unit'));
    expect((await first.snapshot()).remaining).toBe(0);
  });

  it('rejects reopening a ledger with a changed cap or identity', async () => {
    const path = join(await directory(), 'ledger');
    await new FileBudgetLimiter({ path, total: 2, ledgerId: 'original' }).reserve(operation('first'));
    for (const changed of [{ total: 3, ledgerId: 'original' }, { total: 2, ledgerId: 'other' }]) {
      await expect(new FileBudgetLimiter({ path, ...changed }).snapshot()).rejects.toMatchObject({ code: 'BUDGET_LEDGER_MISMATCH' });
    }
  });

  it.each(['malformed', 'partial-tail', 'changed-units', 'missing-ledger', 'missing-head', 'truncated-tail', 'reordered-records', 'duplicated-record', 'changed-head'])('fails closed for %s corruption', async (corruption) => {
    const path = join(await directory(), 'ledger');
    const budget = new FileBudgetLimiter({ path, total: 5 });
    await budget.reserve(operation('first'));
    await budget.reserve(operation('second'));
    const original = await readFile(path, 'utf8');
    const lines = original.trimEnd().split('\n');
    if (corruption === 'malformed') await writeFile(path, '{not-json}\n');
    if (corruption === 'partial-tail') await writeFile(path, original.slice(0, -1));
    if (corruption === 'changed-units') await writeFile(path, original.replace('"units":1', '"units":2'));
    if (corruption === 'missing-ledger') await rm(path);
    if (corruption === 'missing-head') await rm(`${path}.head`);
    if (corruption === 'truncated-tail') await writeFile(path, `${lines.slice(0, -1).join('\n')}\n`);
    if (corruption === 'reordered-records') await writeFile(path, `${[lines[0], lines[2], lines[1]].join('\n')}\n`);
    if (corruption === 'duplicated-record') await writeFile(path, `${original}${lines[1]}\n`);
    if (corruption === 'changed-head') await writeFile(`${path}.head`, '{}\n');
    const resumed = new FileBudgetLimiter({ path, total: 5 });
    await expect(resumed.snapshot()).rejects.toMatchObject({ code: 'BUDGET_LEDGER_CORRUPT' });
    await expect(resumed.reserve(operation('should-not-run'))).rejects.toMatchObject({ code: 'BUDGET_LEDGER_CORRUPT' });
  });

  it('never steals stale locks or resets spend to recover', async () => {
    const path = join(await directory(), 'ledger');
    const budget = new FileBudgetLimiter({ path, total: 2, lockTimeoutMs: 20 });
    await budget.reserve(operation('first'));
    const original = await readFile(path, 'utf8');
    await mkdir(`${path}.lock`); // A crashed process may have spent its full reservation.
    await expect(budget.reserve(operation('second'))).rejects.toMatchObject({ code: 'BUDGET_LOCK_TIMEOUT' });
    await expect(budget.snapshot()).rejects.toMatchObject({ code: 'BUDGET_LOCK_TIMEOUT' });
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('keeps an uncertain write locked and never admits execution after fsync fails', async () => {
    const path = join(await directory(), 'ledger');
    const budget = new FileBudgetLimiter({ path, total: 2, lockTimeoutMs: 10 });
    await budget.snapshot();
    const handle = await open(path, 'r');
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const originalSync = prototype.sync;
    let syncCalls = 0;
    const fault = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: unknown) {
      if (++syncCalls === 2) throw new Error('injected fsync failure'); // Directory succeeds, append fails.
      return originalSync.call(this);
    });
    try {
      await expect(budget.reserve(operation('uncertain'))).rejects.toMatchObject({ code: 'BUDGET_IO_ERROR' });
    } finally { fault.mockRestore(); }
    await expect(budget.reserve(operation('retry'))).rejects.toMatchObject({ code: 'BUDGET_LOCK_TIMEOUT' });
    await expect(new FileBudgetLimiter({ path, total: 2, lockTimeoutMs: 10 }).snapshot()).rejects.toMatchObject({ code: 'BUDGET_LOCK_TIMEOUT' });
    // Even manually clearing the stale lock cannot silently discard the uncommitted
    // appended reservation: its stale head detects the uncertain write and closes.
    await rm(`${path}.lock`, { recursive: true });
    await expect(budget.reserve(operation('retry-after-clear'))).rejects.toMatchObject({ code: 'BUDGET_LEDGER_CORRUPT' });
  });

  it('retains the lock and denies execution when committing the head rename fails', async () => {
    const path = join(await directory(), 'ledger');
    const budget = new FileBudgetLimiter({ path, total: 1, lockTimeoutMs: 10 });
    await budget.snapshot();
    const originalHead = await readFile(`${path}.head`, 'utf8');
    let executed = false;
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('injected head rename failure'), { code: 'EIO' }));
    await expect((async () => {
      await budget.reserve(operation('rename-uncertain'));
      executed = true;
    })()).rejects.toMatchObject({ code: 'BUDGET_IO_ERROR' });
    expect(executed).toBe(false);
    expect(await readFile(`${path}.head`, 'utf8')).toBe(originalHead);
    expect(await readFile(path, 'utf8')).toContain('rename-uncertain');
    expect(await readdir(`${path}.lock`)).toEqual(['next-head']);
    const restarted = new FileBudgetLimiter({ path, total: 1, lockTimeoutMs: 10 });
    await expect(restarted.reserve(operation('retry'))).rejects.toMatchObject({ code: 'BUDGET_LOCK_TIMEOUT' });
    // Simulate an operator clearing the stale lock without reconciling the files:
    // append/head disagreement still prevents admission, rather than erasing spend.
    await rm(`${path}.lock`, { recursive: true });
    await expect(restarted.snapshot()).rejects.toMatchObject({ code: 'BUDGET_LEDGER_CORRUPT' });
    await expect(restarted.reserve(operation('retry-after-clear'))).rejects.toMatchObject({ code: 'BUDGET_LEDGER_CORRUPT' });
  });

  it('retains the full reservation when directory fsync fails after head rename', async () => {
    const path = join(await directory(), 'ledger');
    const budget = new FileBudgetLimiter({ path, total: 1, lockTimeoutMs: 10 });
    await budget.snapshot();
    const handle = await open(path, 'r');
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const originalSync = prototype.sync;
    let syncCalls = 0;
    let executed = false;
    const fault = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: unknown) {
      // Ownership directory, appended ledger, and temporary head sync succeed.
      // The fourth sync persists the destination directory AFTER the head rename.
      if (++syncCalls === 4) throw new Error('injected post-rename directory fsync failure');
      return originalSync.call(this);
    });
    try {
      await expect((async () => {
        await budget.reserve(operation('directory-sync-uncertain'));
        executed = true;
      })()).rejects.toMatchObject({ code: 'BUDGET_IO_ERROR' });
    } finally { fault.mockRestore(); }
    expect(syncCalls).toBe(4);
    expect(executed).toBe(false);
    expect(JSON.parse(await readFile(`${path}.head`, 'utf8')).sequence).toBe(1);
    expect(await readdir(`${path}.lock`)).toEqual([]);
    const restarted = new FileBudgetLimiter({ path, total: 1, lockTimeoutMs: 10 });
    await expect(restarted.reserve(operation('retry'))).rejects.toMatchObject({ code: 'BUDGET_LOCK_TIMEOUT' });
    // The files agree on the charged reservation. Even an explicit operator lock
    // removal after inspection cannot make its units or operation identity reusable.
    await rm(`${path}.lock`, { recursive: true });
    expect(await restarted.snapshot()).toMatchObject({ reserved: 1, remaining: 0 });
    await expect(restarted.reserve(operation('retry-after-clear'))).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    await expect(restarted.reserve(operation('directory-sync-uncertain'))).rejects.toMatchObject({ code: 'BUDGET_DUPLICATE_OPERATION' });
  });

  it('fails closed after SIGKILL between durable append and head commit', async () => {
    const dir = await directory();
    const moduleUrl = await compiledBudget(dir);
    const path = join(dir, 'ledger');
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { open, writeFile } from 'node:fs/promises';
      import { FileBudgetLimiter } from ${JSON.stringify(moduleUrl)};
      const path = ${JSON.stringify(path)};
      const budget = new FileBudgetLimiter({ path, total: 1 });
      await budget.snapshot();
      const handle = await open(path, 'r');
      const prototype = Object.getPrototypeOf(handle);
      await handle.close();
      const originalSync = prototype.sync;
      let syncCalls = 0;
      prototype.sync = async function () {
        await originalSync.call(this);
        if (++syncCalls === 2) {
          process.send('append-durable-before-head');
          await new Promise(() => {});
        }
      };
      setInterval(() => {}, 1000);
      await budget.reserve(${JSON.stringify(operation('killed-before-head'))});
      await writeFile(${JSON.stringify(join(dir, 'external-work-started'))}, 'unexpected');
    `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr!.on('data', (data) => { stderr += data; });
    const exited = new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('exit', () => resolve()); });
    try {
      await new Promise<void>((resolve, reject) => {
        child.on('message', (message) => { if (message === 'append-durable-before-head') resolve(); });
        child.on('error', reject);
        child.on('exit', (code) => reject(new Error(stderr || `Worker exited before the fault point: ${code}`)));
      });
      child.kill('SIGKILL');
      await exited;
      expect(await readFile(path, 'utf8')).toContain('killed-before-head');
      expect(JSON.parse(await readFile(`${path}.head`, 'utf8')).sequence).toBe(0);
      expect(await readdir(dir)).not.toContain('external-work-started');
      const restarted = new FileBudgetLimiter({ path, total: 1, lockTimeoutMs: 10 });
      await expect(restarted.snapshot()).rejects.toMatchObject({ code: 'BUDGET_LOCK_TIMEOUT' });
      await expect(restarted.reserve(operation('retry'))).rejects.toMatchObject({ code: 'BUDGET_LOCK_TIMEOUT' });
      await rm(`${path}.lock`, { recursive: true });
      await expect(restarted.snapshot()).rejects.toMatchObject({ code: 'BUDGET_LEDGER_CORRUPT' });
      await expect(restarted.reserve(operation('retry-after-clear'))).rejects.toMatchObject({ code: 'BUDGET_LEDGER_CORRUPT' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });

  it('normalizes directory aliases so they cannot create separate admission locks', async () => {
    const dir = await directory();
    const aliasRoot = await directory();
    const alias = join(aliasRoot, 'alias');
    await symlink(dir, alias);
    const first = new FileBudgetLimiter({ path: join(dir, 'ledger'), total: 1 });
    const second = new FileBudgetLimiter({ path: join(alias, 'ledger'), total: 1 });
    const results = await Promise.allSettled([first.reserve(operation('first')), second.reserve(operation('second'))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await first.snapshot()).reserved).toBe(1);
    expect(await second.snapshot()).toEqual(await first.snapshot());
  });

  it('rejects symlinked ledgers rather than bypassing their coordination lock', async () => {
    const dir = await directory();
    const path = join(dir, 'ledger');
    const alias = join(dir, 'alias');
    await new FileBudgetLimiter({ path, total: 2 }).reserve(operation('first'));
    await symlink(path, alias);
    await expect(new FileBudgetLimiter({ path: alias, total: 2 }).reserve(operation('second'))).rejects.toMatchObject({ code: 'BUDGET_LEDGER_CORRUPT' });
  });

  it('charges reservations from a terminated process before any external work', async () => {
    const dir = await directory();
    const moduleUrl = await compiledBudget(dir);
    const path = join(dir, 'ledger');
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { FileBudgetLimiter } from ${JSON.stringify(moduleUrl)};
      const budget = new FileBudgetLimiter({ path: ${JSON.stringify(path)}, total: 2 });
      await budget.reserve(${JSON.stringify(operation('crashed-before-call', 2))});
      process.send('reserved');
      setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const exited = new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('exit', () => resolve()); });
    await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('message', () => resolve()); });
    child.kill('SIGKILL');
    await exited;
    const resumed = new FileBudgetLimiter({ path, total: 2 });
    expect((await resumed.snapshot()).reserved).toBe(2);
    await expect(resumed.reserve(operation('retry'))).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });

  it('serializes concurrent processes and never admits beyond the durable cap', async () => {
    const dir = await directory();
    const moduleUrl = await compiledBudget(dir);
    const path = join(dir, 'ledger');
    const workers = Array.from({ length: 6 }, (_, index) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { FileBudgetLimiter } from ${JSON.stringify(moduleUrl)};
        const budget = new FileBudgetLimiter({ path: ${JSON.stringify(path)}, total: 13, lockTimeoutMs: 10000 });
        process.on('message', async () => {
          const results = await Promise.all(Array.from({length:6}, async (_, item) => {
            try {
              await budget.reserve({ operationId: '${index}-' + item, evaluatorId: 'offline-v1', kind: 'evaluator', units: 1 });
              return 'admitted';
            } catch (error) { return error.code; }
          }));
          process.send(results);
          process.disconnect();
        });
        process.send('ready');
      `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let stderr = '';
      child.stderr!.on('data', (data) => { stderr += data; });
      const ready = new Promise<void>((resolve, reject) => {
        child.on('message', (message) => { if (message === 'ready') resolve(); });
        child.on('error', reject);
        child.on('exit', (code) => { if (code !== 0) reject(new Error(stderr || `Worker exited ${code}`)); });
      });
      const result = new Promise<string[]>((resolve, reject) => {
        let results: string[] | undefined;
        child.on('message', (message) => { if (Array.isArray(message)) results = message; });
        child.on('error', reject);
        child.on('exit', (code) => { if (code === 0 && results) resolve(results); else reject(new Error(stderr || `Worker exited ${code}`)); });
      });
      return { child, ready, result };
    });
    await Promise.all(workers.map((worker) => worker.ready));
    for (const worker of workers) worker.child.send('go');
    const results = (await Promise.all(workers.map((worker) => worker.result))).flat();
    expect(results.filter((result) => result === 'admitted')).toHaveLength(13);
    expect(results.filter((result) => result === 'BUDGET_EXCEEDED')).toHaveLength(23);
    const state = await new FileBudgetLimiter({ path, total: 13 }).snapshot();
    expect(state).toMatchObject({ reserved: 13, remaining: 0 });
    expect(new Set(state.operations.map((entry) => entry.operationId)).size).toBe(13);
  }, 15000);
});

/** Transpile the single isolated module so subprocess tests also work on Node 20,
 * which cannot execute .ts directly. No package build or paid services are needed. */
async function compiledBudget(dir: string): Promise<string> {
  const source = await readFile(new URL('../src/budget.ts', import.meta.url), 'utf8');
  const compiled = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext } }).outputText;
  const path = join(dir, 'budget.mjs');
  await writeFile(path, compiled);
  return pathToFileURL(path).href;
}
