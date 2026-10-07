#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Dream Cycle 2026-10-03 (security-adversarial). Continuation of PR #362's disclosed-not-fixed
// finding: budget-watchdog.mjs's --pid/--ceiling/--interval were parsed via bare unary `+`, so a
// malformed value silently coerces to NaN instead of failing closed. Consequence per flag:
//   --ceiling NaN -> `u >= NaN` is always false -> the SIGTERM kill-switch never fires, forever.
//   --pid     NaN -> `NaN` is falsy -> the watch loop never starts, yet the script still prints
//                    "target exited or breached — done" as if it had armed and completed cleanly.
//   --interval NaN -> `NaN * 1000` -> setTimeout clamps a NaN delay to 0ms -> an uncapped busy-poll
//                     against the OpenRouter usage endpoint instead of the requested cadence.
// NO network / NO Docker / NO LLM / NO live spend — malformed-flag cases fail before the script
// ever reads an API key or calls fetch; the valid-args case uses a PID guaranteed not alive, so the
// watch loop body (the only path that calls fetch) never executes. Run: node budget-watchdog.test.mjs
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'budget-watchdog.mjs');
// Astronomically unlikely to be a live PID on any real machine or CI runner.
const DEAD_PID = '2147483000';

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

function run(flags, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...flags], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
}

console.log('budget-watchdog.mjs fail-closed numeric-flag tests:');

t('malformed --ceiling fails closed (non-zero exit, names the flag) instead of silently disabling the kill-switch', () => {
  const r = run(['--pid', DEAD_PID, '--ceiling', 'not-a-number']);
  assert.notEqual(r.status, 0, 'must not exit 0 on a garbage ceiling');
  assert.match(r.stderr, /--ceiling must be a finite number/);
});

t('malformed --pid fails closed instead of silently never arming the watchdog', () => {
  const r = run(['--pid', 'not-a-number', '--ceiling', '5']);
  assert.notEqual(r.status, 0, 'must not exit 0 on a garbage pid');
  assert.match(r.stderr, /--pid must be a finite number/);
});

t('malformed --interval fails closed instead of degrading into a busy-poll', () => {
  const r = run(['--pid', DEAD_PID, '--ceiling', '5', '--interval', 'not-a-number']);
  assert.notEqual(r.status, 0, 'must not exit 0 on a garbage interval');
  assert.match(r.stderr, /--interval must be a finite number/);
});

t('--ceiling -Infinity is rejected, not silently treated as "no cap"', () => {
  const r = run(['--pid', DEAD_PID, '--ceiling', '-Infinity']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--ceiling must be a finite number/);
});

t('a valid, finite --ceiling/--pid/--interval still runs and exits cleanly (byte-identical happy path)', () => {
  const r = run(['--pid', DEAD_PID, '--ceiling', '2434.45', '--interval', '1'], { OPENROUTER_API_KEY: 'unused-dummy-key' });
  assert.equal(r.status, 0, `expected clean exit, got status=${r.status} stderr=${r.stderr}`);
  assert.match(r.stderr, /target exited or breached — done/);
  assert.doesNotMatch(r.stderr, /BREACH/, 'a dead PID must never reach the breach branch');
});

t('omitting --ceiling/--interval still defaults to Infinity/60s (fallback path, not the finiteness check)', () => {
  const r = run(['--pid', DEAD_PID], { OPENROUTER_API_KEY: 'unused-dummy-key' });
  assert.equal(r.status, 0, `expected clean exit, got status=${r.status} stderr=${r.stderr}`);
  assert.match(r.stderr, /ceiling=\$Infinity interval=60s/);
});

t('an explicit --ceiling Infinity (the documented "no cap" sentinel) still passes through, not rejected', () => {
  const r = run(['--pid', DEAD_PID, '--ceiling', 'Infinity'], { OPENROUTER_API_KEY: 'unused-dummy-key' });
  assert.equal(r.status, 0, `expected clean exit, got status=${r.status} stderr=${r.stderr}`);
  assert.match(r.stderr, /ceiling=\$Infinity/);
});

console.log(`${pass} passed`);
