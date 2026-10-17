// D1-S0 ($0, node:test, no network/Docker/model calls): validates parseMaxCost's refusal of a
// malformed `--max-cost` flag, which is the exact shape that let the solve-*.mjs family's real-
// money budget cap silently never fire (`NaN >= x` is always false — IEEE-754, cf. the sibling
// weight-eft NaN-bypass in #360 and CVE-2026-54235).
import { test } from 'node:test';
import assert from 'node:assert';
import { parseMaxCost } from './cost-guard.mjs';

test('parseMaxCost: absent flag returns the fallback (default: no cap)', () => {
  assert.strictEqual(parseMaxCost([]), Infinity);
  assert.strictEqual(parseMaxCost(['--model', 'x'], '--max-cost', 25), 25);
});

test('parseMaxCost: a valid numeric value parses through unchanged', () => {
  assert.strictEqual(parseMaxCost(['--max-cost', '15']), 15);
  assert.strictEqual(parseMaxCost(['--max-cost', '0.5']), 0.5);
  assert.strictEqual(parseMaxCost(['--max-cost', '0']), 0);
});

test('REJECTS a malformed --max-cost that would silently parse to NaN (the real bug: NaN >= x is always false)', () => {
  assert.throws(() => parseMaxCost(['--max-cost', 'abc']), /finite, non-negative/);
  assert.throws(() => parseMaxCost(['--max-cost', 'NaN']), /finite, non-negative/);
});

test('an empty-string value (`+"" === 0`, not NaN) is a valid zero cap, not a bypass', () => {
  assert.strictEqual(parseMaxCost(['--max-cost', '']), 0);
});

test('REJECTS a non-finite (Infinity) or negative explicit value', () => {
  assert.throws(() => parseMaxCost(['--max-cost', 'Infinity']), /finite, non-negative/);
  assert.throws(() => parseMaxCost(['--max-cost', '-5']), /finite, non-negative/);
});

test('a custom flag name and fallback both work (solve-mcts/solve-repair share this module)', () => {
  assert.strictEqual(parseMaxCost(['--budget', '10'], '--budget', 0), 10);
  assert.throws(() => parseMaxCost(['--budget', 'oops'], '--budget', 0), /--budget/);
});
