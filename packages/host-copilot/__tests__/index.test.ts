// SPDX-License-Identifier: MIT
//
// iter 127 — @metaharness/host-copilot (ADR-032) tests.
//
// Verifies the 7th host adapter produces VSCode-loadable MCP config and a
// runnable install runbook. Per the host-functional gate (iter 126), we
// assert syntactic + structural compliance with the VSCode 1.99+ schema.

import { describe, it, expect } from 'vitest';
import { serverToVscode, mcpJson, installRunbook, copilotInstructions, adapter, HOST_NAME } from '../src/index.js';

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
};

describe('@metaharness/host-copilot (iter 127, ADR-032)', () => {
  it('HOST_NAME is "copilot"', () => {
    expect(HOST_NAME).toBe('copilot');
    expect(adapter.name).toBe('copilot');
  });

  it('serverToVscode emits command+args for stdio servers', () => {
    const out = serverToVscode(baseSpec.mcpServers[0]!);
    expect(out.command).toBe('node');
    expect(out.args).toEqual(['./dist/mcp-server.js']);
    expect(out.env).toEqual({ LOG_LEVEL: 'info' });
  });

  it('serverToVscode emits url for HTTP streamable servers (no command)', () => {
    const out = serverToVscode(baseSpec.mcpServers[1]!);
    expect(out.url).toBe('https://example.com/mcp');
    expect(out.command).toBeUndefined();
    expect(out.args).toBeUndefined();
  });

  it('mcpJson produces valid JSON with BOTH `servers` + `mcpServers` keys', () => {
    const raw = mcpJson(baseSpec as any);
    // Must parse — this is the gate that proves VSCode would load it.
    let parsed: any;
    expect(() => { parsed = JSON.parse(raw); }).not.toThrow();
    // ADR-032 §4: forward-compat key
    expect(parsed.servers).toBeDefined();
    expect(parsed.servers.codeindex).toBeDefined();
    expect(parsed.servers.remote).toBeDefined();
    // Backward-compat alias for older runtimes
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers.codeindex).toEqual(parsed.servers.codeindex);
  });

  it('mcpJson handles an empty server list cleanly', () => {
    const raw = mcpJson({ name: 'empty', mcpServers: [] } as any);
    const parsed = JSON.parse(raw);
    expect(parsed.servers).toEqual({});
    expect(parsed.mcpServers).toEqual({});
  });

  it('installRunbook is markdown that names the harness + lists every server', () => {
    const md = installRunbook(baseSpec as any);
    expect(md).toContain('# Installing demo into GitHub Copilot');
    expect(md).toContain('VSCode 1.99 or later');
    expect(md).toContain('`codeindex`');
    expect(md).toContain('`remote`');
    expect(md).toContain('workspace trust');
  });

  it('adapter.generateConfig emits both .vscode/mcp.json and install.md', () => {
    const out = adapter.generateConfig!(baseSpec as any);
    const keys = Object.keys(out);
    expect(keys).toContain('.vscode/mcp.json');
    expect(keys).toContain('install.md');
  });

  // ADR-044 — Copilot custom instructions (systemPrompt was dropped).
  it('copilotInstructions carries name + description + system prompt + agents', () => {
    const md = copilotInstructions({
      name: 'demo', description: 'A demo.', systemPrompt: 'Be precise.',
      agents: [{ name: 'reviewer', systemPrompt: 'Review.' }],
    } as any);
    expect(md).toContain('# demo');
    expect(md).toContain('A demo.');
    expect(md).toContain('Be precise.');
    expect(md).toContain('**reviewer**');
  });

  it('generateConfig emits .github/copilot-instructions.md when systemPrompt present', () => {
    const out = adapter.generateConfig!({ name: 'demo', systemPrompt: 'You are demo.' } as any);
    expect(Object.keys(out)).toContain('.github/copilot-instructions.md');
    expect(out['.github/copilot-instructions.md']).toContain('You are demo.');
  });

  it('generateConfig omits copilot-instructions.md for a bare MCP-only spec', () => {
    const out = adapter.generateConfig!({ name: 'bare', mcpServers: [] } as any);
    expect(Object.keys(out)).not.toContain('.github/copilot-instructions.md');
  });

  it('emitted mcp.json is byte-deterministic for the same spec (witness-stable)', () => {
    const a = mcpJson(baseSpec as any);
    const b = mcpJson(baseSpec as any);
    expect(a).toBe(b);
  });

  it('emitted mcp.json server entries reject malformed shapes', () => {
    const raw = mcpJson(baseSpec as any);
    const parsed = JSON.parse(raw);
    for (const [name, srv] of Object.entries(parsed.servers as Record<string, any>)) {
      // VSCode schema requires either command OR url. Test catches a
      // future bug where the adapter emits a server with neither.
      expect(name).toMatch(/^[\w-]+$/);
      const hasCommand = 'command' in srv;
      const hasUrl = 'url' in srv;
      expect(hasCommand || hasUrl).toBe(true);
    }
  });
});
