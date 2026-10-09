import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../evaluator.mjs';
import { runnerArgv } from '../lib/runner.mjs';
import { runnerArgsSha } from '../lib/provenance.mjs';

const base = ['--cache-dir', '/tmp/darwin-thinking-test', '--dry-run'];

test('thinking defaults to off (the arena trainer regime) and is validated', () => {
  assert.equal(parseArgs(base).thinking, 'off');
  assert.equal(parseArgs([...base, '--thinking', 'on']).thinking, 'on');
  assert.throws(() => parseArgs([...base, '--thinking', 'maybe']), /--thinking must be on or off/);
});

test('runner argv carries --thinking exactly once', () => {
  const o = { ...parseArgs(base), runner: 'calibrate.py', baseUrl: 'http://localhost:8100/v1', tokenizerJson: 't.json' };
  const argv = runnerArgv(o, { family: 'math_route', difficulty: 2, budget: 8192, knobs: {} }, 700200, 'out.jsonl');
  const i = argv.indexOf('--thinking');
  assert.ok(i > 0 && argv[i + 1] === 'off');
  assert.equal(argv.filter((a) => a === '--thinking').length, 1);
});

test('thinking on/off never share a cache key', () => {
  const o = { maxTotalTokens: 2_000_000, tokenizerSha256: 'a'.repeat(64) };
  assert.notEqual(runnerArgsSha({ ...o, thinking: 'off' }), runnerArgsSha({ ...o, thinking: 'on' }));
  assert.equal(runnerArgsSha({ ...o }), runnerArgsSha({ ...o, thinking: 'off' }));
});
