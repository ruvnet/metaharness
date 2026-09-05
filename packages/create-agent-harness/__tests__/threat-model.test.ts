// SPDX-License-Identifier: MIT
//
// Regression tests for `harness threat-model` — first dedicated suite for this
// command (previously untested). Covers the mcpInUse/scanMcp detection-surface
// consistency bug: threat-model.ts computed "is MCP in use" from only
// `.harness/mcp-policy.json` and `.mcp.json`, missing `.claude/settings.json`'s
// `mcpServers` key — even though it calls scanMcp() internally, which DOES
// check that key. A harness registering MCP only via `.claude/settings.json`
// would get `mcpInUse: false` and formatThreatModel would early-return "mcp
// surface: off / threat surface: none", silently discarding the real findings
// scanMcp() had already computed.

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildThreatModel, formatThreatModel } from '../src/threat-model.js';
import { scanMcp } from '../src/mcp-scan.js';

async function makeHarness(opts: {
  policy?: Record<string, unknown> | null;
  mcpJson?: Record<string, unknown> | null;
  allow?: string[];
  deny?: string[];
  servers?: Record<string, unknown> | null;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'threat-model-'));
  await mkdir(join(dir, '.harness'), { recursive: true });
  await mkdir(join(dir, '.claude'), { recursive: true });
  if (opts.policy) {
    await writeFile(join(dir, '.harness', 'mcp-policy.json'), JSON.stringify(opts.policy), 'utf-8');
  }
  if (opts.mcpJson) {
    await writeFile(join(dir, '.mcp.json'), JSON.stringify(opts.mcpJson), 'utf-8');
  }
  const settings: Record<string, unknown> = {
    permissions: { allow: opts.allow ?? [], deny: opts.deny ?? ['Read(./.env)'] },
  };
  if (opts.servers) settings.mcpServers = opts.servers;
  await writeFile(join(dir, '.claude', 'settings.json'), JSON.stringify(settings), 'utf-8');
  return dir;
}

describe('buildThreatModel — mcpInUse / scanMcp detection-surface consistency', () => {
  it('BUG REPRO: MCP registered only via .claude/settings.json.mcpServers is detected as in-use (not "off")', async () => {
    // No .harness/mcp-policy.json, no .mcp.json — the two things the old
    // mcpInUse check looked at. Only mcpServers, which scanMcp() already
    // checks (and which threat-model.ts did not, pre-fix).
    const dir = await makeHarness({ policy: null, mcpJson: null, servers: { bot: { command: 'npx' } } });
    const tm = buildThreatModel(dir);
    expect(tm.mcpInUse).toBe(true);
    // scanMcp is called with no policy file present -> 'no-policy' HIGH finding,
    // and it must now actually reach tm.findings/tm.worst instead of being
    // discarded by formatThreatModel's early "mcp is off" return.
    expect(tm.findings.some((f) => f.id === 'no-policy')).toBe(true);
    expect(tm.worst).toBe('high');
    // NOTE (disclosed, not fixed tonight): tm.verdict/tm.exitCode are derived
    // from a separate boolean grid (shellAccess/policyDefaultDeny/secretsReachable/
    // networkAccess/fileWrite/auditLog) that does not itself consider
    // tm.worst/tm.findings severity, so a HIGH scanMcp finding like
    // 'no-policy' can coexist with verdict:'clean' here. That is a real,
    // narrower, separate gap from tonight's mcpInUse/scanMcp consistency fix
    // — see the PR/gist for why it's out of scope for this diff.
    expect(tm.verdict).toBe('clean');
    expect(tm.exitCode).toBe(0);
  });

  it('BUG REPRO: formatThreatModel does not early-return "off" when only mcpServers is registered', async () => {
    const dir = await makeHarness({ policy: null, mcpJson: null, servers: { bot: { command: 'npx' } } });
    const tm = buildThreatModel(dir);
    const lines = formatThreatModel(tm);
    expect(lines.join('\n')).not.toContain('mcp surface:         off');
    expect(lines.join('\n')).not.toContain('threat surface:      none');
    expect(lines.some((l) => l.includes('no-policy'))).toBe(true);
  });

  it('regression: .mcp.json alone (no policy, no mcpServers) still marks MCP in-use', async () => {
    // Caught by an independent adversarial critic pass: an earlier version of
    // this fix replaced mcpInUse with scanMcp()'s mcpEnabled wholesale, but
    // scanMcp() itself did not check .mcp.json — silently reintroducing the
    // exact class of false-negative this fix set out to close, just for a
    // different config surface. .mcp.json is a primary, actively-referenced
    // MCP signal elsewhere in this codebase (score.ts's hasMcp, eject.ts,
    // analyze-repo.ts), so this must stay true with explicit, non-tautological
    // expected values (not just "equals scanMcp's own answer").
    const dir = await makeHarness({ policy: null, mcpJson: { servers: { bot: { command: 'npx' } } }, servers: null });
    const tm = buildThreatModel(dir);
    expect(tm.mcpInUse).toBe(true);
    const scan = scanMcp(dir);
    expect(scan.mcpEnabled).toBe(true);
  });

  it('mcpInUse tracks scanMcp\'s own mcpEnabled exactly (single source of truth), each surface independently', async () => {
    const cases: Array<{ c: Parameters<typeof makeHarness>[0]; expected: boolean }> = [
      { c: { policy: null, mcpJson: null, servers: { bot: { command: 'npx' } } }, expected: true },
      { c: { policy: { defaultDeny: true }, mcpJson: null, servers: null }, expected: true },
      { c: { policy: null, mcpJson: { servers: {} }, servers: null }, expected: true },
      { c: { policy: null, mcpJson: null, servers: {} }, expected: false },
      { c: { policy: null, mcpJson: null, servers: null }, expected: false },
    ];
    for (const { c, expected } of cases) {
      const dir = await makeHarness(c);
      const tm = buildThreatModel(dir);
      const scan = scanMcp(dir);
      expect(tm.mcpInUse).toBe(expected);
      expect(tm.mcpInUse).toBe(scan.mcpEnabled);
    }
  });

  it('regression: .harness/mcp-policy.json alone still marks MCP in-use', async () => {
    const dir = await makeHarness({ policy: { defaultDeny: true, auditLog: true }, mcpJson: null, servers: null });
    const tm = buildThreatModel(dir);
    expect(tm.mcpInUse).toBe(true);
  });

  it('regression: no policy, no .mcp.json, no mcpServers stays "off" / clean', async () => {
    const dir = await makeHarness({ policy: null, mcpJson: null, servers: null });
    const tm = buildThreatModel(dir);
    expect(tm.mcpInUse).toBe(false);
    expect(tm.verdict).toBe('clean');
    expect(tm.exitCode).toBe(0);
    const lines = formatThreatModel(tm);
    expect(lines.join('\n')).toContain('threat surface:      none — MCP is not in use');
  });

  it('regression: empty mcpServers object ({}) is treated as not-in-use (matches scanMcp)', async () => {
    const dir = await makeHarness({ policy: null, mcpJson: null, servers: {} });
    const tm = buildThreatModel(dir);
    expect(tm.mcpInUse).toBe(false);
  });

  it('duplicate/conflicting registration across all 3 surfaces: mcpInUse stays true and scanMcp\'s findings pass through unfiltered — no surface\'s presence masks another\'s', async () => {
    // Same conflicting fixture as mcp-scan.test.ts's "duplicate/conflicting
    // registration" case: a compliant policy file coexists with a risky
    // unrestricted 'Bash(*)' settings allow-rule, plus a redundant .mcp.json.
    // There's no precedence to pick a "winning" surface (see mcp-scan.ts) —
    // threat-model.ts must surface the real finding either way.
    const dir = await makeHarness({
      policy: { defaultDeny: true, auditLog: true, requireApprovalForDangerous: true, toolTimeoutMs: 30000, maxToolCallsPerTurn: 8 },
      mcpJson: { servers: { other: { command: 'npx' } } },
      allow: ['Bash(*)'],
      deny: [],
      servers: { bot: { command: 'npx' } },
    });
    const tm = buildThreatModel(dir);
    const scan = scanMcp(dir);
    expect(tm.mcpInUse).toBe(true);
    expect(tm.mcpInUse).toBe(scan.mcpEnabled);
    expect(tm.findings.some((f) => f.id === 'unrestricted-bash-allow')).toBe(true);
    expect(tm.findings.some((f) => f.id === 'no-policy')).toBe(false);
    expect(tm.worst).toBe('high');
  });
});
