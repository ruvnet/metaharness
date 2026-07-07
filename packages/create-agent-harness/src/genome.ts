// SPDX-License-Identifier: MIT
//
// `harness genome <repo>` — 18th subcommand (iter 110). The "strongest next
// commit" per the user's roadmap. Produces a 7-section readiness scorecard
// for a LOCAL repo, ON TOP of analyze-repo's archetype scoring.
//
// LOCAL-only, deterministic, never executes repo code. Same invariant as
// analyze-repo — we inherit the inventory/profile/plan pipeline so the
// no-exec contract is enforced once, not twice.
//
// Modes:
//   - default: human-readable 7-section text report
//   - --json: emits ONLY the 6-field genome scorecard the user named
//   - --out <path>: writes the scorecard JSON to a file (text still goes to stdout)
//   - --bundle: ADR-031 schema-1 envelope of the full report (for support tickets)
//
// Verdict + exit code:
//   - 'ready'      (0) — publish_readiness >= 0.75 && risk_score < 0.35
//   - 'needs-work' (1) — somewhere in between
//   - 'blocked'    (2) — risk_score >= 0.7

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { inventory, analyzeFiles, recommendPlan, type RepoProfile, type HarnessPlan } from './analyze-repo.js';
import { redactSecretsDeep } from './redact.js';
import {
  resolveAgentTopology,
  scoreMcpRisk,
  scoreTestConfidence,
  scorePublishReadiness,
  classifyRepoType,
  type McpSurface,
} from './genome-scorers.js';

export type SubcommandResult = { code: number; lines: string[] };

// The 6-field scorecard shape the user named in the roadmap.
export interface Genome {
  repo_type: string;
  agent_topology: string[];
  risk_score: number;
  mcp_surface: McpSurface;
  test_confidence: number;
  publish_readiness: number;
}

export interface GenomeReport {
  schema: 1;
  generatedAt: string;
  dir: string;
  profile: RepoProfile;
  plan: HarnessPlan;
  genome: Genome;
  verdict: 'ready' | 'needs-work' | 'blocked';
  exitCode: 0 | 1 | 2;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function buildGenomeReport(dir: string, generatedAt: string = new Date().toISOString()): GenomeReport {
  const profile = analyzeFiles(basename(dir), inventory(dir));
  const plan = recommendPlan(profile);
  const topology = resolveAgentTopology(profile, plan);
  const mcp = scoreMcpRisk(profile, plan);
  const testConf = scoreTestConfidence(profile);
  const publish = scorePublishReadiness(profile, plan);
  // risk = weighted blend: most of the signal comes from publish-readiness
  // (the inverse) and MCP surface; tests bend the curve a little.
  const risk = round3(0.5 * (1 - publish) + 0.3 * mcp.numeric + 0.2 * (1 - testConf));
  const genome: Genome = {
    repo_type: classifyRepoType(profile),
    agent_topology: topology,
    risk_score: risk,
    mcp_surface: mcp.surface,
    test_confidence: round2(testConf),
    publish_readiness: round2(publish),
  };
  let verdict: 'ready' | 'needs-work' | 'blocked';
  let exitCode: 0 | 1 | 2;
  if (risk >= 0.7) {
    verdict = 'blocked';
    exitCode = 2;
  } else if (publish >= 0.75 && risk < 0.35) {
    verdict = 'ready';
    exitCode = 0;
  } else {
    verdict = 'needs-work';
    exitCode = 1;
  }
  return { schema: 1, generatedAt, dir, profile, plan, genome, verdict, exitCode };
}

// --- formatting ------------------------------------------------------------

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function verdictLine(v: GenomeReport['verdict']): string {
  switch (v) {
    case 'ready':
      return 'READY — this repo is in shape to scaffold a harness for';
    case 'needs-work':
      return 'NEEDS WORK — harness will scaffold; expect some manual cleanup';
    case 'blocked':
      return 'BLOCKED — fix the high-risk signals before scaffolding';
  }
}

export function formatGenomeReport(r: GenomeReport): string[] {
  const out: string[] = [];
  out.push(`harness genome — ${r.dir}`);
  out.push('');

  // 1. Repo profile
  out.push('1. Repo profile');
  out.push(`   type:              ${r.genome.repo_type}`);
  out.push(`   languages:         ${r.profile.languages.join(', ') || '(none detected)'}`);
  out.push(`   build:             ${r.profile.buildCommands.join(', ') || '(none detected)'}`);
  out.push(`   test:              ${r.profile.testCommands.join(', ') || '(none detected)'}`);
  out.push(`   ci:                ${r.profile.hasCi ? 'present' : 'none'}`);
  out.push(`   mcp signals:       ${r.profile.hasMcp ? 'present' : 'none'}`);
  out.push('');

  // 2. Agent topology
  out.push('2. Agent topology');
  out.push(`   recommended:       ${r.genome.agent_topology.join(', ')}`);
  out.push('');

  // 3. MCP risk model
  out.push('3. MCP risk model');
  out.push(`   surface:           ${r.genome.mcp_surface}`);
  out.push(`   numeric risk:      ${pct(scoreMcpRisk(r.profile, r.plan).numeric)}`);
  out.push(`   policy:            ${r.plan.riskProfile}`);
  out.push('');

  // 4. Test confidence
  out.push('4. Test confidence');
  out.push(`   score:             ${pct(r.genome.test_confidence)}`);
  out.push(`   signals:           ${r.profile.testCommands.length} test command(s), ci ${r.profile.hasCi ? 'yes' : 'no'}`);
  out.push('');

  // 5. Release readiness
  out.push('5. Release readiness');
  out.push(`   score:             ${pct(r.genome.publish_readiness)}`);
  out.push(`   buildable:         ${r.profile.buildCommands.length > 0 ? 'yes' : 'no'}`);
  out.push(`   testable:          ${r.profile.testCommands.length > 0 ? 'yes' : 'no'}`);
  out.push(`   ci wired:          ${r.profile.hasCi ? 'yes' : 'no'}`);
  out.push('');

  // 6. Recommended harness plan
  out.push('6. Recommended harness plan');
  out.push(`   template:          ${r.plan.template}`);
  out.push(`   archetype:         ${r.plan.archetypeId} (confidence ${pct(r.plan.confidence)})`);
  out.push(`   hosts:             ${r.plan.hosts.join(', ')}`);
  out.push(`   agents:            ${r.plan.agents.join(', ') || '(none)'}`);
  out.push(`   skills:            ${r.plan.skills.join(', ') || '(none)'}`);
  out.push('');

  // 7. Scorecard
  out.push('7. Scorecard');
  out.push(`   risk score:        ${pct(r.genome.risk_score)}`);
  out.push(`   publish readiness: ${pct(r.genome.publish_readiness)}`);
  out.push(`   test confidence:   ${pct(r.genome.test_confidence)}`);
  out.push('');

  out.push(`Verdict: ${verdictLine(r.verdict)} (exit ${r.exitCode})`);
  out.push(`Scaffold it: npx metaharness ${r.plan.name} --template ${r.plan.template}`);
  return out;
}

// --- sanitisation (ADR-031) ------------------------------------------------

const SECRET_RE = /(secret|token|key|password|passphrase)/i;

// GH #4 (HIGH-2): redact by KEY name AND by VALUE shape (redact.ts — single source of truth, #7).
function sanitiseValue(v: unknown): unknown {
  return redactSecretsDeep(v, { keyRe: SECRET_RE, replacement: '[REDACTED]' });
}

// --- dispatch --------------------------------------------------------------

function usage(): string[] {
  return [
    'Usage: harness genome <path> [--out <file>] [--json] [--bundle]',
    '',
    '  Produces a 7-section readiness scorecard for a LOCAL repo.',
    '  Defaults to human-readable text.',
    '',
    '  --out <file>   Write the 6-field genome JSON to <file>.',
    '  --json         Emit the 6-field genome JSON to stdout (instead of text).',
    '  --bundle       Emit the full report as an ADR-031 schema-1 envelope.',
  ];
}

export async function genomeCmd(args: string[]): Promise<SubcommandResult> {
  const bundle = args.includes('--bundle');
  const json = args.includes('--json');
  let outPath: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') {
      outPath = args[++i] ?? null;
      if (!outPath) {
        const err = { schema: 1 as const, error: 'missing-out-path', exitCode: 2 };
        return { code: 2, lines: [bundle || json ? JSON.stringify(err, null, 2) : '--out requires a file path'] };
      }
    } else if (a === '--bundle' || a === '--json') {
      /* handled */
    } else if (a === '--help' || a === '-h') {
      return { code: 0, lines: usage() };
    } else if (a && !a.startsWith('--')) {
      positional.push(a);
    } else if (a) {
      const err = { schema: 1 as const, error: `unknown-flag-${a.replace(/^--?/, '')}`, exitCode: 2 };
      return { code: 2, lines: [bundle || json ? JSON.stringify(err, null, 2) : `Unknown flag: ${a}`] };
    }
  }

  if (positional.length === 0) {
    return { code: 2, lines: usage() };
  }

  const dir = resolve(positional[0]!);

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const generatedAt = new Date().toISOString();
    const err = { schema: 1 as const, generatedAt, error: 'not-a-directory', dir, exitCode: 2 };
    if (bundle || json) return { code: 2, lines: [JSON.stringify(err, null, 2)] };
    return { code: 2, lines: [`harness genome: not a directory: ${dir}`] };
  }

  const report = buildGenomeReport(dir);

  if (outPath) {
    try {
      writeFileSync(resolve(outPath), JSON.stringify(report.genome, null, 2) + '\n', 'utf-8');
    } catch (e) {
      const err = { schema: 1 as const, error: 'out-write-failed', detail: String(e), exitCode: 2 };
      return { code: 2, lines: [bundle || json ? JSON.stringify(err, null, 2) : `harness genome: failed to write --out: ${String(e)}`] };
    }
  }

  if (bundle) {
    const sanitised = sanitiseValue({ ...report, exitCode: report.exitCode });
    return { code: report.exitCode, lines: [JSON.stringify(sanitised, null, 2)] };
  }
  if (json) {
    return { code: report.exitCode, lines: [JSON.stringify(report.genome, null, 2)] };
  }
  return { code: report.exitCode, lines: formatGenomeReport(report) };
}
