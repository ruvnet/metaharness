// SPDX-License-Identifier: MIT
//
// Darwin Shield REAL Semgrep oracle (ADR-155 Addendum A, Phase 2). These tests
// run real `semgrep --json` when it is available (PATH or SEMGREP_BIN) and SKIP
// gracefully otherwise — so the deterministic suite is green on every machine,
// while real-tool evidence is exercised wherever semgrep exists. The availability
// probe itself is always tested (it must never throw).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SemgrepDetectorOracle, semgrepAvailability } from '../../src/security/semgrep-oracle.js';
import type { TargetLabel } from '../../src/security/semgrep-oracle.js';

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'bench',
  'security',
  'fixtures',
  'semgrep',
);

const oracle = new SemgrepDetectorOracle();
const available = oracle.isAvailable();
const rule = readFileSync(join(fixtureDir, 'rule.yaml'), 'utf8');
const labels: TargetLabel[] = JSON.parse(readFileSync(join(fixtureDir, 'labels.json'), 'utf8')).labels;

describe('semgrep availability probe (always runs, never throws)', () => {
  it('reports a structured availability result', () => {
    const a = semgrepAvailability();
    expect(typeof a.available).toBe('boolean');
    expect(typeof a.binary).toBe('string');
    if (a.available) expect(a.version.length).toBeGreaterThan(0);
  });

  it('graceful skip: an absent binary returns available:false, never throws', () => {
    const fake = new SemgrepDetectorOracle({ binary: '/nonexistent/semgrep-xyz' });
    const res = fake.evaluate(rule, { dir: fixtureDir, labels });
    expect(res.available).toBe(false);
    expect(res.truePositives).toBe(0);
  });
});

describe.skipIf(!available)('real semgrep on the labeled fixture', () => {
  it('detects the real eval() vulnerability (true positive)', () => {
    const res = oracle.evaluate(rule, { dir: fixtureDir, labels });
    expect(res.available).toBe(true);
    expect(res.truePositives).toBe(1);
    expect(res.findings.some((f) => f.path.endsWith('inj.py'))).toBe(true);
  });

  it('does NOT flag the decoy ("evaluate") or the clean file (zero false positives)', () => {
    const res = oracle.evaluate(rule, { dir: fixtureDir, labels });
    expect(res.falsePositives).toBe(0);
    expect(res.precision).toBe(1);
    expect(res.recall).toBe(1);
  });

  it('is reproducible across runs (deterministic findings for a fixed version)', () => {
    const a = oracle.evaluate(rule, { dir: fixtureDir, labels });
    const b = oracle.evaluate(rule, { dir: fixtureDir, labels });
    expect(a.findings).toEqual(b.findings);
    expect({ tp: a.truePositives, fp: a.falsePositives, fn: a.falseNegatives }).toEqual({ tp: b.truePositives, fp: b.falsePositives, fn: b.falseNegatives });
  });
});
