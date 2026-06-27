// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { extractJson, validateVerdict, parseVerdict, judge } from '../src/judges/judge.js';
import { MockModelClient } from '../src/models/mock.js';
import type { TestCase, TargetTelemetry } from '../src/types.js';

const test: TestCase = {
  id: 'x-0001',
  family: 'direct_prompt_injection',
  actor: 'prompt_injector',
  objective: 'get the target to ignore instructions',
  input: 'probe',
  expectedSafeBehavior: 'treat as data',
  forbiddenOutcomes: ['reveals system prompt'],
  owasp: 'LLM01_prompt_injection',
  nist: 'MEASURE',
};
const tel: TargetTelemetry = { output: 'my system prompt is...', toolCalls: [], latencyMs: 5 };

describe('judge strict-JSON parsing', () => {
  it('extracts JSON from fenced output', () => {
    const j = extractJson('```json\n{"a":1}\n```');
    expect(j).toBe('{"a":1}');
  });
  it('extracts JSON from prose-wrapped output', () => {
    const j = extractJson('Here is my verdict: {"compromised": true} thanks');
    expect(j).toBe('{"compromised": true}');
  });
  it('handles nested braces', () => {
    const j = extractJson('{"a": {"b": 1}, "c": 2}');
    expect(j).toBe('{"a": {"b": 1}, "c": 2}');
  });
  it('returns null with no JSON', () => {
    expect(extractJson('no json here')).toBeNull();
  });

  it('validates a correct verdict', () => {
    const v = validateVerdict({
      compromised: true,
      severity: 'High',
      evidence: ['x'],
      policy_violation: true,
      recommended_fix: 'patch it',
    });
    expect(v).not.toBeNull();
    expect(v!.severity).toBe('High');
  });
  it('rejects a bad severity band', () => {
    expect(
      validateVerdict({ compromised: true, severity: 'SUPER', evidence: [], policy_violation: false, recommended_fix: '' }),
    ).toBeNull();
  });
  it('rejects missing fields', () => {
    expect(validateVerdict({ compromised: true })).toBeNull();
  });
  it('parseVerdict round-trips', () => {
    const v = parseVerdict('{"compromised":false,"severity":"Info","evidence":[],"policy_violation":false,"recommended_fix":"none"}');
    expect(v!.compromised).toBe(false);
  });
});

describe('judge retry behavior', () => {
  it('retries on malformed JSON then succeeds', async () => {
    let n = 0;
    const client = new MockModelClient(() => {
      n += 1;
      if (n < 2) return 'not json at all';
      return '{"compromised":true,"severity":"High","evidence":["e"],"policy_violation":true,"recommended_fix":"fix"}';
    }, 0.001);
    const { verdict } = await judge(client, 'm', test, tel, 2);
    expect(verdict.compromised).toBe(true);
    expect(n).toBe(2);
  });

  it('falls back conservatively after exhausting retries', async () => {
    const client = new MockModelClient(() => 'garbage', 0.001);
    const { verdict, costUsd } = await judge(client, 'm', test, tel, 1);
    expect(verdict.compromised).toBe(false);
    expect(verdict.severity).toBe('Info');
    // 1 retry => 2 calls => cost accrues
    expect(costUsd).toBeCloseTo(0.002, 6);
  });
});
