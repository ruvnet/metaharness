// SPDX-License-Identifier: MIT
//
// A malformed numeric CLI flag (typo, empty shell variable, unset env interpolated into the
// command line) silently disables whatever guard reads it: `+argv('--max-cost', Infinity)` on
// non-numeric input evaluates to NaN, and both `NaN >= x` and `x >= NaN` are `false` under
// IEEE-754 — so a hard spend cap built on that comparison never fires and the run proceeds with
// an effectively unlimited budget instead of refusing to start. Every `bench/swebench/solve-*.mjs`
// live-spend script parses its `--max-cost` hard budget cap this way (CWE-1284/CWE-697 shape;
// same class as CVE-2026-54235's vLLM temperature-gate NaN bypass).
//
// `numericFlag` fails closed instead: reject NaN before any LLM call is made. `Infinity` stays a
// valid explicit value on purpose — it is this flag's own "no cap" default, so rejecting it would
// change today's defined behavior for no security benefit; only NaN (the silent-bypass value) is
// rejected.
//
// A second, easy-to-miss bypass lives in the shared `argv(f, d)` closure every solve-*.mjs script
// uses: `i >= 0 ? args[i + 1] : d` returns `undefined` both when the flag is genuinely absent AND
// when it's the last token on the command line with no following value (the realistic shape of a
// broken `--max-cost $CAP` where `$CAP` is unset and word-splits away) — the two cases are
// indistinguishable from `argv`'s return value alone. A sentinel default tells them apart: `argv`
// only ever returns the sentinel we pass it when the flag was never found.
const ABSENT = Symbol('numericFlag:absent');
export function numericFlag(argv, flag, fallback) {
  const raw = argv(flag, ABSENT);
  if (raw === ABSENT) return fallback;
  if (raw === undefined) {
    throw new Error(`${flag}: expected a value, got none (flag was the last argument)`);
  }
  const n = Number(raw);
  if (Number.isNaN(n)) {
    throw new Error(`${flag}: expected a number, got ${JSON.stringify(raw)}`);
  }
  return n;
}
