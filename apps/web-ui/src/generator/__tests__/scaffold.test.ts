import { describe, expect, it } from 'vitest';
import { buildScaffold } from '../scaffold';
import { totalBytes } from '../zip';
import { DEFAULT_PRIMITIVES, SAFE_MCP_POLICY } from '../types';
import type { HarnessConfig } from '../types';

const base: HarnessConfig = {
  name: 'legal-redline',
  description: 'Redline contracts fast',
  hosts: ['claude-code'],
  template: 'vertical:devops',
  memory: 'agentdb',
  routing: '3-tier',
  marketplace: 'powered-by',
  agents: ['responder', 'escalator'],
  skills: ['memory-inspect'],
  commands: ['doctor'],
  primitives: DEFAULT_PRIMITIVES,
  mcpPolicy: SAFE_MCP_POLICY,
};

function paths(cfg: HarnessConfig) {
  return buildScaffold(cfg).map((f) => f.path);
}

describe('buildScaffold', () => {
  it('emits the core files', () => {
    const p = paths(base);
    for (const f of ['package.json', 'README.md', 'CLAUDE.md', 'src/init.ts', '.gitignore', 'LICENSE']) {
      expect(p).toContain(f);
    }
  });

  it('emits one ts file per selected agent plus an index', () => {
    const p = paths(base);
    expect(p).toContain('src/agents/responder.ts');
    expect(p).toContain('src/agents/escalator.ts');
    expect(p).toContain('src/agents/index.ts');
    expect(p).not.toContain('src/agents/postmortem.ts');
  });

  it('emits Claude-ready skills and commands', () => {
    const p = paths(base);
    expect(p).toContain('.claude/skills/memory-inspect/SKILL.md');
    expect(p).toContain('.claude/commands/doctor.md');
  });

  it('wires the chosen host adapter', () => {
    expect(paths(base)).toContain('.claude/settings.json');
    expect(paths({ ...base, hosts: ['codex'] })).toContain('.codex/config.toml');
    expect(paths({ ...base, hosts: ['pi-dev'] })).toContain('AGENTS.md');
    expect(paths({ ...base, hosts: ['openclaw'] })).toContain('.openclaw/openclaw.json');
    expect(paths({ ...base, hosts: ['rvm'] })).toContain('rvm.manifest.toml');
    expect(paths({ ...base, hosts: ['hermes'] })).toContain('cli-config.yaml');
  });

  it('multi-host emits every adapter', () => {
    const p = paths({ ...base, hosts: ['claude-code', 'codex'] });
    expect(p).toContain('.claude/settings.json');
    expect(p).toContain('.codex/config.toml');
  });

  it('package.json is valid JSON carrying the harness name', () => {
    const pkg = buildScaffold(base).find((f) => f.path === 'package.json')!;
    const parsed = JSON.parse(pkg.content);
    expect(parsed.name).toBe('legal-redline');
    expect(parsed.bin['legal-redline']).toBeDefined();
    expect(parsed.dependencies['@ruflo/kernel']).toBeDefined();
  });

  it('settings.json is valid JSON with scoped permissions', () => {
    const s = buildScaffold(base).find((f) => f.path === '.claude/settings.json')!;
    const parsed = JSON.parse(s.content);
    expect(parsed.mcpServers['legal-redline']).toBeDefined();
    expect(parsed.permissions.allow).toContain('mcp__legal-redline__*');
  });

  it('renders no unresolved {{vars}} in CLAUDE.md', () => {
    const c = buildScaffold(base).find((f) => f.path === 'CLAUDE.md')!;
    expect(c.content).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it('is deterministic for identical inputs', () => {
    expect(buildScaffold(base)).toEqual(buildScaffold(base));
  });

  it('produces a non-trivial byte size', () => {
    expect(totalBytes(buildScaffold(base))).toBeGreaterThan(1000);
  });
});
