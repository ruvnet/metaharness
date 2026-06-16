// SPDX-License-Identifier: MIT
//
// iter 128 — @metaharness/host-opencode (ADR-036) tests. Mirror of the iter-127
// host-copilot test suite, adapted for OpenCode's $schema-anchored JSON.

import { describe, it, expect } from 'vitest';
import { serverToOpencode, opencodeJson, installRunbook, agentMarkdown, agentsMarkdown, adapter, HOST_NAME } from '../src/index.js';

const baseSpec = {
  name: 'demo',
  mcpServers: [
    {
      name: 'codeindex',
      command: ['node', './dist/mcp-server.js'],
      env: [['LOG_LEVEL', 'info']] as Array<[string, string]>,
    },
    {
      name: 'remote',
      url: 'https://example.com/mcp',
    },
  ],
  mcpPolicy: {
    allow: ['mcp__codeindex__*'],
    deny: ['Bash(rm:*)', 'Bash(git push:*)'],
  },
};

describe('@metaharness/host-opencode (iter 128, ADR-036)', () => {
  it('HOST_NAME is "opencode"', () => {
    expect(HOST_NAME).toBe('opencode');
    expect(adapter.name).toBe('opencode');
  });

  it('serverToOpencode emits command+args for stdio servers', () => {
    const out = serverToOpencode(baseSpec.mcpServers[0]!);
    expect(out.command).toBe('node');
    expect(out.args).toEqual(['./dist/mcp-server.js']);
    expect(out.env).toEqual({ LOG_LEVEL: 'info' });
  });

  it('serverToOpencode emits url for HTTP streamable servers', () => {
    const out = serverToOpencode(baseSpec.mcpServers[1]!);
    expect(out.url).toBe('https://example.com/mcp');
    expect(out.command).toBeUndefined();
  });

  it('opencodeJson is valid JSON with $schema anchor', () => {
    const raw = opencodeJson(baseSpec as any);
    let parsed: any;
    expect(() => { parsed = JSON.parse(raw); }).not.toThrow();
    expect(parsed.$schema).toBe('https://opencode.ai/schema/opencode.json');
    expect(parsed.mcp).toBeDefined();
    expect(parsed.mcp.servers).toBeDefined();
    expect(parsed.mcp.permissions).toBeDefined();
  });

  it('opencodeJson includes both servers + the policy block', () => {
    const parsed = JSON.parse(opencodeJson(baseSpec as any));
    expect(parsed.mcp.servers.codeindex).toBeDefined();
    expect(parsed.mcp.servers.remote).toBeDefined();
    // ADR-036 §Default-deny composition: deny rules from mcp-policy.json
    // land verbatim.
    expect(parsed.mcp.permissions.deny).toContain('Bash(rm:*)');
    expect(parsed.mcp.permissions.deny).toContain('Bash(git push:*)');
    expect(parsed.mcp.permissions.allow).toContain('mcp__codeindex__*');
  });

  it('opencodeJson handles missing mcpPolicy (empty allow/deny arrays)', () => {
    const noPolicy = { name: 'no-policy', mcpServers: baseSpec.mcpServers };
    const parsed = JSON.parse(opencodeJson(noPolicy as any));
    expect(parsed.mcp.permissions.allow).toEqual([]);
    expect(parsed.mcp.permissions.deny).toEqual([]);
  });

  it('opencodeJson handles empty server list cleanly', () => {
    const raw = opencodeJson({ name: 'empty', mcpServers: [] } as any);
    const parsed = JSON.parse(raw);
    expect(parsed.mcp.servers).toEqual({});
  });

  it('installRunbook walks through opencode auth login + lists every server', () => {
    const md = installRunbook(baseSpec as any);
    expect(md).toContain('# Installing demo into OpenCode');
    expect(md).toContain('opencode auth login');
    expect(md).toContain('OpenCode 1.0 or later');
    expect(md).toContain('`codeindex`');
    expect(md).toContain('`remote`');
    expect(md).toContain('deny');
  });

  it('adapter.generateConfig emits both .opencode/opencode.json and install.md', () => {
    const out = adapter.generateConfig!(baseSpec as any);
    expect(Object.keys(out)).toContain('.opencode/opencode.json');
    expect(Object.keys(out)).toContain('install.md');
  });

  it('byte-deterministic for the same spec (witness-stable ADR-011)', () => {
    expect(opencodeJson(baseSpec as any)).toBe(opencodeJson(baseSpec as any));
  });

  // ADR-044 — permissions wired to the kernel `spec.permissions` field.
  it('opencodeJson reads spec.permissions (kernel contract field)', () => {
    const spec = {
      name: 'perms',
      mcpServers: [],
      permissions: { allow: ['mcp__mem__*'], deny: ['Read(./.env*)'] },
    };
    const parsed = JSON.parse(opencodeJson(spec as any));
    expect(parsed.mcp.permissions.allow).toContain('mcp__mem__*');
    expect(parsed.mcp.permissions.deny).toContain('Read(./.env*)');
  });

  it('spec.permissions wins over legacy mcpPolicy when both present', () => {
    const spec = {
      name: 'both',
      mcpServers: [],
      permissions: { allow: ['from-permissions'], deny: [] },
      mcpPolicy: { allow: ['from-mcpPolicy'], deny: [] },
    };
    const parsed = JSON.parse(opencodeJson(spec as any));
    expect(parsed.mcp.permissions.allow).toEqual(['from-permissions']);
  });

  // ADR-044 — agents + system prompt emission.
  it('agentMarkdown emits YAML frontmatter + body, sanitized', () => {
    const md = agentMarkdown({ name: 'reviewer', systemPrompt: 'Review "carefully"\nalways' });
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('mode: subagent');
    expect(md).toContain('\\"carefully\\"'); // quotes escaped in frontmatter
    expect(md).not.toMatch(/description: ".*\n.*"/); // no raw newline in scalar
  });

  it('generateConfig emits .opencode/agents/<name>.md per agent + AGENTS.md', () => {
    const spec = {
      name: 'demo',
      systemPrompt: 'You are demo, a repo-aware agent.',
      mcpServers: [],
      agents: [{ name: 'reviewer', systemPrompt: 'Review code.' }, { name: 'tester', systemPrompt: 'Write tests.' }],
    };
    const out = adapter.generateConfig!(spec as any);
    expect(Object.keys(out)).toContain('.opencode/agents/reviewer.md');
    expect(Object.keys(out)).toContain('.opencode/agents/tester.md');
    expect(Object.keys(out)).toContain('AGENTS.md');
    expect(out['AGENTS.md']).toContain('You are demo, a repo-aware agent.');
  });

  it('agentsMarkdown carries name + description + system prompt', () => {
    const md = agentsMarkdown({ name: 'h', description: 'd', systemPrompt: 'sp' } as any);
    expect(md).toContain('# h');
    expect(md).toContain('d');
    expect(md).toContain('sp');
  });

  it('every emitted server entry has command OR url (schema gate)', () => {
    const parsed = JSON.parse(opencodeJson(baseSpec as any));
    for (const [name, srv] of Object.entries(parsed.mcp.servers as Record<string, any>)) {
      expect(name).toMatch(/^[\w-]+$/);
      expect('command' in srv || 'url' in srv).toBe(true);
    }
  });
});
