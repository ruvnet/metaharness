// SPDX-License-Identifier: MIT
//
// Darwin Shield REAL fuzz oracle (ADR-155 Addendum B, Phase 2). A property fuzzer
// that EXECUTES real Python with seeded random inputs and falsifies the totality
// invariant. Real-tool parts skipIf(!python3); the availability + graceful-skip
// paths always run so the deterministic suite is green everywhere.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RealFuzzOracle, pythonAvailability } from '../../src/security/fuzz-oracle.js';
import type { FuzzCorpus } from '../../src/security/fuzz-oracle.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bench', 'security', 'fixtures', 'fuzz');
const labels = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8')).labels;
const corpus: FuzzCorpus = { dir, driver: 'driver.py', labels };
const oracle = new RealFuzzOracle();
const available = oracle.isAvailable();

describe('python availability (always runs, never throws)', () => {
  it('reports a structured result', () => {
    const a = pythonAvailability();
    expect(typeof a.available).toBe('boolean');
    if (a.available) expect(a.version.toLowerCase()).toContain('python');
  });
  it('graceful skip: an absent interpreter returns available:false, never throws', () => {
    const fake = new RealFuzzOracle({ python: '/nonexistent/python-xyz' });
    const r = fake.evaluate(corpus);
    expect(r.available).toBe(false);
    expect(r.truePositives).toBe(0);
  });
});

describe.skipIf(!available)('real property fuzzer on the labeled corpus', () => {
  it('falsifies the totality invariant on real vulnerabilities (true positives)', () => {
    const r = oracle.evaluate(corpus, { seed: 0, iterations: 5000 });
    expect(r.available).toBe(true);
    expect(r.truePositives).toBe(2);
    const byFile = new Map(r.outcomes.map((o) => [o.file, o]));
    expect(byFile.get('vuln/divide.py')!.exceptionClass).toBe('ZeroDivisionError');
    expect(byFile.get('vuln/index.py')!.exceptionClass).toBe('IndexError');
  });

  it('holds on clean code — zero false positives (counterexample required)', () => {
    const r = oracle.evaluate(corpus, { seed: 0, iterations: 5000 });
    expect(r.falsePositives).toBe(0);
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(1);
    expect(r.outcomes.filter((o) => !o.vulnerable).every((o) => !o.falsified)).toBe(true);
  });

  it('reports only the exception CLASS, never an input (defensive)', () => {
    const r = oracle.fuzz(join(dir, 'driver.py'), join(dir, 'vuln', 'divide.py'), { seed: 0, iterations: 5000 });
    expect(r.falsified).toBe(true);
    expect(r.exceptionClass).toBe('ZeroDivisionError');
    expect(r).not.toHaveProperty('input');
  });

  it('is deterministic for a fixed seed', () => {
    const a = oracle.evaluate(corpus, { seed: 7, iterations: 3000 });
    const b = oracle.evaluate(corpus, { seed: 7, iterations: 3000 });
    expect(a.outcomes).toEqual(b.outcomes);
    expect({ tp: a.truePositives, fp: a.falsePositives }).toEqual({ tp: b.truePositives, fp: b.falsePositives });
  });
});
