// SPDX-License-Identifier: MIT
//
// Tests for `ShellEvaluator` (ADR-272): the subprocess bridge a numeric
// genome's fitness function actually runs through. No shell, genome in on
// stdin, `NumericScoreCard` JSON out on stdout.

import { describe, it, expect } from 'vitest';
import { ShellEvaluator } from '../src/numeric-evaluator.js';

/** A tiny inline Node script standing in for a real evaluator command. */
function nodeEval(script: string): readonly string[] {
  return [process.execPath, '-e', script];
}

describe('ShellEvaluator', () => {
  it('round-trips the genome through stdin and parses a valid NumericScoreCard from stdout', async () => {
    const evaluator = new ShellEvaluator({
      command: nodeEval(
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const {genome}=JSON.parse(d);process.stdout.write(JSON.stringify({primary:genome.x*2,regressed:false,noopRate:0,costPerWin:1,raw:{echoed:genome.x}}))})",
      ),
    });
    const score = await evaluator.evaluate({ x: 3 }, 'v1');
    expect(score.primary).toBe(6);
    expect(score.regressed).toBe(false);
    expect(score.raw).toEqual({ echoed: 3 });
  });

  it('demotes (regressed, -Infinity primary) instead of throwing when the command exits non-zero', async () => {
    const evaluator = new ShellEvaluator({ command: nodeEval('process.exit(1)') });
    const score = await evaluator.evaluate({ x: 1 }, 'v2');
    expect(score.regressed).toBe(true);
    expect(score.primary).toBe(-Infinity);
    expect(score.evaluatorError).toBeTruthy();
  });

  it('demotes instead of throwing when stdout is not valid JSON', async () => {
    const evaluator = new ShellEvaluator({ command: nodeEval("process.stdout.write('not json')") });
    const score = await evaluator.evaluate({ x: 1 }, 'v3');
    expect(score.regressed).toBe(true);
    expect(score.evaluatorError).toContain('non-JSON');
  });

  it('demotes instead of hanging when the command never exits (timeout)', async () => {
    const evaluator = new ShellEvaluator({ command: nodeEval('setInterval(()=>{}, 1000)'), timeoutMs: 300 });
    const score = await evaluator.evaluate({ x: 1 }, 'v4');
    expect(score.regressed).toBe(true);
    expect(score.evaluatorError).toContain('timed out');
  }, 5000);

  // Regression: the genome is written to child.stdin AFTER spawn, so an
  // evaluator that exits without reading stdin leaves the pipe closed and the
  // write raises EPIPE. With no 'error' listener on the stdin socket that is
  // an unhandled error event, which kills the whole evolve run instead of
  // demoting one candidate. A large genome makes the write span multiple
  // chunks so the race resolves the same way on every platform.
  it('demotes, not crashes, when the evaluator exits without reading stdin (EPIPE)', async () => {
    const evaluator = new ShellEvaluator({ command: nodeEval('process.exit(3)') });
    const big: Record<string, number> = {};
    for (let i = 0; i < 200_000; i++) big[`p${i}`] = i;
    const score = await evaluator.evaluate(big, 'epipe');
    expect(score.regressed).toBe(true);
    expect(score.primary).toBe(-Infinity);
    expect(score.evaluatorError).toContain('exited 3');
  }, 20000);

  it('tolerates non-JSON noise before the JSON payload on stdout (takes the first `{`)', async () => {
    const evaluator = new ShellEvaluator({
      command: nodeEval("console.log('some log line'); process.stdout.write(JSON.stringify({primary:1,regressed:false,noopRate:0,costPerWin:1}))"),
    });
    const score = await evaluator.evaluate({ x: 1 }, 'v5');
    expect(score.primary).toBe(1);
  });
});
