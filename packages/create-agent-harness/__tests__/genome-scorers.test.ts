// SPDX-License-Identifier: MIT
//
// Dream Cycle 2026-08-15 (generator-genome). `genome-scorers.ts` is pure and
// I/O-free by design ("unit-testable without fixtures" — its own header) but
// had zero dedicated tests before this file: none of its 5 exported scorers
// were exercised in isolation anywhere in this package. That gap hid a real
// correctness bug (see the 'scorePublishReadiness' describe block below).

import { describe, it, expect } from 'vitest';
import { analyzeFiles, recommendPlan } from '../src/analyze-repo.js';
import {
  classifyRepoType,
  resolveAgentTopology,
  scoreMcpRisk,
  scoreTestConfidence,
  scorePublishReadiness,
} from '../src/genome-scorers.js';

// A "fully mature" fixture for a given language: source manifest + CI +
// default-deny policy — the same shape the removed zz-scratch probe used to
// demonstrate the bug. `withCi` lets the test-confidence assertions turn CI
// on/off independently of the manifest.
function maturedProfile(manifestPath: string, manifestBody: string, withCi = true) {
  const files: Record<string, string> = {
    [manifestPath]: manifestBody,
    'README.md': '# demo\n',
  };
  const profile = analyzeFiles('demo', files);
  profile.hasCi = withCi;
  const plan = recommendPlan(profile);
  return { profile, plan };
}

describe('classifyRepoType', () => {
  it('tags a lone-language repo with just that language', () => {
    const { profile } = maturedProfile('go.mod', 'module demo\n\ngo 1.21\n');
    expect(classifyRepoType(profile)).toBe('go_ci');
  });

  it('tags rust+typescript as polyglot, sorted, deduplicated', () => {
    const files = { 'Cargo.toml': '[package]\nname="x"', 'package.json': '{"name":"x"}' };
    const profile = analyzeFiles('demo', files);
    expect(classifyRepoType(profile)).toBe('rust_node_polyglot');
  });

  it('falls back to "unknown" when no language is detected', () => {
    const profile = analyzeFiles('demo', { 'README.md': '# demo' });
    expect(classifyRepoType(profile)).toBe('unknown');
  });
});

describe('resolveAgentTopology', () => {
  it('always includes maintainer, even for a signal-free repo', () => {
    const { profile, plan } = maturedProfile('README.md', '# demo', false);
    const topo = resolveAgentTopology(profile, plan);
    expect(topo).toContain('maintainer');
  });

  it('adds tester when test commands or CI are present', () => {
    const { profile, plan } = maturedProfile('go.mod', 'module demo\n\ngo 1.21\n', true);
    expect(resolveAgentTopology(profile, plan)).toContain('tester');
  });

  it('returns a stable, deduplicated subset of the 4 canonical roles', () => {
    const { profile, plan } = maturedProfile('Cargo.toml', '[package]\nname="x"', true);
    const topo = resolveAgentTopology(profile, plan);
    expect(new Set(topo).size).toBe(topo.length);
    for (const role of topo) expect(['maintainer', 'tester', 'security', 'release']).toContain(role);
  });
});

describe('scoreMcpRisk', () => {
  it('orders numeric risk: local_default_deny < local_permissive < remote', () => {
    const { profile } = maturedProfile('go.mod', 'module demo\n\ngo 1.21\n');
    const denyPlan = recommendPlan(profile);
    denyPlan.mcp = 'local';
    denyPlan.policy = { ...denyPlan.policy, defaultDeny: true, allowShell: false, allowNetwork: false, allowFileWrite: false };
    const permissivePlan = { ...denyPlan, policy: { ...denyPlan.policy, defaultDeny: false, allowShell: true } };
    const remotePlan = { ...denyPlan, mcp: 'remote' as const };

    const deny = scoreMcpRisk(profile, denyPlan);
    const permissive = scoreMcpRisk(profile, permissivePlan);
    const remote = scoreMcpRisk(profile, remotePlan);

    expect(deny.surface).toBe('local_default_deny');
    expect(permissive.surface).toBe('local_permissive');
    expect(remote.surface).toBe('remote');
    expect(deny.numeric).toBeLessThan(permissive.numeric);
    expect(permissive.numeric).toBeLessThan(remote.numeric);
  });

  it('mcp:"off" scores zero risk', () => {
    const { profile } = maturedProfile('go.mod', 'module demo\n\ngo 1.21\n');
    const plan = recommendPlan(profile);
    plan.mcp = 'off';
    expect(scoreMcpRisk(profile, plan)).toEqual({ surface: 'off', numeric: 0 });
  });
});

describe('scoreTestConfidence', () => {
  it('is 0 with no test commands and no CI', () => {
    const { profile } = maturedProfile('README.md', '# demo', false);
    expect(scoreTestConfidence(profile)).toBe(0);
  });

  it('saturates at 1 only with >=2 test commands AND CI', () => {
    const files = { 'Cargo.toml': '[package]\nname="x"', 'go.mod': 'module x\n\ngo 1.21\n' };
    const profile = analyzeFiles('demo', files);
    profile.hasCi = true;
    // cargo test + go test ./... => 2 distinct test commands
    expect(profile.testCommands.length).toBeGreaterThanOrEqual(2);
    expect(scoreTestConfidence(profile)).toBe(1);
  });

  it('a single test command without CI scores 0.5, not 1', () => {
    const { profile } = maturedProfile('go.mod', 'module demo\n\ngo 1.21\n', false);
    expect(profile.testCommands.length).toBe(1);
    expect(scoreTestConfidence(profile)).toBe(0.5);
  });
});

describe('scorePublishReadiness — Dream Cycle 2026-08-15 fix', () => {
  // Before tonight's fix, this function credited language detection only for
  // 'typescript' (+0.3) and 'rust' (+0.15); every other language in
  // RepoProfile['languages'] (python, go) got +0, and analyze-repo.ts never
  // generated a build command for python/go either, so their `+0.2`
  // buildable bonus was structurally unreachable too. A fully mature
  // (CI-wired, tested, buildable, locked-down) python or go repo capped at
  // 0.40 — genome.ts's 'ready' verdict requires >=0.75, so no pure-python or
  // pure-go repo could ever reach 'ready', independent of actual quality.

  it('a fully mature typescript repo reaches ready-threshold readiness (regression guard)', () => {
    const { profile, plan } = maturedProfile('package.json', JSON.stringify({ name: 'x', scripts: { build: 'tsc', test: 'vitest run' } }));
    expect(scorePublishReadiness(profile, plan)).toBeGreaterThanOrEqual(0.75);
  });

  it('a fully mature python repo now reaches ready-threshold readiness (was capped at 0.40)', () => {
    const { profile, plan } = maturedProfile('pyproject.toml', '[project]\nname = "demo-py"\n');
    expect(profile.buildCommands.length).toBeGreaterThan(0); // build command now inferred for python
    expect(scorePublishReadiness(profile, plan)).toBeGreaterThanOrEqual(0.75);
  });

  it('a fully mature go repo now reaches ready-threshold readiness (was capped at 0.40)', () => {
    const { profile, plan } = maturedProfile('go.mod', 'module demo-go\n\ngo 1.21\n');
    expect(profile.buildCommands.length).toBeGreaterThan(0); // build command now inferred for go
    expect(scorePublishReadiness(profile, plan)).toBeGreaterThanOrEqual(0.75);
  });

  it('a fully mature rust repo does not regress (still >= its pre-fix score)', () => {
    const { profile, plan } = maturedProfile('Cargo.toml', '[package]\nname = "demo-rs"\n');
    // pre-fix rust score with build+test+ci+defaultDeny was 0.75 exactly
    expect(scorePublishReadiness(profile, plan)).toBeGreaterThanOrEqual(0.75);
  });

  it('an immature repo (no CI, no build, no tests) still scores low regardless of language', () => {
    const profile = analyzeFiles('demo', { 'pyproject.toml': '[project]\nname = "x"\n' });
    profile.hasCi = false;
    const plan = recommendPlan(profile);
    // Only language credit (0.3) + whatever defaultDeny contributes; testCommands
    // is non-empty for python (pytest is inferred from language alone), so this
    // is intentionally a partial-maturity case, not a zero case.
    expect(scorePublishReadiness(profile, plan)).toBeLessThan(0.75);
  });

  it('is monotonic: adding CI never lowers the score', () => {
    const { profile: withoutCi, plan: planA } = maturedProfile('go.mod', 'module demo\n\ngo 1.21\n', false);
    const { profile: withCi, plan: planB } = maturedProfile('go.mod', 'module demo\n\ngo 1.21\n', true);
    expect(scorePublishReadiness(withCi, planB)).toBeGreaterThanOrEqual(scorePublishReadiness(withoutCi, planA));
  });

  it('never exceeds 1 regardless of input', () => {
    const { profile, plan } = maturedProfile('package.json', JSON.stringify({ name: 'x', scripts: { build: 'tsc', test: 'vitest run' } }));
    expect(scorePublishReadiness(profile, plan)).toBeLessThanOrEqual(1);
  });
});
