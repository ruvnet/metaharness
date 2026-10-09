// Append-only GPU spend ledger (~/.local/state/arena-flywheel/spend.jsonl) with fail-closed caps.
//
// Rows (one JSON object per line, never rewritten):
//   {v:1, type:'seed',      ts, usd, note}                       prior manual spend; counts toward the total only
//   {v:1, type:'planned',   ts, runId, usd, dphTotal, hours, offerId}   written BEFORE create (worst case)
//   {v:1, type:'cancelled', ts, runId}                            create certainly made nothing -> run costs 0
//   {v:1, type:'settled',   ts, runId, usd, hours, instanceId}    destroy confirmed -> actual estimate
// A run costs settled.usd if settled, 0 if cancelled, otherwise its planned (worst-case) usd. So an orchestrator
// that dies mid-run is charged the full plan; a run found still alive later is settled at its REAL duration
// (gpu-backstop.mjs), never at its plan.
// "Daily" is the America/Toronto calendar date (the timer's day) of each run's planned.ts, compared with the date of
// the injected now: deterministic, independent of the timer's jitter.
// Any malformed row, non-finite or negative number, unknown type or orphan terminal row refuses all renting. A missing
// ledger is seeded only when the journal shows no rental ever happened (deleting it must not reset the caps).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { torontoDate } from './dates.mjs';

export const SEED_USD = 5.0;
export const DAY_MS = 86_400_000;
const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;

export class SpendRefused extends Error {
  constructor(reason) { super(`spend refused: ${reason}`); this.name = 'SpendRefused'; this.reason = reason; }
}

const finiteNonNeg = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

export function appendRow(file, row) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, 'a', 0o600);
  try { writeSync(fd, `${JSON.stringify(row)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

const RENTAL_EVENTS = new Set(['up', 'gpu.spend_ok', 'gpu.created', 'gpu.watchdog_started']);
/** Has this state dir's journal ever recorded a rental (or the spend check right before one)? Unreadable = yes. */
export function rentalsJournaled(stateDir) {
  const file = path.join(stateDir, 'journal.jsonl');
  if (!existsSync(file)) return false;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return true; }
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let e;
    try { e = JSON.parse(l); } catch { return true; }
    if (e?.phase === 'gpu' && RENTAL_EVENTS.has(e.event)) return true;
  }
  return false;
}

/** Read and validate every row. Seeds a missing ledger (first run only); an empty or corrupt one refuses. */
export function loadLedger(file, { nowIso, seedIfMissing = true } = {}) {
  if (!existsSync(file)) {
    if (!seedIfMissing) throw new SpendRefused('ledger missing (rentals are journaled: restore spend.jsonl; it is never re-seeded)');
    if (!Number.isFinite(Date.parse(nowIso))) throw new SpendRefused('seed timestamp invalid');
    appendRow(file, { v: 1, type: 'seed', ts: nowIso, usd: SEED_USD, note: 'prior manual Vast spend' });
  }
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { throw new SpendRefused('ledger unreadable'); }
  const lines = text.split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) throw new SpendRefused('ledger empty (expected at least the seed row)');
  const rows = lines.map((l, i) => {
    try { return JSON.parse(l); } catch { throw new SpendRefused(`ledger line ${i + 1} is not JSON`); }
  });
  validateRows(rows);
  return rows;
}

export function validateRows(rows) {
  const runs = new Map();
  rows.forEach((r, i) => {
    const at = `ledger row ${i + 1}`;
    if (!r || typeof r !== 'object' || r.v !== 1) throw new SpendRefused(`${at}: bad version`);
    if (!Number.isFinite(Date.parse(r.ts))) throw new SpendRefused(`${at}: bad ts`);
    if (r.type === 'seed') { if (!finiteNonNeg(r.usd)) throw new SpendRefused(`${at}: bad usd`); return; }
    if (!RUN_ID.test(String(r.runId))) throw new SpendRefused(`${at}: bad runId`);
    const run = runs.get(r.runId);
    if (r.type === 'planned') {
      if (run) throw new SpendRefused(`${at}: duplicate planned runId`);
      if (!finiteNonNeg(r.usd) || !finiteNonNeg(r.dphTotal) || !finiteNonNeg(r.hours)) throw new SpendRefused(`${at}: bad number`);
      runs.set(r.runId, { done: false });
    } else if (r.type === 'cancelled' || r.type === 'settled') {
      if (!run) throw new SpendRefused(`${at}: ${r.type} without planned`);
      if (run.done) throw new SpendRefused(`${at}: second terminal row`);
      if (r.type === 'settled' && (!finiteNonNeg(r.usd) || !finiteNonNeg(r.hours))) throw new SpendRefused(`${at}: bad number`);
      run.done = true;
    } else throw new SpendRefused(`${at}: unknown type`);
  });
}

/** -> {spentTotal, spentDaily, openRuns} */
export function summarize(rows, nowMs) {
  if (!Number.isFinite(nowMs)) throw new SpendRefused('now is not finite');
  let spentTotal = 0; let spentDaily = 0;
  const runs = new Map();
  for (const r of rows) {
    if (r.type === 'seed') { spentTotal += r.usd; continue; }
    if (r.type === 'planned') runs.set(r.runId, { planned: r, cost: r.usd, open: true });
    else { const run = runs.get(r.runId); run.cost = r.type === 'settled' ? r.usd : 0; run.open = false; }
  }
  let openRuns = 0;
  const today = torontoDate(nowMs);
  for (const run of runs.values()) {
    spentTotal += run.cost;
    if (torontoDate(Date.parse(run.planned.ts)) === today) spentDaily += run.cost;
    if (run.open) openRuns += 1;
  }
  if (!Number.isFinite(spentTotal) || !Number.isFinite(spentDaily)) throw new SpendRefused('spend sum not finite');
  return { spentTotal, spentDaily, openRuns };
}

/** Validate caps/plan/credit and the ledger totals. Returns the summary or throws SpendRefused. */
export function checkSpend({ rows, nowMs, plannedUsd, dailyCapUsd, totalCapUsd, credit }) {
  for (const [name, v] of Object.entries({ dailyCapUsd, totalCapUsd })) {
    if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) throw new SpendRefused(`${name} must be a finite number > 0`);
  }
  if (!(typeof plannedUsd === 'number' && Number.isFinite(plannedUsd) && plannedUsd > 0)) throw new SpendRefused('planned spend must be a finite number > 0');
  if (!finiteNonNeg(credit)) throw new SpendRefused('Vast credit missing or not a finite non-negative number');
  const s = summarize(rows, nowMs);
  if (s.spentDaily + plannedUsd > dailyCapUsd) throw new SpendRefused(`daily cap: ${s.spentDaily.toFixed(2)} + ${plannedUsd.toFixed(2)} > ${dailyCapUsd}`);
  if (s.spentTotal + plannedUsd > totalCapUsd) throw new SpendRefused(`total cap: ${s.spentTotal.toFixed(2)} + ${plannedUsd.toFixed(2)} > ${totalCapUsd}`);
  if (credit < plannedUsd) throw new SpendRefused(`Vast credit ${credit.toFixed(2)} < planned ${plannedUsd.toFixed(2)}`);
  return s;
}

/** Cheap pre-check before any network call: caps valid and not already exhausted. */
export function precheckCaps({ rows, nowMs, dailyCapUsd, totalCapUsd }) {
  for (const [name, v] of Object.entries({ dailyCapUsd, totalCapUsd })) {
    if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) throw new SpendRefused(`${name} must be a finite number > 0`);
  }
  const s = summarize(rows, nowMs);
  if (s.spentDaily >= dailyCapUsd) throw new SpendRefused('daily cap already reached');
  if (s.spentTotal >= totalCapUsd) throw new SpendRefused('total cap already reached');
  return s;
}
