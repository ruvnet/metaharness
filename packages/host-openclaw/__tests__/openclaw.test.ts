// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { serverToOpenClaw, configJson, skillMarkdown, installScript, adapter, HOST_NAME } from '../src/index.js';

describe('@metaharness/host-openclaw — config generation', () => {
  // ADR-046 — verified against real openclaw 2026.6.8: entries carry `enabled`.
  describe('serverToOpenClaw', () => {
    it('converts stdio command form with enabled flag', () => {
      const e = serverToOpenClaw({ name: 'demo', command: ['npx', '-y', 'demo'] });
      expect(e.enabled).toBe(true);
      expect(e.command).toBe('npx');
      expect(e.args).toEqual(['-y', 'demo']);
      expect(e.url).toBeUndefined();
    });

    it('converts url form', () => {
      const e = serverToOpenClaw({ name: 'remote', url: 'https://example.com/mcp' });
      expect(e.enabled).toBe(true);
      expect(e.url).toBe('https://example.com/mcp');
      expect(e.command).toBeUndefined();
    });

    it('includes env when present', () => {
      const e = serverToOpenClaw({ name: 'x', command: ['demo'], env: [['FOO', 'bar']] });
      expect(e.env).toEqual({ FOO: 'bar' });
    });
  });

  describe('configJson', () => {
    // ADR-046: real openclaw nests MCP under `mcp.servers`, NOT top-level `mcp_servers`.
    it('nests servers under mcp.servers (verified real schema)', () => {
      const parsed = JSON.parse(configJson({
        name: 'h',
        mcpServers: [
          { name: 'a', command: ['x'] },
          { name: 'b', url: 'https://y' },
        ],
      }));
      expect(parsed.mcp_servers).toBeUndefined();
      expect(parsed.mcp.servers.a.enabled).toBe(true);
      expect(parsed.mcp.servers.b.enabled).toBe(true);
    });

    it('is valid JSON', () => {
      expect(() => JSON.parse(configJson({ name: 'h' }))).not.toThrow();
    });

    it('always ends with a newline (POSIX file)', () => {
      expect(configJson({ name: 'h' }).endsWith('\n')).toBe(true);
    });

    // ADR-046: openclaw has no top-level allow/deny permissions concept.
    it('does not emit a top-level permissions block (not in openclaw schema)', () => {
      const parsed = JSON.parse(configJson({
        name: 'h',
        permissions: { allow: ['mcp__mem__*'], deny: ['Read(./.env*)'] },
      } as any));
      expect(parsed.permissions).toBeUndefined();
      expect(parsed.mcp).toBeDefined();
    });
  });

  describe('skillMarkdown', () => {
    it('emits YAML frontmatter + markdown', () => {
      const md = skillMarkdown({
        name: 'my-bot',
        description: 'My description',
        systemPrompt: 'You are helpful',
      });
      expect(md).toMatch(/^---/);
      expect(md).toMatch(/name: my-bot/);
      expect(md).toMatch(/description: "My description"/);
      expect(md).toMatch(/# my-bot/);
      expect(md).toMatch(/You are helpful/);
    });

    it('escapes quotes in description (YAML-safe)', () => {
      const md = skillMarkdown({
        name: 'x',
        description: 'has "quotes"',
      });
      expect(md).toMatch(/description: "has \\"quotes\\""/);
    });

    it('lists agents when present', () => {
      const md = skillMarkdown({
        name: 'x',
        agents: [
          { name: 'coder', systemPrompt: 'You code.' },
          { name: 'tester', systemPrompt: 'You test.' },
        ],
      });
      expect(md).toMatch(/## Agents/);
      expect(md).toMatch(/\*\*coder\*\*/);
      expect(md).toMatch(/\*\*tester\*\*/);
    });
  });

  describe('installScript', () => {
    it('contains the onboard + install-daemon command', () => {
      const s = installScript({ name: 'my-bot' });
      expect(s).toMatch(/openclaw onboard --install-daemon/);
    });

    it('drops the skill in ~/.openclaw/workspace/skills/<name>/', () => {
      const s = installScript({ name: 'my-bot' });
      expect(s).toMatch(/\$HOME\/\.openclaw\/workspace\/skills\/my-bot/);
    });

    it('starts with the shebang', () => {
      expect(installScript({ name: 'x' }).startsWith('#!/usr/bin/env bash')).toBe(true);
    });
  });

  describe('adapter export', () => {
    it('name is openclaw', () => {
      expect(adapter.name).toBe(HOST_NAME);
      expect(adapter.name).toBe('openclaw');
    });

    it('generateConfig returns the 3 expected files', () => {
      const out = adapter.generateConfig({ name: 'x' });
      expect(Object.keys(out).sort()).toEqual([
        'SKILL.md',
        'install-openclaw.sh',
        'openclaw.json',
      ]);
    });
  });

  // CodeQL js/incomplete-sanitization regression (alert #2, fixed iter 138).
  describe('skillMarkdown YAML description escaping', () => {
    it('escapes a backslash so it cannot break the quoted scalar', () => {
      const md = skillMarkdown({ name: 'x', description: 'path C:\\\\temp' } as Parameters<typeof skillMarkdown>[0]);
      // Backslashes must be doubled inside the double-quoted YAML scalar.
      const descLine = md.split('\n').find((l) => l.startsWith('description:'))!;
      expect(descLine).toContain('\\\\');
      expect(descLine.endsWith('"')).toBe(true);
    });

    it('a TRAILING backslash cannot escape the closing quote', () => {
      // Pre-fix, input ending in a single '\' produced  description: "...\\"
      // where the final \" escapes our own quote, breaking the YAML doc.
      const md = skillMarkdown({ name: 'x', description: 'danger\\' } as Parameters<typeof skillMarkdown>[0]);
      const descLine = md.split('\n').find((l) => l.startsWith('description:'))!;
      // Must terminate with an unescaped closing quote: even count of \ before it.
      expect(descLine).toMatch(/description: "danger\\\\"$/);
    });

    it('still escapes embedded double-quotes', () => {
      const md = skillMarkdown({ name: 'x', description: 'say "hi"' } as Parameters<typeof skillMarkdown>[0]);
      const descLine = md.split('\n').find((l) => l.startsWith('description:'))!;
      expect(descLine).toContain('\\"hi\\"');
    });

    it('flattens raw newlines so they cannot break the single-line scalar', () => {
      const md = skillMarkdown({ name: 'x', description: 'line1\nline2' } as Parameters<typeof skillMarkdown>[0]);
      const descLine = md.split('\n').find((l) => l.startsWith('description:'))!;
      expect(descLine).toBe('description: "line1 line2"');
    });
  });
});
