// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { AlgorithmRouter, classifyIntent, softmax } from '../src/router.js';

describe('softmax', () => {
  it('sums to 1 and is monotone', () => {
    const p = softmax([1, 2, 3]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(p[2]).toBeGreaterThan(p[0]);
  });
});

describe('classifyIntent', () => {
  it('routes a coding goal to coding', () => {
    expect(classifyIntent({ text: 'Fix the bug in this function and add a test' }).intent).toBe('coding');
  });
  it('routes a research goal to research', () => {
    expect(classifyIntent({ text: 'Find sources and cite evidence for this claim' }).intent).toBe('research');
  });
  it('honours an explicit intent with full confidence', () => {
    const c = classifyIntent({ text: 'whatever', intent: 'security' });
    expect(c.intent).toBe('security');
    expect(c.confidence).toBe(1);
  });
});

describe('AlgorithmRouter', () => {
  it('compiles a coding strategy into a dependency-ordered plan', () => {
    const { steps } = new AlgorithmRouter().plan({ text: 'implement and test the parser' });
    expect(steps.map((s) => s.kind)).toEqual(['plan', 'scan-repo', 'code', 'test', 'review']);
    // each non-root step depends on its predecessor
    expect(steps[2].deps).toContain('coding:scan-repo');
  });
});
