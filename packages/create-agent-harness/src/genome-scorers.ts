// SPDX-License-Identifier: MIT
//
// Pure scorers for `harness genome` (iter 110). Every function is deterministic
// and I/O-free — inputs are the RepoProfile / HarnessPlan from analyze-repo,
// outputs are numeric scores in [0, 1] and discrete classifications. Unit-
// testable without fixtures.
//
// The dimensions match the user's roadmap spec for the genome report:
//   1. classifyRepoType        -> string  (e.g. "rust_wasm_node_monorepo")
//   2. resolveAgentTopology    -> string[] ("maintainer","tester","security","release")
//   3. scoreMcpRisk            -> { surface, numeric }
//   4. scoreTestConfidence     -> number   [0..1]
//   5. scorePublishReadiness   -> number   [0..1]

import type { RepoProfile, HarnessPlan } from './analyze-repo.js';

// --- 1. repo type classifier ----------------------------------------------

/**
 * Composite classifier — joins the languages + structural signals into a
 * single underscore-delimited tag. Deterministic; the same profile always
 * produces the same tag (we sort the inputs).
 */
export function classifyRepoType(p: RepoProfile): string {
  const parts: string[] = [];
  const langs = [...p.languages].sort();
  if (langs.includes('rust')) parts.push('rust');
  if (langs.includes('typescript')) parts.push('node');
  if (langs.includes('python')) parts.push('python');
  if (langs.includes('go')) parts.push('go');
  if (parts.length === 0) parts.push('unknown');
  if (p.hasMcp) parts.push('mcp');
  if (p.hasCi) parts.push('ci');
  // We can't tell monorepo-ness from inventory alone, but a Cargo+Node combo
  // is a strong signal that we report as a flat tag.
  if (langs.includes('rust') && langs.includes('typescript')) parts.push('polyglot');
  return parts.join('_');
}

// --- 2. agent topology resolver --------------------------------------------

/**
 * Maps the analyze-repo plan + profile into the four canonical maintenance
 * roles the user named in the roadmap. Always returns a stable, deduplicated
 * subset of ["maintainer","tester","security","release"].
 */
export function resolveAgentTopology(profile: RepoProfile, plan: HarnessPlan): string[] {
  const out = new Set<string>();
  // Maintainer is the floor — every repo gets one.
  out.add('maintainer');
  // Tester if the repo has any test signal (commands or pre-existing CI).
  if (profile.testCommands.length > 0 || profile.hasCi) out.add('tester');
  // Security if MCP is enabled or the plan picks a default-deny MCP mode.
  if (profile.hasMcp || plan.mcp === 'local' || plan.mcp === 'remote') out.add('security');
  // Release if the repo has CI plumbing already (it can ship).
  if (profile.hasCi) out.add('release');
  return Array.from(out);
}

// --- 3. MCP risk model -----------------------------------------------------

export type McpSurface = 'local_default_deny' | 'local_permissive' | 'remote' | 'off';

export interface McpRisk {
  surface: McpSurface;
  numeric: number; // [0..1] — 0 lowest risk, 1 highest
}

export function scoreMcpRisk(profile: RepoProfile, plan: HarnessPlan): McpRisk {
  if (plan.mcp === 'off') return { surface: 'off', numeric: 0 };
  if (plan.mcp === 'remote') return { surface: 'remote', numeric: 0.6 };
  // plan.mcp === 'local'
  const p = plan.policy;
  const permissive = p.allowShell || p.allowNetwork || p.allowFileWrite || !p.defaultDeny;
  if (permissive) return { surface: 'local_permissive', numeric: 0.45 };
  return { surface: 'local_default_deny', numeric: 0.15 };
}

// --- 4. test confidence ----------------------------------------------------

/**
 * Test confidence is a soft heuristic — we can't actually run the tests
 * (the analyze-repo invariant forbids code execution), so we score based on
 * REAL filesystem evidence a test directory exists (profile.hasVerifiedTestFiles,
 * populated in analyze-repo.ts from a tests/__tests__/test dir scan), not just
 * that a language/manifest was detected.
 *
 * Before Dream Cycle 2026-08-25, this credited `testCommands.length > 0`
 * directly — but testCommands is inferred purely from language/manifest
 * presence (e.g. a `pyproject.toml` unconditionally pushes 'pytest'), so a
 * repo with a test-capable manifest and zero actual test files still scored
 * 0.5-0.8. External research (arXiv:2606.18168, arXiv:2607.18057; SWE-bench's
 * real-execution harness; the kodustech/agent-readiness OSS scorer) confirms
 * this "manifest implies tests" shortcut is a known, actively-flagged failure
 * mode. This package's own sibling `score.ts::scoreTestCoverage` already
 * weights real directory evidence as its largest single component (50/100,
 * vs. 25 each for a declared npm-test script and CI, which still apply
 * independently) — narrower parity than "requires" it outright, but this
 * candidate moves genome-scorers.ts's weaker, purely-inferred version toward
 * that same real-evidence-first shape rather than claiming full agreement.
 *
 * Without verified test files, CI alone earns only a small "infra exists but
 * unconfirmed" credit rather than the prior full test-command credit.
 */
export function scoreTestConfidence(profile: RepoProfile): number {
  if (!profile.hasVerifiedTestFiles) return profile.hasCi ? 0.1 : 0;
  let s = 0.5;
  if (profile.testCommands.length >= 2) s += 0.2;
  if (profile.hasCi) s += 0.3;
  return Math.min(1, s);
}

// --- 5. publish readiness --------------------------------------------------

/**
 * Publish readiness — how close is this repo to being npm-publishable as a
 * package today? Conservative score; releases need everything.
 */
export function scorePublishReadiness(profile: RepoProfile, plan: HarnessPlan): number {
  let s = 0;
  if (profile.languages.includes('typescript')) s += 0.3; // has package.json
  if (profile.languages.includes('rust')) s += 0.15; // has Cargo.toml
  if (profile.buildCommands.length > 0) s += 0.2; // can build
  if (profile.testCommands.length > 0) s += 0.15; // can test
  if (profile.hasCi) s += 0.2; // ci will gate it
  if (plan.policy.defaultDeny) s += 0.05; // policy locked
  return Math.min(1, s);
}
