// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { loadConfigFromString, parseYaml, defaultConfig, buildConfig } from '../src/config/loader.js';
import {
  SafetyViolationError,
  enforceSafetyLimits,
  validateTarget,
  assertNoLiveCredential,
  redact,
} from '../src/config/safety.js';

describe('config loader + safety enforcement', () => {
  it('parses a flat YAML config', () => {
    const yaml = `
target:
  kind: none
limits:
  max_tests: 50
  max_cost_usd: 2
  max_runtime_minutes: 3
families:
  - direct_prompt_injection
  - tool_overreach
`;
    const cfg = loadConfigFromString(yaml);
    expect(cfg.target.kind).toBe('none');
    expect(cfg.limits.max_tests).toBe(50);
    expect(cfg.limits.max_cost_usd).toBe(2);
    expect(cfg.families).toEqual(['direct_prompt_injection', 'tool_overreach']);
  });

  it('forces the dangerous flags OFF even when defaults are applied', () => {
    const cfg = loadConfigFromString('limits:\n  max_tests: 10\n  max_cost_usd: 1\n  max_runtime_minutes: 2\n');
    expect(cfg.limits.allow_network).toBe(false);
    expect(cfg.limits.allow_shell).toBe(false);
    expect(cfg.limits.allow_real_credentials).toBe(false);
  });

  it('throws when allow_network is set true', () => {
    expect(() => enforceSafetyLimits({ ...defaultConfig().limits, allow_network: true })).toThrow(
      SafetyViolationError,
    );
  });
  it('throws when allow_shell is set true', () => {
    expect(() => enforceSafetyLimits({ ...defaultConfig().limits, allow_shell: true })).toThrow(
      SafetyViolationError,
    );
  });
  it('throws when allow_real_credentials is set true', () => {
    expect(() => enforceSafetyLimits({ ...defaultConfig().limits, allow_real_credentials: true })).toThrow(
      SafetyViolationError,
    );
  });

  it('config load rejects a true flag end-to-end', () => {
    const yaml = 'limits:\n  max_tests: 10\n  max_cost_usd: 1\n  max_runtime_minutes: 2\n  allow_network: true\n';
    expect(() => loadConfigFromString(yaml)).toThrow(SafetyViolationError);
  });

  it('rejects a live external http target', () => {
    expect(() => validateTarget({ kind: 'http', url: 'https://api.openai.com/v1' })).toThrow(
      SafetyViolationError,
    );
  });
  it('accepts a loopback http target', () => {
    expect(() => validateTarget({ kind: 'http', url: 'http://localhost:8080/agent' })).not.toThrow();
    expect(() => validateTarget({ kind: 'http', url: 'http://127.0.0.1:9000' })).not.toThrow();
  });

  it('clamps invalid budgets', () => {
    expect(() => enforceSafetyLimits({ ...defaultConfig().limits, max_tests: 0 })).toThrow();
    expect(() => enforceSafetyLimits({ ...defaultConfig().limits, max_cost_usd: -1 })).toThrow();
  });
});

describe('credential guard + redaction', () => {
  it('refuses to forward a real-credential-shaped token', () => {
    expect(() => assertNoLiveCredential('here is sk-abcdefghijklmnop12345')).toThrow(SafetyViolationError);
    expect(() => assertNoLiveCredential('AKIAIOSFODNN7EXAMPLE')).toThrow(SafetyViolationError);
  });
  it('allows benign text', () => {
    expect(() => assertNoLiveCredential('please summarize this document')).not.toThrow();
  });
  it('redacts secrets, emails, ssn', () => {
    const r = redact('email a@b.com key sk-abcdefghijklmnop12345 ssn 123-45-6789');
    expect(r).not.toContain('a@b.com');
    expect(r).not.toContain('sk-abcdefghijklmnop12345');
    expect(r).not.toContain('123-45-6789');
    expect(r).toContain('[REDACTED:');
  });
});

describe('parseYaml edge cases', () => {
  it('handles comments and blank lines', () => {
    const o = parseYaml('# comment\n\nkey: value  # inline\n');
    expect(o.key).toBe('value');
  });
  it('coerces booleans and numbers', () => {
    const o = parseYaml('a: true\nb: 3.5\nc: 7\n');
    expect(o.a).toBe(true);
    expect(o.b).toBe(3.5);
    expect(o.c).toBe(7);
  });
  it('buildConfig fills defaults for missing blocks', () => {
    const cfg = buildConfig({});
    expect(cfg.gates.min_patch_reduction_rate).toBe(0.5);
    expect(cfg.families?.length).toBe(5);
  });
});
