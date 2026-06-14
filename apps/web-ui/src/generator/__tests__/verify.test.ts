import { describe, expect, it } from 'vitest';
import { buildScaffold } from '../scaffold';
import { verifyFileMap } from '../verify';
import { DEFAULT_PRIMITIVES, SAFE_MCP_POLICY } from '../types';
import type { GenFile, HarnessConfig } from '../types';

function cfg(over: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    name: 'acme-bot',
    description: 'demo',
    hosts: ['claude-code'],
    template: 'vertical:coding',
    memory: 'agentdb',
    routing: '3-tier',
    marketplace: 'powered-by',
    agents: ['architect'],
    skills: ['plan-change'],
    commands: ['doctor'],
    primitives: DEFAULT_PRIMITIVES,
    mcpPolicy: SAFE_MCP_POLICY,
    ...over,
  };
}

describe('verifyFileMap', () => {
  it('passes a freshly generated, secure harness', () => {
    const r = verifyFileMap(buildScaffold(cfg()));
    expect(r.ok).toBe(true);
    expect(r.failed).toBe(0);
    expect(r.checks.some((c) => c.id === 'mcp-default-deny' && c.severity === 'pass')).toBe(true);
  });

  it('flags a tampered package.json', () => {
    const files = buildScaffold(cfg());
    const pkg = files.find((f) => f.path === 'package.json')!;
    pkg.content = '{ not valid json';
    const r = verifyFileMap(files);
    expect(r.ok).toBe(false);
    expect(r.checks.some((c) => c.id === 'pkg-json' && c.severity === 'high')).toBe(true);
  });

  it('flags an MCP server whose policy was weakened to allow shell', () => {
    const files: GenFile[] = buildScaffold(cfg());
    const policy = files.find((f) => f.path === '.harness/mcp-policy.json')!;
    policy.content = JSON.stringify({ ...SAFE_MCP_POLICY, allowShell: true, defaultDeny: false });
    const r = verifyFileMap(files);
    expect(r.ok).toBe(false);
    expect(r.checks.some((c) => c.id === 'mcp-shell' && c.severity === 'high')).toBe(true);
    expect(r.checks.some((c) => c.id === 'mcp-default-deny' && c.severity === 'high')).toBe(true);
  });

  it('treats an MCP-off harness as clean (info, not fail)', () => {
    const r = verifyFileMap(buildScaffold(cfg({ primitives: { ...DEFAULT_PRIMITIVES, mcp: 'off' } })));
    expect(r.ok).toBe(true);
    expect(r.checks.some((c) => c.id === 'mcp-off')).toBe(true);
  });
});
