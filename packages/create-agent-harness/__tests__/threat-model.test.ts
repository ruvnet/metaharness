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

  it('BUG REPRO: secretsReachable is false and verdict is "clean" when the only deny rule targets .env.example, not the real .env', async () => {
    // Read(./.env.example) denies only the harmless, commonly-committed
    // template file. A tool with a broad Read(*) allow-rule can still read
    // the real .env/.env.local. Pre-fix, the unanchored /\.env/ substring
    // test in both mcp-scan.ts and (independently, duplicated) threat-model.ts
    // treated this deny entry as sufficient, so secretsReachable came back
    // false and the whole threat model read "clean" for a harness with
    // fully exposed credentials.
    const dir = await makeHarness({
      policy: { defaultDeny: true, auditLog: true, requireApprovalForDangerous: true, toolTimeoutMs: 30000, maxToolCallsPerTurn: 8 },
      allow: ['Read(*)'],
      deny: ['Read(./.env.example)'],
      servers: { bot: { command: 'npx' } },
    });
    const tm = buildThreatModel(dir);
    expect(tm.secretsReachable).toBe(true);
    expect(tm.verdict).toBe('high');
    expect(tm.exitCode).toBe(2);
  });

  it('secretsReachable stays true when .env is only covered by non-Read rules or a .env.*-only glob', async () => {
    const dir = await makeHarness({
      policy: { defaultDeny: true, auditLog: true, requireApprovalForDangerous: true, toolTimeoutMs: 30000, maxToolCallsPerTurn: 8 },
      allow: ['Read(*)'],
      deny: ['Read(./.env.*)', 'Edit(./.env)', 'Bash(cat ./.env)', 'Read(./config/.env)'],
      servers: { bot: { command: 'npx' } },
    });
    const tm = buildThreatModel(dir);
    expect(tm.secretsReachable).toBe(true);
    expect(tm.exitCode).toBe(2);
  });
});

describe('buildThreatModel — allowedTools/deniedTools vs. role-scoped mcp-policy.json (non-claude-code hosts)', () => {
  async function makeRoleScopedHarness(policyExtra: Record<string, unknown> = {}): Promise<string> {
    // No `.claude/settings.json` at all — matches real non-claude-code
    // harnesses (e.g. packages/arc-agi-3-chatgpt), which declare their MCP
    // tool surface only via `.harness/mcp-policy.json`.
    const dir = await mkdtemp(join(tmpdir(), 'threat-model-role-'));
    await mkdir(join(dir, '.harness'), { recursive: true });
    await writeFile(
      join(dir, '.harness', 'mcp-policy.json'),
      JSON.stringify({
        defaultDeny: true,
        auditLog: true,
        allowedTools: {
          actor: ['tool_a', 'tool_b', 'tool_c'],
          boss: ['tool_c', 'tool_d'], // tool_c shared across roles -> dedup to 4 unique
        },
        ...policyExtra,
      }),
      'utf-8',
    );
    return dir;
  }

  it('BUG REPRO (pre-fix would report 0/0): reports null, not a fabricated 0, for a role-scoped-only policy', async () => {
    const dir = await makeRoleScopedHarness();
    const tm = buildThreatModel(dir);
    expect(tm.allowedTools).toBeNull();
    expect(tm.deniedTools).toBeNull();
    expect(tm.roleScopedToolSurface).toEqual({ tools: 4, roles: 2 });
  });

  it('formatThreatModel prints an explicit N/A note (with the real tool/role counts), not "0"', async () => {
    const dir = await makeRoleScopedHarness();
    const tm = buildThreatModel(dir);
    const text = formatThreatModel(tm).join('\n');
    expect(text).toContain('Allowed tools:        N/A — role-scoped mcp-policy.json declares 4 tool(s) across 2 role(s)');
    expect(text).not.toContain('Allowed tools:        0');
    expect(text).not.toContain('Denied tools:         0');
  });

  it('other fields (dangerousPermissions/secretsReachable/verdict/exitCode) are unaffected by the null tool counters', async () => {
    const dir = await makeRoleScopedHarness({ allowNetwork: true, allowFileWrite: true });
    const tm = buildThreatModel(dir);
    expect(tm.networkAccess).toBe(true);
    expect(tm.fileWrite).toBe(true);
    expect(tm.verdict).toBe('medium');
    expect(tm.exitCode).toBe(1);
  });

  it('regression: claude-code harnesses with an explicit permissions block still get real flat counts, never null', async () => {
    const dir = await makeHarness({
      policy: { defaultDeny: true, auditLog: true },
      allow: ['Read(*)', 'Bash(npm test)'],
      deny: ['Read(./.env)'],
      servers: { bot: { command: 'npx' } },
    });
    const tm = buildThreatModel(dir);
    expect(tm.allowedTools).toBe(2);
    expect(tm.deniedTools).toBe(1);
    expect(tm.roleScopedToolSurface).toBeNull();
  });

  it('regression: an EMPTY permissions block ({ allow: [], deny: [] }) still reports a real 0, not N/A — empty-and-declared is a genuine default-deny fact for claude-code', async () => {
    const dir = await makeHarness({ policy: { defaultDeny: true, auditLog: true }, allow: [], deny: [], servers: { bot: { command: 'npx' } } });
    const tm = buildThreatModel(dir);
    expect(tm.allowedTools).toBe(0);
    expect(tm.deniedTools).toBe(0);
    expect(tm.roleScopedToolSurface).toBeNull();
  });

  it('a role-scoped policy with an empty allowedTools map ({}) does not spuriously suppress the real (zero) flat count', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threat-model-role-empty-'));
    await mkdir(join(dir, '.harness'), { recursive: true });
    await writeFile(
      join(dir, '.harness', 'mcp-policy.json'),
      JSON.stringify({ defaultDeny: true, auditLog: true, allowedTools: {} }),
      'utf-8',
    );
    const tm = buildThreatModel(dir);
    // No settings.json permissions block, and allowedTools has no real
    // tools in it either -> nothing to report either way, but it must be
    // the genuine flat-count path (0), not a fabricated role-scoped note.
    expect(tm.allowedTools).toBe(0);
    expect(tm.deniedTools).toBe(0);
    expect(tm.roleScopedToolSurface).toBeNull();
  });
});
