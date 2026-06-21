// SPDX-License-Identifier: MIT
//
// Darwin Shield REAL CodeQL oracle ADAPTER SHELL (ADR-155 Addendum A, Phase 2,
// Tier 3 #10). These tests ALWAYS run: they exercise the availability probe (it
// must never throw) and the graceful-skip contract. CodeQL is absent in this
// environment, so `evaluate()` returns `available:false` rather than failing —
// keeping the deterministic suite green everywhere, exactly like semgrep-oracle.

import { describe, expect, it } from 'vitest';
import { CodeqlDetectorOracle, codeqlAvailability } from '../../src/security/codeql-oracle.js';
import type { TargetLabel } from '../../src/security/semgrep-oracle.js';

const labels: TargetLabel[] = [
  { file: 'inj.py', vulnerable: true, weakness: 'CWE-95' },
  { file: 'clean.py', vulnerable: false, weakness: '' },
];

describe('codeql availability probe (always runs, never throws)', () => {
  it('reports a structured availability result', () => {
    const a = codeqlAvailability();
    expect(typeof a.available).toBe('boolean');
    expect(typeof a.binary).toBe('string');
    expect(typeof a.version).toBe('string');
    if (a.available) expect(a.version.length).toBeGreaterThan(0);
  });

  it('graceful skip: an absent binary returns available:false, never throws', () => {
    const a = codeqlAvailability('/nonexistent/codeql-xyz');
    expect(a.available).toBe(false);
    expect(a.version).toBe('');
    expect(typeof a.reason).toBe('string');
  });
});

describe('CodeqlDetectorOracle graceful-skip contract', () => {
  it('isAvailable() returns a boolean and never throws', () => {
    const oracle = new CodeqlDetectorOracle({ binary: '/nonexistent/codeql-xyz' });
    expect(oracle.isAvailable()).toBe(false);
  });

  it('evaluate() returns available:false gracefully when codeql is absent', () => {
    const oracle = new CodeqlDetectorOracle({ binary: '/nonexistent/codeql-xyz' });
    const res = oracle.evaluate('query.ql', { dir: '/tmp/does-not-matter', labels });
    expect(res.available).toBe(false);
    expect(typeof res.reason).toBe('string');
  });

  it('evaluate() on the real (PATH) binary either skips or runs — never silently passes a stub', () => {
    // Uses the real resolution (CODEQL_BIN or PATH). In this environment codeql is
    // absent → available:false. If a future runner HAS codeql, the present-path is
    // not yet implemented and throws; both outcomes are acceptable for the shell.
    const oracle = new CodeqlDetectorOracle();
    if (oracle.isAvailable()) {
      expect(() => oracle.evaluate('query.ql', { dir: '/tmp/x', labels })).toThrow(/not yet implemented/);
    } else {
      const res = oracle.evaluate('query.ql', { dir: '/tmp/x', labels });
      expect(res.available).toBe(false);
    }
  });
});
