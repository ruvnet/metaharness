// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { CircuitBreaker, RetryBudget } from '../src/recovery.js';

describe('CircuitBreaker', () => {
  it('opens after the failure threshold and rejects fast', () => {
    const b = new CircuitBreaker({ threshold: 3, cooldownMs: 1000, now: () => 0 });
    expect(b.canProceed()).toBe(true);
    b.recordFailure();
    b.recordFailure();
    expect(b.canProceed()).toBe(true);
    b.recordFailure(); // 3rd → trips
    expect(b.current()).toBe('open');
    expect(b.canProceed()).toBe(false);
  });

  it('goes half-open after cooldown and closes on success', () => {
    let t = 0;
    const b = new CircuitBreaker({ threshold: 1, cooldownMs: 100, now: () => t });
    b.recordFailure();
    expect(b.current()).toBe('open');
    t = 100;
    expect(b.current()).toBe('half-open');
    b.recordSuccess();
    expect(b.current()).toBe('closed');
  });

  it('re-opens if the half-open trial fails', () => {
    let t = 0;
    const b = new CircuitBreaker({ threshold: 1, cooldownMs: 100, now: () => t });
    b.recordFailure();
    t = 100;
    expect(b.current()).toBe('half-open');
    b.recordFailure();
    expect(b.canProceed()).toBe(false);
  });
});

describe('RetryBudget', () => {
  it('refuses to spend past the retry cap', () => {
    const r = new RetryBudget(2);
    expect(r.tryConsume()).toBe(true);
    expect(r.tryConsume()).toBe(true);
    expect(r.tryConsume()).toBe(false); // cap = 2
    expect(r.remaining).toBe(0);
  });

  it('refuses to spend past the USD cap', () => {
    const r = new RetryBudget(10, 0.05);
    expect(r.tryConsume(0.04)).toBe(true);
    expect(r.tryConsume(0.04)).toBe(false); // 0.08 > 0.05
    expect(r.spentUsd).toBeCloseTo(0.04);
  });
});
