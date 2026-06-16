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
    expect(parsed.dependencies['@metaharness/kernel']).toBeDefined();
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

  // ADR-044 — web-UI parity with the host-adapter capability fixes.
  describe('ADR-044 host parity', () => {
    const fileFor = (cfg: HarnessConfig, path: string) =>
      buildScaffold(cfg).find((f) => f.path === path)?.content ?? '';

    it('github-actions workflow env is provider-agnostic (was ANTHROPIC-only)', () => {
      const yml = fileFor({ ...base, hosts: ['github-actions'] }, '.github/workflows/legal-redline.yml');
      expect(yml).toContain('ANTHROPIC_API_KEY:');
      expect(yml).toContain('OPENROUTER_API_KEY:');
      expect(yml).toContain('OPENAI_API_KEY:');
    });

    it('opencode uses the verified real schema (ADR-046): mcp map + top-level permission', () => {
      const json = JSON.parse(fileFor({ ...base, hosts: ['opencode'] }, '.opencode/opencode.json'));
      // mcp is a direct name→{type,command[],enabled} map; no servers/permissions under mcp.
      expect(json.mcp['legal-redline'].type).toBe('local');
      expect(json.mcp['legal-redline'].enabled).toBe(true);
      expect(json.permission.bash['rm *']).toBe('deny');
      expect(json.permission.edit).toBe('ask'); // SAFE_MCP_POLICY: no file writes
    });

    it('rvm emits a capability table (was absent in the web UI)', () => {
      const paths2 = paths({ ...base, hosts: ['rvm'] });
      expect(paths2).toContain('capability-table.json');
      const caps = JSON.parse(fileFor({ ...base, hosts: ['rvm'] }, 'capability-table.json'));
      expect(Array.isArray(caps)).toBe(true);
      expect(caps[0]?.rights).toContain('EXECUTE'); // mcp__name__* → EXECUTE
    });

    it('openclaw carries the permission posture', () => {
      const json = JSON.parse(fileFor({ ...base, hosts: ['openclaw'] }, '.openclaw/openclaw.json'));
      expect(json.permissions.deny).toContain('Read(./.env)');
      expect(json.mcp_servers).toBeDefined();
    });

    it('codex emits AGENTS.md and copilot emits copilot-instructions.md', () => {
      expect(paths({ ...base, hosts: ['codex'] })).toContain('AGENTS.md');
      expect(paths({ ...base, hosts: ['copilot'] })).toContain('.github/copilot-instructions.md');
    });

    it('allowShell policy opens opencode bash wildcard to "allow"', () => {
      const json = JSON.parse(fileFor(
        { ...base, hosts: ['opencode'], mcpPolicy: { ...SAFE_MCP_POLICY, allowShell: true } },
        '.opencode/opencode.json',
      ));
      expect(json.permission.bash['*']).toBe('allow');
    });
  });
});
