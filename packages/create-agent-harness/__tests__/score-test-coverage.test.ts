// SPDX-License-Identifier: MIT
// Dream Cycle 2026-10-25 (generator-genome). `scoreTestCoverage`'s `hasTests`
// check (score.ts) only verified the __tests__/tests/test directory existed,
// never that it contained anything — an empty `mkdir tests` earned the full
// 50/100 "test directory present" credit, the same false-positive class
// 2026-08-25's #229 closed for `scoreTestConfidence`'s sibling signal, through
// a path that fix never touched.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScorecard } from '../src/score.js';

const dirs: string[] = [];
function fixture(): string {
  const d = mkdtempSync(join(tmpdir(), 'score-test-coverage-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function testCoverageDim(dir: string) {
  return buildScorecard(dir).dimensions.find((d) => d.name === 'Test coverage')!;
}

describe('scoreTestCoverage — empty test directory', () => {
  it('an empty tests/ directory (mkdir only, no files inside) earns no "test directory present" credit', () => {
    const dir = fixture();
    mkdirSync(join(dir, 'tests'));
    const dim = testCoverageDim(dir);
    expect(dim.signals).not.toContain('test directory present');
    expect(dim.score).toBe(0);
  });

  it('a tests/ directory with a real file inside still earns full credit (no regression)', () => {
    const dir = fixture();
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'tests', 'smoke.test.ts'), '// smoke', 'utf-8');
    const dim = testCoverageDim(dir);
    expect(dim.signals).toContain('test directory present');
    expect(dim.score).toBe(50);
  });

  it('a __tests__ directory with only dotfiles inside (e.g. .gitkeep) still does not count', () => {
    const dir = fixture();
    mkdirSync(join(dir, '__tests__'));
    writeFileSync(join(dir, '__tests__', '.gitkeep'), '', 'utf-8');
    const dim = testCoverageDim(dir);
    expect(dim.score).toBe(0);
  });

  // Caught by an independent critic the same night: a first version of this
  // fix only checked the top level of `tests/` for a non-dot entry, so
  // `mkdir -p tests/unit` with zero files anywhere still passed (the
  // top-level entry `unit` is itself non-dot). Closed before ship.
  it('a nested-but-still-empty tests/unit/ directory earns no credit either', () => {
    const dir = fixture();
    mkdirSync(join(dir, 'tests', 'unit'), { recursive: true });
    const dim = testCoverageDim(dir);
    expect(dim.score).toBe(0);
    // a real file nested two levels down correctly earns credit
    writeFileSync(join(dir, 'tests', 'unit', 'smoke.test.ts'), '// smoke', 'utf-8');
    expect(testCoverageDim(dir).score).toBe(50);
  });
});
