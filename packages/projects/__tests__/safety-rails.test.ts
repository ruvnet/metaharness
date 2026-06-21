// SPDX-License-Identifier: MIT
//
// Tests for safety-rails.ts (ADR-164 Darwin Safety Rails): test-disabling
// mutations and protected-file edits are rejected, clean changes pass, and the
// rails are immutable (frozen + tampering throws) — i.e. NOT in the mutation
// surface.

import { describe, it, expect } from 'vitest';
import {
  builtinRails,
  RailRegistry,
  rejectsBeforeBenchmark,
  type CandidateChange,
} from '../src/safety-rails.js';

/** A baseline clean candidate; spread + override per test. */
function clean(over: Partial<CandidateChange> = {}): CandidateChange {
  return {
    id: 'c0',
    diff: '+ // harmless change',
    touchedFiles: ['src/feature.ts'],
    disablesTests: false,
    weakensSecurity: false,
    editsSecretsHandling: false,
    bypassesSandbox: false,
    protectedFilesTouched: [],
    ...over,
  };
}

describe('safety-rails rejection', () => {
  it('rejects a test-disabling mutation with no-disable-tests', () => {
    const reg = new RailRegistry();
    const c = clean({ id: 'cheat-tests', disablesTests: true });
    const res = reg.evaluate(c);
    expect(res.ok).toBe(false);
    expect(res.violations.map((v) => v.railId)).toContain('no-disable-tests');
    expect(rejectsBeforeBenchmark(c)).toBe(true);
  });

  it('rejects a protected-file edit (scoring) with no-protected-file-edit', () => {
    const reg = new RailRegistry();
    const c = clean({ id: 'cheat-scoring', touchedFiles: ['src/security/scoring.ts'] });
    const res = reg.evaluate(c);
    expect(res.ok).toBe(false);
    expect(res.violations.map((v) => v.railId)).toContain('no-protected-file-edit');
  });

  it('passes a clean change', () => {
    const reg = new RailRegistry();
    const res = reg.evaluate(clean());
    expect(res.ok).toBe(true);
    expect(res.violations).toEqual([]);
    expect(rejectsBeforeBenchmark(clean())).toBe(false);
  });
});

describe('safety-rails immutability (rails are not in the mutation surface)', () => {
  it('attempting to mutate a built-in rail throws', () => {
    const reg = new RailRegistry();
    expect(() => reg.tryMutateRail()).toThrow();
    // Direct tamper of a rail field also throws in strict mode.
    const rail = builtinRails()[0];
    expect(() => {
      (rail as { id: string }).id = 'tampered';
    }).toThrow();
    expect(() => {
      (rail as { check: unknown }).check = () => null;
    }).toThrow();
  });

  it('all builtin rails are frozen', () => {
    for (const rail of builtinRails()) {
      expect(Object.isFrozen(rail)).toBe(true);
    }
  });
});
