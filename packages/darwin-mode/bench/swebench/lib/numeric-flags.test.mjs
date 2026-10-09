// Unit tests for numeric-flags.mjs's `numericFlag` (the shared fail-closed CLI-numeric-flag
// parser, closing the --max-cost NaN-bypass across solve-advisor/agentic/fusion/mcts/repair.mjs).
// $0, no network/Docker/git. Run: node packages/darwin-mode/bench/swebench/lib/numeric-flags.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numericFlag } from './numeric-flags.mjs';

function argvFrom(args) {
  return (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
}

test('returns the fallback when the flag is absent', () => {
  assert.equal(numericFlag(argvFrom([]), '--max-cost', Infinity), Infinity);
});

test('parses a valid numeric value', () => {
  assert.equal(numericFlag(argvFrom(['--max-cost', '15']), '--max-cost', Infinity), 15);
});

test('parses a decimal value', () => {
  assert.equal(numericFlag(argvFrom(['--max-cost', '2.5']), '--max-cost', Infinity), 2.5);
});

test('allows an explicit Infinity — the flag\'s own "no cap" sentinel', () => {
  assert.equal(numericFlag(argvFrom(['--max-cost', 'Infinity']), '--max-cost', Infinity), Infinity);
});

test('throws instead of silently defeating the cap on non-numeric text', () => {
  // Pre-fix: `+argv('--max-cost', Infinity)` on this input is NaN, and `totalCost >= NaN` is
  // always false, so the hard spend cap would never fire — the exact live vulnerability.
  assert.throws(() => numericFlag(argvFrom(['--max-cost', 'abc']), '--max-cost', Infinity), /--max-cost/);
});

test('throws on trailing-garbage numeric text (the realistic typo shape)', () => {
  assert.throws(() => numericFlag(argvFrom(['--max-cost', '15usd']), '--max-cost', Infinity), /--max-cost/);
});

test('throws on the literal string "NaN"', () => {
  assert.throws(
    () => numericFlag(argvFrom(['--max-cost', 'NaN']), '--max-cost', Infinity),
    /--max-cost: expected a number, got "NaN"/,
  );
});

test('throws when the flag is the last argument with no following value (does not silently fall back to unlimited)', () => {
  // The realistic shell-interpolation accident: `--max-cost $CAP` with `$CAP` unset word-splits
  // away, leaving `--max-cost` dangling as the final token. `argv('--max-cost', d)` returns
  // `undefined` here — identical to "flag absent" — so this must be distinguished internally
  // (via a sentinel default), not by checking `=== undefined`, or it silently returns `fallback`
  // (Infinity) and reopens the exact bypass this fix exists to close.
  assert.throws(() => numericFlag(argvFrom(['--max-cost']), '--max-cost', Infinity), /--max-cost/);
});

test('treats an empty-string value as 0, not a bypass (JS Number("") === 0, never NaN)', () => {
  // A misconfigured/empty shell variable lands here, not in the NaN branch — and 0 is the
  // maximally-safe outcome (caps spend immediately), so this is intentionally not a throw case.
  assert.equal(numericFlag(argvFrom(['--max-cost', '']), '--max-cost', Infinity), 0);
});
