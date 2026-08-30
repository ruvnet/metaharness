// SPDX-License-Identifier: MIT
// Dream Cycle 2026-08-30 (generator-genome) — genome-scorers.ts had ZERO unit
// coverage on main despite feeding `harness genome`'s user-visible
// ready/needs-work/blocked verdict and process exit code (see genome.ts).
// This suite characterizes the 5 pure, deterministic, exported scorers as
// they exist today. It intentionally makes NO behavior change — see the
// Dream Cycle gist/issue for two already-open, unreviewed fix PRs (#200,
// #229) that touch scoreTestConfidence/scorePublishReadiness; this suite is
// additive regression coverage, not a competing fix, so it does not
// duplicate or conflict with either.

import { describe, it, expect } from 'vitest';
import {
  classifyRepoType,
  resolveAgentTopology,
  scoreMcpRisk,
  scoreTestConfidence,
  scorePublishReadiness,
} from '../src/genome-scorers.js';
import type { RepoProfile, HarnessPlan, PolicyProfile } from '../src/analyze-repo.js';

function profile(overrides: Partial<RepoProfile> = {}): RepoProfile {
  return {
    name: 'acme',
    languages: [],
    hasMcp: false,
    hasClaude: false,
    hasCodex: false,
    hasCi: false,
    buildCommands: [],
    testCommands: [],
    tokens: [],
    ...overrides,
  };
}

const SAFE_POLICY: PolicyProfile = {
  defaultDeny: true,
  allowNetwork: false,
  allowShell: false,
  allowFileWrite: false,
  requireApprovalForDangerous: true,
  toolTimeoutMs: 30_000,
  maxToolCallsPerTurn: 8,
  auditLog: true,
};

function plan(overrides: Partial<HarnessPlan> = {}): HarnessPlan {
  return {
    name: 'acme',
    hosts: ['claude-code'],
    template: 'minimal',
    archetypeId: 'typescript-sdk-harness',
    confidence: 0.5,
    engine: 'lexical',
    agents: [],
    skills: [],
    commands: [],
    mcp: 'off',
    policy: SAFE_POLICY,
    riskProfile: 'default-deny',
    suggestedCommands: [],
    ...overrides,
  };
}

// --- classifyRepoType -------------------------------------------------------

describe('classifyRepoType', () => {
  it('returns "unknown" when no known language is detected', () => {
    expect(classifyRepoType(profile())).toBe('unknown');
  });

  it('tags a single language directly', () => {
    expect(classifyRepoType(profile({ languages: ['python'] }))).toBe('python');
    expect(classifyRepoType(profile({ languages: ['go'] }))).toBe('go');
  });

  it('is order-independent (sorts languages before mapping)', () => {
    const a = classifyRepoType(profile({ languages: ['typescript', 'rust'] }));
    const b = classifyRepoType(profile({ languages: ['rust', 'typescript'] }));
    expect(a).toBe(b);
  });

  it('adds "polyglot" only for the rust+typescript combination', () => {
    expect(classifyRepoType(profile({ languages: ['rust', 'typescript'] }))).toBe('rust_node_polyglot');
    // rust+python is NOT flagged polyglot by current logic — locking in today's behavior.
    expect(classifyRepoType(profile({ languages: ['rust', 'python'] }))).toBe('rust_python');
  });

  it('appends mcp and ci tags independently of language', () => {
    expect(classifyRepoType(profile({ languages: ['go'], hasMcp: true }))).toBe('go_mcp');
    expect(classifyRepoType(profile({ languages: ['go'], hasCi: true }))).toBe('go_ci');
    expect(classifyRepoType(profile({ languages: ['go'], hasMcp: true, hasCi: true }))).toBe('go_mcp_ci');
  });

  it('is deterministic for the same input', () => {
    const p = profile({ languages: ['rust', 'typescript'], hasMcp: true, hasCi: true });
    expect(classifyRepoType(p)).toBe(classifyRepoType(p));
  });
});

// --- resolveAgentTopology ----------------------------------------------------

describe('resolveAgentTopology', () => {
  it('always includes "maintainer", even for a bare repo', () => {
    expect(resolveAgentTopology(profile(), plan())).toEqual(['maintainer']);
  });

  it('adds "tester" when testCommands are present', () => {
    const t = resolveAgentTopology(profile({ testCommands: ['npm test'] }), plan());
    expect(t).toContain('tester');
  });

  it('adds "tester" from hasCi alone, with zero test commands', () => {
    const t = resolveAgentTopology(profile({ hasCi: true }), plan());
    expect(t).toContain('tester');
  });

  it('adds "security" when the profile has MCP signals', () => {
    const t = resolveAgentTopology(profile({ hasMcp: true }), plan());
    expect(t).toContain('security');
  });

  it('adds "security" from plan.mcp local/remote even without a profile MCP signal', () => {
    expect(resolveAgentTopology(profile(), plan({ mcp: 'local' }))).toContain('security');
    expect(resolveAgentTopology(profile(), plan({ mcp: 'remote' }))).toContain('security');
    expect(resolveAgentTopology(profile(), plan({ mcp: 'off' }))).not.toContain('security');
  });

  it('adds "release" only when hasCi is true', () => {
    expect(resolveAgentTopology(profile({ hasCi: true }), plan())).toContain('release');
    expect(resolveAgentTopology(profile({ hasCi: false }), plan())).not.toContain('release');
  });

  it('returns a deduplicated, stable set for a fully-signaled repo', () => {
    const t = resolveAgentTopology(
      profile({ testCommands: ['npm test'], hasCi: true, hasMcp: true }),
      plan({ mcp: 'local' }),
    );
    expect(new Set(t).size).toBe(t.length);
    expect(t.sort()).toEqual(['maintainer', 'release', 'security', 'tester']);
  });
});

// --- scoreMcpRisk -------------------------------------------------------------

describe('scoreMcpRisk', () => {
  it('scores plan.mcp "off" as zero risk regardless of policy', () => {
    expect(scoreMcpRisk(profile(), plan({ mcp: 'off' }))).toEqual({ surface: 'off', numeric: 0 });
  });

  it('scores plan.mcp "remote" at a fixed 0.6 regardless of policy', () => {
    const risk = scoreMcpRisk(profile(), plan({ mcp: 'remote', policy: { ...SAFE_POLICY, allowShell: true } }));
    expect(risk).toEqual({ surface: 'remote', numeric: 0.6 });
  });

  it('scores local + default-deny (no permissive flags) as low risk', () => {
    const risk = scoreMcpRisk(profile(), plan({ mcp: 'local', policy: SAFE_POLICY }));
    expect(risk).toEqual({ surface: 'local_default_deny', numeric: 0.15 });
  });

  it.each([
    ['allowShell', { allowShell: true }],
    ['allowNetwork', { allowNetwork: true }],
    ['allowFileWrite', { allowFileWrite: true }],
    ['defaultDeny=false', { defaultDeny: false }],
  ])('scores local + %s as local_permissive (0.45)', (_label, override) => {
    const risk = scoreMcpRisk(profile(), plan({ mcp: 'local', policy: { ...SAFE_POLICY, ...override } }));
    expect(risk).toEqual({ surface: 'local_permissive', numeric: 0.45 });
  });

  it('the local_permissive branch is exercisable here only via a hand-built plan.policy — recommendPlan() always assigns the hardcoded SAFE policy in production, so this branch is currently unreachable through the real genome CLI path (dead code / latent gap, not exercised by any existing caller)', () => {
    const risk = scoreMcpRisk(profile(), plan({ mcp: 'local', policy: { ...SAFE_POLICY, allowShell: true } }));
    expect(risk.surface).toBe('local_permissive');
  });
});

// --- scoreTestConfidence -------------------------------------------------------

describe('scoreTestConfidence', () => {
  it('scores 0 for a repo with no test commands and no CI', () => {
    expect(scoreTestConfidence(profile())).toBe(0);
  });

  it('credits 0.5 for exactly one test command (current heuristic: declared, not verified)', () => {
    expect(scoreTestConfidence(profile({ testCommands: ['npm test'] }))).toBe(0.5);
  });

  it('credits an extra 0.2 for a second declared test command (0.7 total)', () => {
    expect(scoreTestConfidence(profile({ testCommands: ['npm test', 'cargo test'] }))).toBeCloseTo(0.7);
  });

  it('credits 0.3 for CI presence, additively with test commands', () => {
    expect(scoreTestConfidence(profile({ hasCi: true }))).toBeCloseTo(0.3);
    expect(scoreTestConfidence(profile({ testCommands: ['npm test'], hasCi: true }))).toBeCloseTo(0.8);
  });

  it('caps the total at 1', () => {
    const p = profile({ testCommands: ['npm test', 'cargo test', 'pytest'], hasCi: true });
    expect(scoreTestConfidence(p)).toBe(1);
  });

  it('does not verify that declared test commands correspond to real test files (documented gap — see #229)', () => {
    // A repo that only CLAIMS a test command, with no evidence files at all,
    // scores identically to one with real coverage. Locking this in as the
    // current, known behavior so a future fix (#229) has a red baseline.
    const claimedOnly = profile({ testCommands: ['npm test'] });
    expect(scoreTestConfidence(claimedOnly)).toBe(0.5);
  });
});

// --- scorePublishReadiness -----------------------------------------------------

describe('scorePublishReadiness', () => {
  it('scores 0 for an empty profile with a default-deny=false policy', () => {
    const p = plan({ policy: { ...SAFE_POLICY, defaultDeny: false } });
    expect(scorePublishReadiness(profile(), p)).toBe(0);
  });

  it('credits typescript (0.3) and rust (0.15) independently and additively', () => {
    expect(scorePublishReadiness(profile({ languages: ['typescript'] }), plan())).toBeCloseTo(0.3 + 0.05); // + policy.defaultDeny 0.05
    expect(scorePublishReadiness(profile({ languages: ['rust'] }), plan())).toBeCloseTo(0.15 + 0.05);
  });

  it('does NOT credit python or go language presence at all (documented gap — see #200)', () => {
    // Locking in current, known behavior: only typescript/rust move this
    // score via the language checks. A python-only repo gets no language
    // credit even with a full build+test+CI setup.
    const p = profile({ languages: ['python'], buildCommands: ['pytest --collect-only'], testCommands: ['pytest'], hasCi: true });
    const score = scorePublishReadiness(p, plan());
    // build(0.2) + test(0.15) + ci(0.2) + policy.defaultDeny(0.05) = 0.6, no language credit
    expect(score).toBeCloseTo(0.6);
  });

  it('credits buildCommands, testCommands, hasCi, and policy.defaultDeny independently', () => {
    expect(scorePublishReadiness(profile({ buildCommands: ['tsc'] }), plan())).toBeCloseTo(0.2 + 0.05);
    expect(scorePublishReadiness(profile({ testCommands: ['npm test'] }), plan())).toBeCloseTo(0.15 + 0.05);
    expect(scorePublishReadiness(profile({ hasCi: true }), plan())).toBeCloseTo(0.2 + 0.05);
  });

  it('policy.defaultDeny contributes only 0.05', () => {
    const denyOff = plan({ policy: { ...SAFE_POLICY, defaultDeny: false } });
    const denyOn = plan({ policy: { ...SAFE_POLICY, defaultDeny: true } });
    expect(scorePublishReadiness(profile(), denyOn) - scorePublishReadiness(profile(), denyOff)).toBeCloseTo(0.05);
  });

  it('caps the total at 1 for a maximally-signaled repo', () => {
    const p = profile({
      languages: ['typescript', 'rust'],
      buildCommands: ['tsc', 'cargo build'],
      testCommands: ['npm test', 'cargo test'],
      hasCi: true,
    });
    expect(scorePublishReadiness(p, plan())).toBe(1);
  });
});
