// SPDX-License-Identifier: MIT
//
// Dream Cycle 2026-08-25 (generator-genome). `scoreTestConfidence` used to
// credit `testCommands.length > 0` directly — but `testCommands` is inferred
// purely from language/manifest detection in analyze-repo.ts (a
// `pyproject.toml` unconditionally pushes 'pytest' into testCommands, whether
// or not any test file exists). This suite pins the fix: real filesystem
// evidence (`hasVerifiedTestFiles`, from a tests/__tests__/test dir scan) is
// now required for full credit, matching the sibling `score.ts::scoreTestCoverage`
// (which already does a real `dirExists` scan) and closing the gap disclosed
// as an open next-step in 2026-08-15's #200 gist.

import { describe, it, expect } from 'vitest';
import { analyzeFiles } from '../src/analyze-repo.js';
import { scoreTestConfidence } from '../src/genome-scorers.js';

describe('scoreTestConfidence — Dream Cycle 2026-08-25 fix', () => {
  it('a manifest-only python repo with CI but zero real test files scores near-zero, not 0.5-0.8', () => {
    // Regression fixture for the exact counterexample this hypothesis was
    // built on: package.json declares a `test` script and CI is wired, but
    // no __tests__/tests/test directory exists anywhere.
    const files = {
      'package.json': JSON.stringify({ name: 'x', scripts: { test: 'echo no tests' } }),
      '.github/workflows/ci.yml': '# present',
    };
    const profile = analyzeFiles('demo', files);
    expect(profile.hasVerifiedTestFiles).toBe(false);
    expect(profile.testCommands.length).toBeGreaterThan(0); // the old, insufficient signal
    // hasCi-only credit, not the pre-fix 0.8 (0.5 command + 0.3 ci)
    expect(scoreTestConfidence(profile)).toBe(0.1);
  });

  it('a python repo with pyproject.toml but no CI and no test dir scores exactly 0 (was 0.5)', () => {
    const profile = analyzeFiles('demo', { 'pyproject.toml': '[project]\nname = "demo-py"\n' });
    expect(profile.hasVerifiedTestFiles).toBe(false);
    expect(profile.hasCi).toBe(false);
    expect(scoreTestConfidence(profile)).toBe(0);
  });

  it('a repo with a real __tests__ directory (verified) scores full credit, matching pre-fix behavior', () => {
    const files = {
      'package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }),
      '.github/workflows/ci.yml': '# present',
      '__test_dir__': 'present', // synthetic marker analyzeFiles() reads (set by inventory() for a real repo)
    };
    const profile = analyzeFiles('demo', files);
    expect(profile.hasVerifiedTestFiles).toBe(true);
    expect(scoreTestConfidence(profile)).toBe(0.8); // 0.5 verified + 0.3 ci; single command so no +0.2 diversity bonus
  });

  it('a verified-tests repo with >=2 test commands and CI still saturates at 1', () => {
    const files = {
      'Cargo.toml': '[package]\nname = "x"',
      'go.mod': 'module x\n\ngo 1.21\n',
      '.github/workflows/ci.yml': '# present',
      '__test_dir__': 'present',
    };
    const profile = analyzeFiles('demo', files);
    expect(profile.testCommands.length).toBeGreaterThanOrEqual(2);
    expect(scoreTestConfidence(profile)).toBe(1);
  });

  it('a verified-tests repo without CI scores 0.5 (partial credit), never negative or >1', () => {
    const files = { 'go.mod': 'module x\n\ngo 1.21\n', '__test_dir__': 'present' };
    const profile = analyzeFiles('demo', files);
    expect(profile.hasCi).toBe(false);
    const score = scoreTestConfidence(profile);
    expect(score).toBe(0.5);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('a hand-built profile omitting hasVerifiedTestFiles (e.g. existing callers like constraints.test.ts) treats it as unverified, not a crash', () => {
    const profile = {
      name: 'x', languages: ['typescript'], hasMcp: false, hasClaude: false, hasCodex: false,
      hasCi: true, buildCommands: ['tsc'], testCommands: ['vitest'], tokens: [],
      // hasVerifiedTestFiles intentionally omitted — optional field.
    };
    expect(scoreTestConfidence(profile)).toBe(0.1);
  });
});
