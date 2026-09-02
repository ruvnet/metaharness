// SPDX-License-Identifier: MIT
// Dream Cycle 2026-08-30 (generator-genome) — genome-scorers.ts had ZERO unit
// coverage on main despite feeding `harness genome`'s user-visible
// ready/needs-work/blocked verdict and process exit code (see genome.ts).
// This suite characterizes the 5 pure, deterministic, exported scorers.
// It intentionally makes NO production behavior change of its own — see the
// Dream Cycle gist/issue for #200 (open, touches scorePublishReadiness) and
// #229 (merged 2026-09-02, touches scoreTestConfidence). The
// scoreTestConfidence assertions below were updated post-#229 to match its
// landed behavior (hasVerifiedTestFiles-gated credit); scorePublishReadiness's
// assertions still characterize #200's pre-fix behavior since #200 remains
// unmerged.

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

  it('a single declared test command with no verified test files earns no credit (post-#229: declared-only is no longer trusted)', () => {
    expect(scoreTestConfidence(profile({ testCommands: ['npm test'] }))).toBe(0);
  });

  it('a second declared test command still earns no credit without verified test files (post-#229)', () => {
    expect(scoreTestConfidence(profile({ testCommands: ['npm test', 'cargo test'] }))).toBe(0);
  });

  it('CI presence alone earns a small 0.1 "unconfirmed" credit, not additive with declared-only test commands (post-#229)', () => {
    expect(scoreTestConfidence(profile({ hasCi: true }))).toBeCloseTo(0.1);
    expect(scoreTestConfidence(profile({ testCommands: ['npm test'], hasCi: true }))).toBeCloseTo(0.1);
  });

  it('maximal declared-only signals (multiple test commands + CI) without verified test files still cap at 0.1, not 1 (post-#229)', () => {
    const p = profile({ testCommands: ['npm test', 'cargo test', 'pytest'], hasCi: true });
    expect(scoreTestConfidence(p)).toBe(0.1);
  });

  it('#229 closed the gap: declared test commands with no real test files now score 0, not the same as real coverage', () => {
    // Previously this scored identically to a repo with real test files
    // (0.5) — #229 gated the base credit on `hasVerifiedTestFiles`, a real
    // tests/__tests__/test directory scan. This pins the fix from the other
    // side: the "documented gap" this test used to characterize is closed.
    const claimedOnly = profile({ testCommands: ['npm test'] });
    expect(scoreTestConfidence(claimedOnly)).toBe(0);
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
