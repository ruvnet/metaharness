import { describe, expect, it } from 'vitest';
import { buildScaffold } from '../scaffold';
import { DEFAULT_PRIMITIVES, SAFE_MCP_POLICY } from '../types';
import type { HarnessConfig } from '../types';

function cfg(over: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    name: 'acme-bot',
    description: 'demo',
    hosts: ['claude-code'],
    template: 'vertical:coding',
    memory: 'agentdb',
    routing: '3-tier',
    marketplace: 'powered-by',
    agents: [],
    skills: [],
    commands: [],
    primitives: DEFAULT_PRIMITIVES,
    mcpPolicy: SAFE_MCP_POLICY,
    ...over,
  };
}

const paths = (c: HarnessConfig) => buildScaffold(c).map((f) => f.path);
const file = (c: HarnessConfig, p: string) => buildScaffold(c).find((f) => f.path === p);

describe('MCP primitive — local', () => {
  it('emits the full src/mcp surface', () => {
    const p = paths(cfg({ primitives: { ...DEFAULT_PRIMITIVES, mcp: 'local' } }));
    for (const f of [
      'src/mcp/server.ts',
      'src/mcp/tools.ts',
      'src/mcp/resources.ts',
      'src/mcp/prompts.ts',
      'src/mcp/policy.ts',
      'src/mcp/audit.ts',
      '.harness/mcp-policy.json',
      '.harness/mcp-capabilities.json',
    ]) {
      expect(p).toContain(f);
    }
    // No remote-only auth file in local mode.
    expect(p).not.toContain('src/mcp/auth.ts');
  });

  it('policy json carries the safe defaults', () => {
    const f = file(cfg(), '.harness/mcp-policy.json')!;
    const policy = JSON.parse(f.content);
    expect(policy.defaultDeny).toBe(true);
    expect(policy.allowNetwork).toBe(false);
    expect(policy.allowShell).toBe(false);
    expect(policy.allowFileWrite).toBe(false);
    expect(policy.auditLog).toBe(true);
    expect(policy.toolTimeoutMs).toBe(30000);
    expect(policy.maxToolCallsPerTurn).toBe(8);
  });

  it('claude settings register the stdio MCP server', () => {
    const f = file(cfg(), '.claude/settings.json')!;
    const s = JSON.parse(f.content);
    expect(s.mcpServers['acme-bot'].command).toBe('npx');
    expect(s.permissions.allow).toContain('mcp__acme-bot__*');
  });
});

describe('MCP primitive — remote', () => {
  it('adds auth.ts and an http transport', () => {
    const c = cfg({ primitives: { ...DEFAULT_PRIMITIVES, mcp: 'remote' } });
    expect(paths(c)).toContain('src/mcp/auth.ts');
    const settings = JSON.parse(file(c, '.claude/settings.json')!.content);
    expect(settings.mcpServers['acme-bot'].type).toBe('http');
    const codex = file({ ...c, hosts: ['codex'] }, '.codex/config.toml')!;
    expect(codex.content).toContain('type = "http"');
  });
});

describe('MCP primitive — off', () => {
  it('emits no MCP surface and no mcpServers', () => {
    const c = cfg({ primitives: { ...DEFAULT_PRIMITIVES, mcp: 'off' } });
    const p = paths(c);
    expect(p.some((x) => x.startsWith('src/mcp/'))).toBe(false);
    expect(p).not.toContain('.harness/mcp-policy.json');
    const settings = JSON.parse(file(c, '.claude/settings.json')!.content);
    expect(settings.mcpServers).toBeUndefined();
    expect(settings.permissions.allow).not.toContain('mcp__acme-bot__*');
    // manifest records the disabled state.
    const manifest = JSON.parse(file(c, '.harness/manifest.json')!.content);
    expect(manifest.primitives.mcp).toBe('off');
    expect(manifest.mcpPolicy).toBeNull();
  });
});
