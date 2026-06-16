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

  // ADR-046 — verified against real opencode 1.17.7: tagged-union entries,
  // `command` is the full array, `environment` (not `env`), `enabled` required.
  it('serverToOpencode emits a local entry with full command array', () => {
    const out = serverToOpencode(baseSpec.mcpServers[0]!);
    expect(out.type).toBe('local');
    expect(out.command).toEqual(['node', './dist/mcp-server.js']);
    expect(out.enabled).toBe(true);
    expect(out.environment).toEqual({ LOG_LEVEL: 'info' });
  });

  it('serverToOpencode emits a remote entry for url servers', () => {
    const out = serverToOpencode(baseSpec.mcpServers[1]!);
    expect(out.type).toBe('remote');
    expect(out.url).toBe('https://example.com/mcp');
    expect(out.enabled).toBe(true);
    expect(out.command).toBeUndefined();
  });

  it('opencodeJson is valid JSON with $schema + direct mcp map + top-level permission', () => {
    const raw = opencodeJson(baseSpec as any);
    let parsed: any;
    expect(() => { parsed = JSON.parse(raw); }).not.toThrow();
    expect(parsed.$schema).toBe('https://opencode.ai/schema/opencode.json');
    expect(parsed.mcp).toBeDefined();
    expect(parsed.mcp.servers).toBeUndefined(); // NO servers wrapper (real schema)
    expect(parsed.mcp.permissions).toBeUndefined(); // NO mcp.permissions (real schema)
    expect(parsed.permission).toBeDefined(); // top-level, singular
  });

  it('opencodeJson maps servers as a direct name→entry map + permission posture', () => {
    const parsed = JSON.parse(opencodeJson(baseSpec as any));
    expect(parsed.mcp.codeindex.type).toBe('local');
    expect(parsed.mcp.remote.type).toBe('remote');
    // Dangerous bash patterns become deny decisions in opencode's permission map.
    expect(parsed.permission.bash['rm *']).toBe('deny');
    expect(parsed.permission.bash['git push *']).toBe('deny');
  });

  it('opencodeJson handles missing policy (sane permission defaults)', () => {
    const noPolicy = { name: 'no-policy', mcpServers: baseSpec.mcpServers };
    const parsed = JSON.parse(opencodeJson(noPolicy as any));
    expect(parsed.permission.bash['*']).toBe('ask');
    expect(parsed.permission.edit).toBe('ask');
  });

  it('opencodeJson handles empty server list cleanly', () => {
    const parsed = JSON.parse(opencodeJson({ name: 'empty', mcpServers: [] } as any));
    expect(parsed.mcp).toEqual({});
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

  // ADR-046 — permission posture derived from the kernel `spec.permissions`.
  it('Bash(*) in allow opens the bash wildcard to "allow"', () => {
    const spec = { name: 'perms', mcpServers: [], permissions: { allow: ['Bash(*)'], deny: ['Bash(rm:*)'] } };
    const parsed = JSON.parse(opencodeJson(spec as any));
    expect(parsed.permission.bash['*']).toBe('allow');
    expect(parsed.permission.bash['rm *']).toBe('deny');
  });

  it('denying file writes gates edit to "deny"', () => {
    const spec = { name: 'ro', mcpServers: [], permissions: { allow: [], deny: ['Write(*)', 'Edit(*)'] } };
    const parsed = JSON.parse(opencodeJson(spec as any));
    expect(parsed.permission.edit).toBe('deny');
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

  it('every emitted server entry is a valid local/remote tagged union (schema gate)', () => {
    const parsed = JSON.parse(opencodeJson(baseSpec as any));
    for (const [name, srv] of Object.entries(parsed.mcp as Record<string, any>)) {
      expect(name).toMatch(/^[\w-]+$/);
      expect(srv.type === 'local' || srv.type === 'remote').toBe(true);
      expect(srv.enabled).toBe(true);
      expect(srv.type === 'local' ? Array.isArray(srv.command) : typeof srv.url === 'string').toBe(true);
    }
  });
});
