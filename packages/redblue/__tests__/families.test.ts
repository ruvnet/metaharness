// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { generateFamily, generateSuite, resetIds, FAMILY_META } from '../src/attacks/families.js';
import { ALL_FAMILIES } from '../src/config/loader.js';
import type { AttackFamily } from '../src/types.js';

describe('attack-family generators', () => {
  it('every family generates well-shaped TestCases', () => {
    for (const fam of ALL_FAMILIES as AttackFamily[]) {
      resetIds();
      const cases = generateFamily(fam, 3);
      expect(cases).toHaveLength(3);
      for (const c of cases) {
        expect(c.family).toBe(fam);
        expect(c.id).toContain(fam);
        expect(typeof c.objective).toBe('string');
        expect(c.objective.length).toBeGreaterThan(0);
        expect(typeof c.input).toBe('string');
        expect(c.input.length).toBeGreaterThan(0);
        expect(typeof c.expectedSafeBehavior).toBe('string');
        expect(Array.isArray(c.forbiddenOutcomes)).toBe(true);
        expect(c.forbiddenOutcomes.length).toBeGreaterThan(0);
        expect(c.owasp).toBe(FAMILY_META[fam].owasp);
        expect(c.nist).toBe(FAMILY_META[fam].nist);
      }
    }
  });

  it('does NOT embed working exploit strings (safe labels only)', () => {
    // sanity: probes are benign asks, not copy-paste jailbreaks / real secrets
    resetIds();
    const cases = generateSuite(ALL_FAMILIES as AttackFamily[], 25);
    for (const c of cases) {
      expect(c.input).not.toMatch(/\bsk-[A-Za-z0-9]{16,}\b/); // no real-key-shaped tokens
      expect(c.input).not.toMatch(/AKIA[0-9A-Z]{16}/);
    }
  });

  it('generateSuite distributes across families and respects the total', () => {
    resetIds();
    const cases = generateSuite(ALL_FAMILIES as AttackFamily[], 100);
    expect(cases).toHaveLength(100);
    const byFamily = new Map<string, number>();
    for (const c of cases) byFamily.set(c.family, (byFamily.get(c.family) ?? 0) + 1);
    expect(byFamily.size).toBe(5);
    for (const count of byFamily.values()) {
      expect(count).toBeGreaterThanOrEqual(20 - 1);
    }
  });

  it('ids are unique within a suite', () => {
    resetIds();
    const cases = generateSuite(ALL_FAMILIES as AttackFamily[], 50);
    const ids = new Set(cases.map((c) => c.id));
    expect(ids.size).toBe(cases.length);
  });
});
