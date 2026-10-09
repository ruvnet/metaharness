#!/usr/bin/env node
// Recovery-only tick (systemd/arena-flywheel-recover.timer: 5 min after boot, then hourly). It destroys GPU instances
// that crashed runs left behind (journaled up without a confirmed down, by id) and closes open spend-ledger runs (by
// their unique label), exactly like a tick's preflight, so a leak lasts at most about an hour past its plan instead of
// until the next daily tick. It NEVER rents and NEVER submits: it imports no arena client, renderer, decision or
// provisioning code, only gpu-backstop.mjs (destroy + sweep) and gpu-sweep.mjs.
//
//   node recover.mjs [--state-dir D] [--now ISO]
// While a flywheel run holds the lock it does nothing (exit 0): that run's own preflight and teardown own its GPU.
// Exit: 0 swept or skipped, 2 usage, 3 error.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { torontoDate } from './dates.mjs';
import { destroyInstance, recoverStaleRuns } from './gpu-backstop.mjs';
import { sweepGpus } from './gpu-sweep.mjs';
import { acquireLock, LockedError, openJournal, pidAlive, redact } from './journal.mjs';

/** The real GPU cleanup deps for `stateDir` (tests pass fakes instead). */
export function realGpu(stateDir) {
  const ledger = join(stateDir, 'spend.jsonl');
  return {
    destroy: (instanceId, { runId } = {}) => destroyInstance(instanceId, { runId, stateDir }),
    recover: nowMs => (existsSync(ledger) ? recoverStaleRuns({ stateDir, now: () => nowMs }) : []),
  };
}

export async function recover({ stateDir, now, gpu, pid = process.pid, isPidAlive = pidAlive, clock = () => new Date().toISOString() }) {
  const date = torontoDate(now);
  if (!date) throw new Error(`invalid --now: ${now}`);
  let lock;
  try { lock = acquireLock(stateDir, { pid, date, startedAt: now, isPidAlive }); } catch (e) {
    if (e instanceof LockedError) return { skipped: 'a flywheel run holds the lock' };
    throw e;
  }
  try {
    const j = openJournal({ stateDir, date, clock });
    j.append('recover', 'start', { startedAt: now });
    const notes = await sweepGpus({ j, deps: { gpu, nowMs: () => Date.parse(now) } });
    j.append('recover', 'done', { notes });
    return { notes };
  } finally { lock.release(); }
}

async function main(argv, env = process.env) {
  let o;
  try { o = parseArgs({ args: argv, strict: true, options: { 'state-dir': { type: 'string' }, now: { type: 'string' } } }).values; }
  catch (e) { process.stderr.write(`recover: ${redact(e.message)}\n`); return 2; }
  const { defaultStateDir } = await import('./flywheel-config.mjs');
  const stateDir = resolve(o['state-dir'] ?? env.ARENA_FLYWHEEL_STATE_DIR ?? defaultStateDir(env));
  try {
    const r = await recover({ stateDir, now: o.now ?? new Date().toISOString(), gpu: realGpu(stateDir) });
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return 0;
  } catch (e) { process.stderr.write(`recover: ${redact(e?.message ?? e)}\n`); return 3; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
