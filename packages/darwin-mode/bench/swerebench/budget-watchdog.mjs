// SPDX-License-Identifier: MIT
//
// ADR-197 (§63) — account-meter budget watchdog (the §56/§62 discipline). Polls the OpenRouter
// `auth/key` usage meter (NOT the solver self-report — Opus undercounts ~1.7x, §56) and SIGTERMs a
// target PID if the ABSOLUTE usage crosses the ceiling. Run alongside the solve so a budget breach
// stops the run even if the in-solver --max-cost (unreliable for Opus) doesn't.
//
//   node budget-watchdog.mjs --pid <solverpid> --ceiling 2434.45 --interval 60
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const ABSENT = Symbol('absent');
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

// Fail closed on a malformed flag instead of silently coercing to NaN. Bare
// `+argv(...)` would otherwise let a typo'd --ceiling defeat the SIGTERM
// kill-switch forever (`u >= NaN` is always false), a typo'd --pid make the
// watchdog silently never arm (`NaN` is falsy, so the loop never starts, yet
// it still logs "target exited or breached — done" as if it had), and a
// typo'd --interval degrade into an uncapped busy-poll against the
// OpenRouter key (`setTimeout` clamps a NaN delay to 0ms). `ABSENT` (not
// `undefined`) distinguishes "flag not passed, use the fallback" from "flag
// passed with a dangling/garbage value" so an explicit `Infinity` sentinel
// (the "no cap" ceiling) still passes through untouched.
export function numericArg(flag, fallback) {
  const raw = argv(flag, ABSENT);
  if (raw === ABSENT) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) && n !== Infinity) {
    throw new Error(`${flag} must be a finite number (or Infinity), got ${JSON.stringify(raw)}`);
  }
  return n;
}

const PID = numericArg('--pid', 0);
const CEILING = numericArg('--ceiling', Infinity);
const INTERVAL = numericArg('--interval', 60) * 1000;
const key = (process.env.OPENROUTER_API_KEY || readFileSync('/tmp/.orkey', 'utf8')).trim();

async function usage() {
  const res = await fetch('https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: `Bearer ${key}` } });
  return (await res.json()).data.usage;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

console.error(`[watchdog] PID=${PID} ceiling=$${CEILING} interval=${INTERVAL / 1000}s`);
while (PID && alive(PID)) {
  let u;
  try { u = await usage(); } catch { await new Promise((r) => setTimeout(r, INTERVAL)); continue; }
  console.error(`[watchdog] usage=$${u.toFixed(2)} (ceiling $${CEILING}, ${(CEILING - u).toFixed(2)} headroom)`);
  if (u >= CEILING) {
    console.error(`[watchdog] ⛔ BREACH $${u.toFixed(2)} >= $${CEILING} — SIGTERM ${PID}`);
    try { process.kill(PID, 'SIGTERM'); } catch { /**/ }
    break;
  }
  await new Promise((r) => setTimeout(r, INTERVAL));
}
console.error('[watchdog] target exited or breached — done');
