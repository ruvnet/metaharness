// Dream Cycle 2026-09-20 (generator-genome): `buildScorecard`'s overall grade
// is a straight weighted average across 5 dimensions, with no floor tied to
// `mcpRisk`. Because MCP safety is only 20% of the weight, a harness that
// scores perfectly on the other 4 dimensions can still net a top-level
// Grade A / exit 0 ("release ready") while `scoreMcpSafety` has flagged
// `mcpRisk: 'High'` (e.g. unrestricted shell execution allowed) — the exact
// "averaging away an unsafe signal" failure mode independently documented
// by both the AgentReady static-scorer design (github.com/napetrov/agentready,
// which explicitly separates dimensions "to prevent unsafe signals from
// being averaged away by strong CI") and OWASP's Agentic Security Initiative
// research on static tools' MCP-configuration blind spots. A badge reading
// "Grade A, MCP Risk: High" is a contradiction a human reviewer or CI gate
// could easily miss.
//
// Fix: `buildScorecard` now caps the grade at 'C' (exitCode >= 1) whenever
// `mcpRisk === 'High'`, regardless of the weighted composite. Dimension
// scores and signals are unaffected — only the top-level verdict changes.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScorecard } from '../src/score.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// Builds a fixture that scores 100/100 on repo-understanding, agent-usefulness,
// test-coverage, and publish-readiness, with `.harness/mcp-policy.json`'s
// shell/network/file-write flags controlled by the caller. An optional
// `.claude/settings.json` (read only by `scanMcp()`, never by the
// policy-boolean walk above it) lets a test grant a risk `mcp-policy.json`
// itself has no field for.
function fixture(mcpPolicy: Record<string, unknown>, settingsPermissions?: { allow?: string[]; deny?: string[] }): string {
  const d = mkdtempSync(join(tmpdir(), 'score-mcp-risk-'));
  dirs.push(d);

  writeFileSync(join(d, 'package.json'), JSON.stringify({
    name: 'demo', version: '1.0.0', bin: { demo: './bin.js' }, scripts: { test: 'vitest run' },
  }));

  mkdirSync(join(d, '.harness'), { recursive: true });
  writeFileSync(join(d, '.harness', 'manifest.json'), JSON.stringify({
    schema: 1, generator: 'metaharness@0.4.16',
    meta: { surface: 'default', kernel_version: '1.0.0' },
    hosts: ['claude-code'],
  }));
  writeFileSync(join(d, '.harness', 'witness.json'), JSON.stringify({ signed: true }));
  writeFileSync(join(d, '.harness', 'mcp-policy.json'), JSON.stringify(mcpPolicy));
  writeFileSync(join(d, 'sbom.json'), JSON.stringify({ components: [] }));
  if (settingsPermissions) {
    mkdirSync(join(d, '.claude'), { recursive: true });
    writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: settingsPermissions.allow ?? [], deny: settingsPermissions.deny ?? ['Read(./.env)'] },
    }));
  }

  mkdirSync(join(d, 'src', 'agents'), { recursive: true });
  for (let i = 0; i < 4; i++) writeFileSync(join(d, 'src', 'agents', `a${i}.ts`), '');
  mkdirSync(join(d, '.claude', 'skills'), { recursive: true });
  for (let i = 0; i < 2; i++) writeFileSync(join(d, '.claude', 'skills', `s${i}.md`), '');
  mkdirSync(join(d, '.claude', 'commands'), { recursive: true });
  for (let i = 0; i < 2; i++) writeFileSync(join(d, '.claude', 'commands', `c${i}.md`), '');

  mkdirSync(join(d, '__tests__'), { recursive: true });
  writeFileSync(join(d, '__tests__', 'a.test.ts'), '');
  mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(d, '.github', 'workflows', 'ci.yml'), '');

  return d;
}

describe('buildScorecard grade cap — mcpRisk High must never coexist with Grade A/B', () => {
  it('BUG REPRO (pre-fix scored 97 -> Grade A): unrestricted shell allowed (mcpRisk High) with all other dimensions perfect', () => {
    const d = fixture({ defaultDeny: true, auditLog: true, allowShell: true, allowNetwork: false, allowFileWrite: false });
    const sc = buildScorecard(d);
    const mcp = sc.dimensions.find((x) => x.name === 'MCP safety')!;
    expect(sc.badges.mcpRisk).toBe('High');
    expect(mcp.score).toBe(85); // 40 (default-deny) + 15 (audit) + 0 (shell) + 15 (network gated) + 15 (file-write gated)
    expect(sc.overall).toBe(97); // 0.25*100 + 0.25*100 + 0.2*85 + 0.15*100 + 0.15*100, rounded
    // The bug: overall >= 85 alone used to yield Grade A / exit 0 here.
    expect(sc.grade).toBe('C');
    expect(sc.exitCode).toBe(1);
  });

  it('mcpRisk High from a fully-permissive policy is also capped, even at a near-zero MCP dimension score', () => {
    const d = fixture({ defaultDeny: false, auditLog: false, allowShell: true, allowNetwork: true, allowFileWrite: true });
    const sc = buildScorecard(d);
    expect(sc.badges.mcpRisk).toBe('High');
    expect(sc.grade).toBe('C');
    expect(sc.exitCode).toBe(1);
  });

  it('regression: mcpRisk Low (fully safe policy) is unaffected — still grades on the weighted composite alone', () => {
    const d = fixture({ defaultDeny: true, auditLog: true, allowShell: false, allowNetwork: false, allowFileWrite: false });
    const sc = buildScorecard(d);
    expect(sc.badges.mcpRisk).toBe('Low');
    const mcp = sc.dimensions.find((x) => x.name === 'MCP safety')!;
    expect(mcp.score).toBe(100);
    expect(sc.overall).toBe(100);
    expect(sc.grade).toBe('A');
    expect(sc.exitCode).toBe(0);
  });

  it('regression: mcpRisk Medium (network allowed, shell/default-deny safe) is NOT capped by this fix', () => {
    const d = fixture({ defaultDeny: true, auditLog: true, allowShell: false, allowNetwork: true, allowFileWrite: false });
    const sc = buildScorecard(d);
    expect(sc.badges.mcpRisk).toBe('Medium');
    // overall = 0.25*100+0.25*100+0.2*85+0.15*100+0.15*100 = 97, uncapped for Medium
    expect(sc.overall).toBe(97);
    expect(sc.grade).toBe('A');
    expect(sc.exitCode).toBe(0);
  });
});

describe('scoreMcpSafety sees .claude/settings.json risks the policy file cannot express (2026-11-13)', () => {
  it('BUG REPRO (pre-fix: Grade A despite a wildcard tool permission): safe mcp-policy.json + mcp__*__* in settings.json', () => {
    const d = fixture(
      { defaultDeny: true, auditLog: true, allowShell: false, allowNetwork: false, allowFileWrite: false },
      { allow: ['mcp__*__*'] },
    );
    const sc = buildScorecard(d);
    // The policy file alone says everything is gated — but settings.json grants every tool on every
    // MCP server, a HIGH finding (`wildcard-tool-perm`) scanMcp() already detects. mcpRisk must not
    // stay 'Low', and the existing 09-20 grade cap must therefore fire.
    expect(sc.badges.mcpRisk).toBe('High');
    expect(sc.grade).toBe('C');
    expect(sc.exitCode).toBe(1);
  });

  it('BUG REPRO (pre-fix: Grade A despite unrestricted Bash): safe mcp-policy.json + Bash(*) in settings.json', () => {
    const d = fixture(
      { defaultDeny: true, auditLog: true, allowShell: false, allowNetwork: false, allowFileWrite: false },
      { allow: ['Bash(*)'] },
    );
    const sc = buildScorecard(d);
    expect(sc.badges.mcpRisk).toBe('High');
    expect(sc.grade).toBe('C');
    expect(sc.exitCode).toBe(1);
  });

  it('BUG REPRO (pre-fix: mcpRisk stayed Low): safe policy + a risky-but-not-wildcard Bash allow-rule escalates to Medium', () => {
    const d = fixture(
      { defaultDeny: true, auditLog: true, allowShell: false, allowNetwork: false, allowFileWrite: false },
      { allow: ['Bash(curl *)'], deny: ['Read(./.env)'] },
    );
    const sc = buildScorecard(d);
    // `risky-bash-allow` is a MEDIUM scanMcp() finding (narrower than the HIGH `unrestricted-bash-allow`/
    // `wildcard-tool-perm`); mcpRisk escalates Low -> Medium, not capped (the grade cap only fires on
    // High), but the badge itself must stop reading 'Low'.
    expect(sc.badges.mcpRisk).toBe('Medium');
  });

  it('regression: other scanMcp() findings unrelated to settings.json tool/shell grants (e.g. missing timeout/call-budget/secret-guard) do NOT escalate mcpRisk — only wildcard/bash settings.json risks do', () => {
    // No .claude/settings.json at all: scanMcp() will report `no-secret-guard` (deny=[] implicitly) and
    // the policy omits requireApprovalForDangerous/toolTimeoutMs/maxToolCallsPerTurn, so scanMcp()'s
    // OWN worst severity is 'medium' here — but none of that is a settings.json tool/shell permission
    // grant, so scoreMcpSafety() must stay 'Low', exactly as it did before this fix.
    const d = fixture({ defaultDeny: true, auditLog: true, allowShell: false, allowNetwork: false, allowFileWrite: false });
    const sc = buildScorecard(d);
    expect(sc.badges.mcpRisk).toBe('Low');
    const mcp = sc.dimensions.find((x) => x.name === 'MCP safety')!;
    expect(mcp.score).toBe(100);
    expect(sc.grade).toBe('A');
    expect(sc.exitCode).toBe(0);
  });

  it('regression: a safe policy with a safe settings.json (existing default-deny rule) stays Low/Grade A, byte-identical to before this fix', () => {
    const d = fixture(
      { defaultDeny: true, auditLog: true, allowShell: false, allowNetwork: false, allowFileWrite: false },
      { allow: ['mcp__bot__*'], deny: ['Read(./.env)'] },
    );
    const sc = buildScorecard(d);
    expect(sc.badges.mcpRisk).toBe('Low');
    const mcp = sc.dimensions.find((x) => x.name === 'MCP safety')!;
    expect(mcp.score).toBe(100);
    expect(sc.overall).toBe(100);
    expect(sc.grade).toBe('A');
    expect(sc.exitCode).toBe(0);
  });

  it('regression: an already-High policy-level risk (shell allowed) is unaffected by the new settings.json check', () => {
    const d = fixture(
      { defaultDeny: true, auditLog: true, allowShell: true, allowNetwork: false, allowFileWrite: false },
      { allow: ['mcp__bot__*'], deny: ['Read(./.env)'] },
    );
    const sc = buildScorecard(d);
    expect(sc.badges.mcpRisk).toBe('High');
    expect(sc.grade).toBe('C');
    expect(sc.exitCode).toBe(1);
  });
});
