// SPDX-License-Identifier: MIT
//
// Tests for the deterministic CASA intent compiler (ADR-237 §4).
//
// Coverage focus per the ADR's load-bearing invariant: dangerous scopes
// (git.push, secret.export, deployment.create) must never leak into
// `.allow` unless the objective explicitly names that kind of action, and
// every compiled envelope must validate against schema.ts.

import { describe, it, expect } from 'vitest';
import {
  compileObjectiveToEnvelope,
  DANGEROUS_SCOPES,
  DEFAULT_BUDGET_USD,
  DEFAULT_TTL_MINUTES,
} from '../compile.js';
import { validateCasaEnvelope, isCasaEnvelope, parseCasaEnvelope } from '../schema.js';

const FIXED_NOW = new Date('2026-07-30T21:00:00.000Z');

describe('compileObjectiveToEnvelope', () => {
  it('compiles a plain security-review objective to repository.read + tests.execute, no dangerous scopes', () => {
    const envelope = compileObjectiveToEnvelope('review repository security', { now: () => FIXED_NOW });

    expect(envelope.allow).toContain('repository.read');
    expect(envelope.allow).toContain('tests.execute');
    for (const scope of DANGEROUS_SCOPES) {
      expect(envelope.allow).not.toContain(scope);
      expect(envelope.deny).toContain(scope);
    }
  });

  it('matches the ADR-237 §4 worked example exactly', () => {
    const envelope = compileObjectiveToEnvelope('review repository security', {
      now: () => FIXED_NOW,
      defaultBudgetUsd: 8,
      defaultTtlMinutes: 60,
    });
    expect(envelope.allow).toEqual(['repository.read', 'tests.execute']);
    expect([...envelope.deny].sort()).toEqual([...DANGEROUS_SCOPES].sort());
    expect(envelope.budget_usd).toBe(8);
    expect(envelope.expires_at).toBe('2026-07-30T22:00:00.000Z');
  });

  it('produces output that validates against schema.ts (no issues, isCasaEnvelope true)', () => {
    const envelope = compileObjectiveToEnvelope('audit the codebase for vulnerabilities', { now: () => FIXED_NOW });
    expect(validateCasaEnvelope(envelope)).toEqual([]);
    expect(isCasaEnvelope(envelope)).toBe(true);
    expect(() => parseCasaEnvelope(envelope)).not.toThrow();
  });

  it('defaults budget_usd and expires_at when opts are omitted', () => {
    const envelope = compileObjectiveToEnvelope('inspect the auth module', { now: () => FIXED_NOW });
    expect(envelope.budget_usd).toBe(DEFAULT_BUDGET_USD);
    expect(envelope.expires_at).toBe(
      new Date(FIXED_NOW.getTime() + DEFAULT_TTL_MINUTES * 60_000).toISOString(),
    );
  });

  it('honors defaultBudgetUsd and defaultTtlMinutes overrides', () => {
    const envelope = compileObjectiveToEnvelope('review the repo', {
      now: () => FIXED_NOW,
      defaultBudgetUsd: 8,
      defaultTtlMinutes: 15,
    });
    expect(envelope.budget_usd).toBe(8);
    expect(envelope.expires_at).toBe(new Date(FIXED_NOW.getTime() + 15 * 60_000).toISOString());
  });

  it('never puts a dangerous scope in allow unless the objective explicitly names it', () => {
    const neutralObjectives = [
      'review repository security',
      'run the test suite',
      'audit dependencies for CVEs',
      'inspect the codebase',
      'analyze recent commits',
      'check the CI configuration',
    ];
    for (const objective of neutralObjectives) {
      const envelope = compileObjectiveToEnvelope(objective, { now: () => FIXED_NOW });
      for (const scope of DANGEROUS_SCOPES) {
        expect(envelope.allow).not.toContain(scope);
      }
    }
  });

  it('grants git.push only when the objective explicitly says push', () => {
    const envelope = compileObjectiveToEnvelope('push the latest commits to the branch', { now: () => FIXED_NOW });
    expect(envelope.allow).toContain('git.push');
    expect(envelope.deny).not.toContain('git.push');
    // Other dangerous scopes remain denied since they were not named.
    expect(envelope.allow).not.toContain('secret.export');
    expect(envelope.allow).not.toContain('deployment.create');
  });

  it('grants deployment.create only when the objective explicitly says deploy/publish/release', () => {
    for (const objective of ['deploy the service to production', 'publish the new version', 'release v2.0']) {
      const envelope = compileObjectiveToEnvelope(objective, { now: () => FIXED_NOW });
      expect(envelope.allow).toContain('deployment.create');
      expect(envelope.deny).not.toContain('deployment.create');
    }
  });

  it('does not grant git.push for objectives that merely contain the bare word "push" in an unrelated sense', () => {
    const falsePositives = [
      'push notification integration for mobile app',
      'push back on the proposed schema change',
      'please push through this urgent bug fix',
    ];
    for (const objective of falsePositives) {
      const envelope = compileObjectiveToEnvelope(objective, { now: () => FIXED_NOW });
      expect(envelope.allow).not.toContain('git.push');
      expect(envelope.deny).toContain('git.push');
    }
  });

  it('does not grant deployment.create for objectives that merely contain "publish"/"release"/"deploy" in an unrelated sense', () => {
    const falsePositives = [
      'review the release notes for security issues',
      'check for a new release of the dependency',
      'publish a blog post about our roadmap',
      'audit the changelog before we publish it',
    ];
    for (const objective of falsePositives) {
      const envelope = compileObjectiveToEnvelope(objective, { now: () => FIXED_NOW });
      expect(envelope.allow).not.toContain('deployment.create');
      expect(envelope.deny).toContain('deployment.create');
    }
  });

  it('grants secret.export only when the objective explicitly says export secrets', () => {
    const envelope = compileObjectiveToEnvelope('export secrets for the migration', { now: () => FIXED_NOW });
    expect(envelope.allow).toContain('secret.export');
    expect(envelope.deny).not.toContain('secret.export');
  });

  it('never allows a scope to appear in both allow and deny simultaneously', () => {
    const objectives = [
      'review repository security',
      'push the release branch',
      'deploy the service to production',
      'export secrets for the migration',
      'do absolutely nothing recognizable',
    ];
    for (const objective of objectives) {
      const envelope = compileObjectiveToEnvelope(objective, { now: () => FIXED_NOW });
      const overlap = envelope.allow.filter((scope) => envelope.deny.includes(scope));
      expect(overlap).toEqual([]);
    }
  });

  it('an objective matching no keywords yields an empty allow list and the full dangerous deny list', () => {
    const envelope = compileObjectiveToEnvelope('do absolutely nothing recognizable', { now: () => FIXED_NOW });
    expect(envelope.allow).toEqual([]);
    expect([...envelope.deny].sort()).toEqual([...DANGEROUS_SCOPES].sort());
  });

  it('never calls an LLM/network: is synchronous and returns a plain object, not a Promise', () => {
    const result = compileObjectiveToEnvelope('review repository security', { now: () => FIXED_NOW });
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result).toBe('object');
  });

  it('is deterministic — same objective + same clock yields byte-identical output', () => {
    const a = compileObjectiveToEnvelope('review repository security', { now: () => FIXED_NOW });
    const b = compileObjectiveToEnvelope('review repository security', { now: () => FIXED_NOW });
    expect(a).toEqual(b);
  });

  it('supports the documented translator extension point without calling it unless supplied', () => {
    let called = false;
    const envelope = compileObjectiveToEnvelope('review repository security', {
      now: () => FIXED_NOW,
      translator: () => {
        called = true;
        return { allow: ['custom.scope'] };
      },
    });
    expect(called).toBe(true);
    expect(envelope.allow).toContain('custom.scope');
    expect(envelope.allow).toContain('repository.read');
  });

  it('does not invoke the translator when none is supplied', () => {
    // No translator option at all — the deterministic rule table is the
    // entire compilation. Nothing in this path can call an LLM.
    const envelope = compileObjectiveToEnvelope('review repository security', { now: () => FIXED_NOW });
    expect(envelope.allow).toEqual(['repository.read', 'tests.execute']);
  });

  it('translator-added dangerous scope is removed from deny (never present in both lists)', () => {
    const envelope = compileObjectiveToEnvelope('review repository security', {
      now: () => FIXED_NOW,
      translator: () => ({ allow: ['git.push'] }),
    });
    expect(envelope.allow).toContain('git.push');
    expect(envelope.deny).not.toContain('git.push');
  });

  it('translator output is re-validated and cannot produce a structurally invalid envelope', () => {
    // Type-valid (budget_usd is a number) but runtime-invalid (not
    // positive) — proves the translator patch is re-validated against
    // schema.ts, not trusted blindly.
    expect(() =>
      compileObjectiveToEnvelope('review repository security', {
        now: () => FIXED_NOW,
        translator: () => ({ budget_usd: -5 }),
      }),
    ).toThrow();
  });
});

describe('schema.ts — validateCasaEnvelope / parseCasaEnvelope / isCasaEnvelope', () => {
  const VALID = {
    objective: 'review repository security',
    allow: ['repository.read', 'tests.execute'],
    deny: ['git.push', 'secret.export', 'deployment.create'],
    budget_usd: 8,
    expires_at: '2026-07-30T22:00:00Z',
  };

  it('accepts the ADR-237 §4 worked example verbatim', () => {
    expect(validateCasaEnvelope(VALID)).toEqual([]);
    expect(isCasaEnvelope(VALID)).toBe(true);
  });

  it('rejects a non-object candidate', () => {
    expect(validateCasaEnvelope(null).length).toBeGreaterThan(0);
    expect(validateCasaEnvelope('not an envelope').length).toBeGreaterThan(0);
    expect(validateCasaEnvelope(42).length).toBeGreaterThan(0);
    expect(validateCasaEnvelope(['array']).length).toBeGreaterThan(0);
  });

  it('rejects a missing required field', () => {
    const { objective, ...rest } = VALID;
    expect(validateCasaEnvelope(rest).length).toBeGreaterThan(0);
  });

  it('rejects an empty-string objective', () => {
    expect(validateCasaEnvelope({ ...VALID, objective: '' }).length).toBeGreaterThan(0);
  });

  it('rejects a non-array allow/deny', () => {
    expect(validateCasaEnvelope({ ...VALID, allow: 'repository.read' }).length).toBeGreaterThan(0);
    expect(validateCasaEnvelope({ ...VALID, deny: null }).length).toBeGreaterThan(0);
  });

  it('rejects an empty-string scope inside allow', () => {
    expect(validateCasaEnvelope({ ...VALID, allow: ['repository.read', ''] }).length).toBeGreaterThan(0);
  });

  it('rejects budget_usd <= 0, non-finite, or non-numeric', () => {
    expect(validateCasaEnvelope({ ...VALID, budget_usd: 0 }).length).toBeGreaterThan(0);
    expect(validateCasaEnvelope({ ...VALID, budget_usd: -1 }).length).toBeGreaterThan(0);
    expect(validateCasaEnvelope({ ...VALID, budget_usd: Number.POSITIVE_INFINITY }).length).toBeGreaterThan(0);
    expect(validateCasaEnvelope({ ...VALID, budget_usd: '8' }).length).toBeGreaterThan(0);
  });

  it('rejects an unparseable expires_at', () => {
    expect(validateCasaEnvelope({ ...VALID, expires_at: 'not-a-date' }).length).toBeGreaterThan(0);
    expect(validateCasaEnvelope({ ...VALID, expires_at: '' }).length).toBeGreaterThan(0);
  });

  it('rejects an envelope with an extra, unrecognized key (strict schema)', () => {
    expect(validateCasaEnvelope({ ...VALID, extra_field: 'nope' }).length).toBeGreaterThan(0);
  });

  it('parseCasaEnvelope throws CasaEnvelopeValidationError with all issues on an invalid candidate', () => {
    expect(() => parseCasaEnvelope({ objective: '' })).toThrow(/invalid CasaEnvelope/);
  });

  it('parseCasaEnvelope returns the same object shape on a valid candidate', () => {
    expect(parseCasaEnvelope(VALID)).toEqual(VALID);
  });
});
