// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { tomlEscape, serverToToml, configToml, mcpAddCommands, agentsMarkdown, adapter } from '../src/index.js';

describe('@metaharness/host-codex — TOML generation', () => {
  describe('tomlEscape', () => {
    it('escapes backslash, quote, newline, return, tab', () => {
      expect(tomlEscape('a\\b')).toBe('a\\\\b');
      expect(tomlEscape('a"b')).toBe('a\\"b');
      expect(tomlEscape('a\nb')).toBe('a\\nb');
      expect(tomlEscape('a\rb')).toBe('a\\rb');
      expect(tomlEscape('a\tb')).toBe('a\\tb');
    });

    it('passes ordinary strings through unchanged', () => {
      expect(tomlEscape('demo-server')).toBe('demo-server');
    });
  });

  describe('serverToToml', () => {
    it('renders a stdio server with command + args', () => {
      const s = serverToToml({
        name: 'demo',
        command: ['npx', '-y', 'demo'],
      });
      expect(s).toContain('[mcp_servers.demo]');
      expect(s).toContain('command = "npx"');
      expect(s).toContain('args = ["-y", "demo"]');
    });

    it('renders a url-based server', () => {
      const s = serverToToml({
        name: 'remote',
        url: 'https://example.com/mcp',
      });
      expect(s).toContain('[mcp_servers.remote]');
      expect(s).toContain('url = "https://example.com/mcp"');
    });

    it('renders env table when env is non-empty', () => {
      const s = serverToToml({
        name: 'x',
        command: ['demo'],
        env: [['FOO', 'bar']],
      });
      expect(s).toContain('[mcp_servers.x.env]');
      expect(s).toContain('FOO = "bar"');
    });
  });

  describe('configToml', () => {
    it('joins multiple servers with a blank line between', () => {
      const out = configToml({
        name: 'h',
        mcpServers: [
          { name: 'a', command: ['x'] },
          { name: 'b', command: ['y'] },
        ],
      });
      expect(out).toContain('[mcp_servers.a]');
      expect(out).toContain('[mcp_servers.b]');
      expect(out.endsWith('\n')).toBe(true);
    });
  });

  describe('mcpAddCommands', () => {
    it('emits the stdio invocation', () => {
      const cmds = mcpAddCommands({
        name: 'h',
        mcpServers: [{ name: 'demo', command: ['npx', '-y', 'demo'] }],
      });
      expect(cmds[0]).toContain('codex mcp add demo -- npx -y demo');
    });

    it('emits the url invocation', () => {
      const cmds = mcpAddCommands({
        name: 'h',
        mcpServers: [{ name: 'remote', url: 'https://x' }],
      });
      expect(cmds[0]).toContain('codex mcp add remote --url https://x');
    });
  });

  // ADR-044 — AGENTS.md emission (systemPrompt + agents were dropped).
  describe('agentsMarkdown (ADR-044)', () => {
    it('carries name, description, system prompt, and agents', () => {
      const md = agentsMarkdown({
        name: 'demo', description: 'A demo.', systemPrompt: 'Be terse.',
        agents: [{ name: 'reviewer', systemPrompt: 'Review code.' }],
      } as any);
      expect(md).toContain('# demo');
      expect(md).toContain('A demo.');
      expect(md).toContain('Be terse.');
      expect(md).toContain('### reviewer');
      expect(md).toContain('Review code.');
    });

    it('generateConfig emits AGENTS.md when a system prompt is present', () => {
      const out = adapter.generateConfig!({ name: 'demo', systemPrompt: 'You are demo.' } as any);
      expect(Object.keys(out)).toContain('AGENTS.md');
      expect(out['AGENTS.md']).toContain('You are demo.');
    });

    it('generateConfig omits AGENTS.md for a bare spec', () => {
      const out = adapter.generateConfig!({ name: 'bare', mcpServers: [] } as any);
      expect(Object.keys(out)).not.toContain('AGENTS.md');
    });
  });
});
