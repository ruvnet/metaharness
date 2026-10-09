// What stands between a rented Vast instance and an unbounded bill when the orchestrator cannot clean up after
// itself: the independent watchdog (launched BEFORE create, so no instance can exist without one), confirmed destroys,
// and the recovery sweeps, which settle the spend ledger at what an instance really cost (never below its plan).
import { execFile, spawn } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendRow, loadLedger } from './gpu-spend.mjs';
import { fetchVastKey, makeVastCli, resolveBin } from './gpu-vast-cli.mjs';

export const WATCHDOG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'watchdog.sh');
/** Watchdog unit lifetime past the deadline. It retries until 5 min before that; systemd restarts it on failure
 *  (Restart=on-failure) until it confirms or the deadline is 24 h old (watchdog.sh then refuses with exit 2). */
export const WATCHDOG_SLACK_S = 1800;
const sleepReal = (ms) => new Promise(r => setTimeout(r, ms));
const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const round4 = (v) => Math.round(v * 1e4) / 1e4;

/** destroy -> wait -> show, until `show instance` says gone. -> {confirmed, destroyCalls} */
export async function destroyConfirmed(cli, instanceId, { attempts, backoffMs, sleep = sleepReal, journal = () => {} }) {
  let destroyCalls = 0;
  for (let i = 1; i <= attempts; i += 1) {
    try { destroyCalls += 1; await cli.destroyOnce(instanceId); } catch (e) { journal({ phase: 'gpu.destroy_error', attempt: i, error: e.message }); }
    await sleep(backoffMs * i);
    try { if ((await cli.showInstance(instanceId)) === null) return { confirmed: true, destroyCalls }; } catch (e) {
      journal({ phase: 'gpu.destroy_confirm_error', attempt: i, error: e.message });
    }
  }
  return { confirmed: false, destroyCalls };
}

/** Real cost of a planned run that was alive until `endMs`, and never less than its (already counted) plan. */
export function actualCost(p, endMs) {
  const hours = Math.max(0, (endMs - Date.parse(p.ts)) / 3_600_000);
  return { usd: Math.max(p.usd, round4(p.dphTotal * hours)), hours: round4(hours) };
}

/** The planned row of `runId` while it has no terminal row yet, else null. */
export function openRun(rows, runId) {
  let p = null;
  for (const r of rows) if (r.runId === runId) p = r.type === 'planned' ? r : null;
  return p;
}

/** When the watchdog confirmed `label` gone (its destroyed_confirmed row), epoch ms; null if it never said so. */
function watchdogConfirmedAt(stateDir, label) {
  try {
    const rows = readFileSync(path.join(stateDir, 'watchdog.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } });
    const hit = rows.filter(r => r?.label === label && r.phase === 'destroyed_confirmed' && Number.isFinite(r.at)).at(-1);
    return hit ? hit.at * 1000 : null;
  } catch { return null; }
}

/**
 * Recovery for what the watchdog cannot cover (a reboot drops its transient unit; SIGKILL before the id is known):
 * every ledger run still open 15 min past its planned hours is looked up by its unique label and destroyed, then
 * closed at its REAL cost: alive until now if it was found, else until the watchdog confirmed it gone, else its plan.
 * A failed lookup or an unconfirmed destroy leaves it open for the next sweep. Runs that may still be live are never touched.
 */
export function staleOpenRuns(rows, nowMs) {
  const open = new Map();
  for (const r of rows) {
    if (r.type === 'planned') open.set(r.runId, r);
    else if (r.type !== 'seed') open.delete(r.runId);
  }
  return [...open.values()].filter(p => Date.parse(p.ts) + p.hours * 3_600_000 + 15 * 60_000 <= nowMs);
}

export async function sweepStaleRuns(cli, { ledger, rows, nowMs, attempts, backoffMs, sleep, journal = () => {}, stateDir = null }) {
  const out = [];
  for (const p of staleOpenRuns(rows, nowMs)) {
    const label = `arena-flywheel-${p.runId}`;
    let found;
    try { found = await cli.showInstancesByLabel(label); } catch (e) {
      journal({ phase: 'gpu.sweep_lookup_failed', staleRunId: p.runId, error: e.message }); continue;
    }
    let closed = true;
    for (const r of found) {
      const d = await destroyConfirmed(cli, r.id, { attempts, backoffMs, sleep, journal });
      closed &&= d.confirmed;
      journal({ phase: 'gpu.sweep_destroyed', staleRunId: p.runId, instanceId: r.id, confirmed: d.confirmed });
    }
    if (closed) {
      const end = found.length ? nowMs : (stateDir ? watchdogConfirmedAt(stateDir, label) : null);
      const cost = end === null ? { usd: p.usd, hours: p.hours } : actualCost(p, end);
      appendRow(ledger, { v: 1, type: 'settled', ts: new Date(nowMs).toISOString(), runId: p.runId, usd: cost.usd, hours: cost.hours,
        swept: true, found: found.length });
    }
    out.push({ runId: p.runId, found: found.length, closed });
  }
  return out;
}

/** For the orchestrator's start-of-run cleanup even on days it will not rent. No stale run -> no call at all. */
export async function recoverStaleRuns({ stateDir, getKey, pathEnv = process.env.PATH, vastUrl, now = Date.now, sleep = sleepReal,
  journal = () => {}, attempts = 6, backoffMs = 10_000 } = {}) {
  const ledger = path.join(stateDir, 'spend.jsonl');
  const rows = loadLedger(ledger, { seedIfMissing: false });
  if (!staleOpenRuns(rows, now()).length) return [];
  const cli = makeVastCli({ key: await (getKey ?? (() => fetchVastKey({ pathEnv })))(), pathEnv, url: vastUrl });
  return sweepStaleRuns(cli, { ledger, rows, nowMs: now(), attempts, backoffMs, sleep, journal, stateDir });
}

/** Destroy by id (orphan sweep / manual cleanup), key fetched at use time. With `runId` + `stateDir`, a ledger run
 *  still open for it is settled at its real duration once the destroy is confirmed. */
export async function destroyInstance(instanceId, { getKey, pathEnv = process.env.PATH, vastUrl, attempts = 6,
  backoffMs = 10_000, sleep, journal, runId = null, stateDir = null, now = Date.now } = {}) {
  if (!posInt(instanceId)) throw new Error('destroyInstance: instance id must be a positive integer');
  const cli = makeVastCli({ key: await (getKey ?? (() => fetchVastKey({ pathEnv })))(), pathEnv, url: vastUrl });
  const d = await destroyConfirmed(cli, instanceId, { attempts, backoffMs, sleep, journal });
  if (d.confirmed && runId && stateDir) {
    const ledger = path.join(stateDir, 'spend.jsonl');
    let p = null;
    try { p = openRun(loadLedger(ledger, { seedIfMissing: false }), runId); } catch { p = null; }
    if (p) {
      const cost = actualCost(p, now());
      appendRow(ledger, { v: 1, type: 'settled', ts: new Date(now()).toISOString(), runId, usd: cost.usd, hours: cost.hours, instanceId, orphan: true });
      return { ...d, settled: cost };
    }
  }
  return d;
}

/**
 * Start watchdog.sh outside this process's lifetime. instanceId null = LABEL mode: at the deadline it looks the
 * instance up by its unique label, so it can be armed before create and still covers a crash before the id is known.
 * -> {how, stop()} or throws (the caller then rents nothing).
 */
export async function launchWatchdog({ instanceId = null, deadlineEpoch, label, stateDir, launcher, pathEnv = process.env.PATH, nowMs, sleep = sleepReal }) {
  const args = [WATCHDOG_PATH, instanceId === null ? '-' : String(instanceId), String(deadlineEpoch), label];
  const giveUpAt = deadlineEpoch + WATCHDOG_SLACK_S - 300;
  const env = { PATH: pathEnv, HOME: process.env.HOME, ARENA_FLYWHEEL_STATE_DIR: stateDir, WATCHDOG_GIVE_UP_AT: String(giveUpAt) };
  if (launcher === 'detached') {
    const log = openSync(path.join(stateDir, 'watchdog.log'), 'a', 0o600);
    const child = spawn(resolveBin('bash', pathEnv), args, { detached: true, stdio: ['ignore', log, log], env });
    child.unref();
    await sleep(300);
    if (child.exitCode !== null) throw new Error(`watchdog exited at launch (code ${child.exitCode})`);
    return { how: `detached pid ${child.pid}`, stop: () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } } };
  }
  // A transient user unit lives in its own cgroup: it survives this service being stopped or killed.
  const unit = `arena-flywheel-wd-${instanceId ?? label.replace(/^arena-flywheel-/, '')}`;
  const runtimeMax = Math.max(60, deadlineEpoch - Math.floor(nowMs / 1000)) + WATCHDOG_SLACK_S;
  const sdEnv = { ...env }; // the user bus is found through these; an EMPTY value would break systemd-run, so only real ones
  for (const k of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[k]) sdEnv[k] = process.env[k];
  const run = (bin, a) => new Promise((res, rej) => execFile(resolveBin(bin, pathEnv), a, { env: sdEnv, timeout: 30_000 },
    (e, out) => (e ? rej(new Error(`${bin} failed`)) : res(String(out).trim()))));
  await run('systemd-run', ['--user', `--unit=${unit}`, '--collect', '--quiet', `--property=RuntimeMaxSec=${runtimeMax}`,
    '--property=Restart=on-failure', '--property=RestartSec=60', '--property=RestartPreventExitStatus=2 3',
    `--setenv=PATH=${pathEnv}`, `--setenv=ARENA_FLYWHEEL_STATE_DIR=${stateDir}`, `--setenv=WATCHDOG_GIVE_UP_AT=${giveUpAt}`,
    resolveBin('bash', pathEnv), ...args]);
  await sleep(500);
  if ((await run('systemctl', ['--user', 'is-active', `${unit}.service`]).catch(() => 'inactive')) !== 'active') throw new Error('watchdog unit not active');
  return { how: `systemd unit ${unit}`, stop: () => run('systemctl', ['--user', 'stop', `${unit}.service`]).catch(() => {}) };
}
