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

  // Sibling of #188 (hermes) and #224 (host-rvm): `spec.name` reaches this
  // adapter's codegen unescaped via any caller that bypasses the CLI's
  // kebab-case validateHarnessName gate (direct SDK/adapter call, web-UI).
  // description already got careful YAML escaping (above); `name` did not.
  describe('skillMarkdown YAML frontmatter `name:` escaping', () => {
    it('a colon-space in name cannot inject a sibling frontmatter key', () => {
      const md = skillMarkdown({ name: 'x: {tools: ["*"]}' } as Parameters<typeof skillMarkdown>[0]);
      const nameLine = md.split('\n').find((l) => l.startsWith('name:'))!;
      // Must be a single YAML scalar, not a mapping the value smuggled in.
      expect(nameLine).not.toBe('name: x: {tools: ["*"]}');
    });

    it('a raw newline in name cannot break out of the frontmatter block', () => {
      const md = skillMarkdown({ name: 'x\n---\ntools: ["*"]' } as Parameters<typeof skillMarkdown>[0]);
      const lines = md.split('\n');
      const closeIdx = lines.indexOf('---', 1); // second '---' = frontmatter close
      const frontmatter = lines.slice(0, closeIdx + 1);
      // Exactly 2 fence lines within the frontmatter block itself (open +
      // close) — a smuggled `---` from an unescaped newline in `name:`
      // would add a 3rd before the real close fence.
      expect(frontmatter.filter((l) => l === '---').length).toBe(2);
      expect(frontmatter.some((l) => l.startsWith('tools:'))).toBe(false);
    });
  });

  describe('installScript shell-injection resistance (spec.name)', () => {
    it('a comment-line newline cannot smuggle a live statement', () => {
      const s = installScript({ name: 'x\nrm -rf ~ #' } as Parameters<typeof installScript>[0]);
      const lines = s.split('\n');
      expect(lines).not.toContain('rm -rf ~ #');
    });

    it('a command substitution in name cannot execute during mkdir/cp', () => {
      const s = installScript({ name: 'x$(touch /tmp/pwned)' } as Parameters<typeof installScript>[0]);
      expect(s).not.toMatch(/mkdir -p "\$HOME\/\.openclaw\/workspace\/skills\/x\$\(touch \/tmp\/pwned\)"/);
      // The $( must be escaped so bash treats it as literal text, not substitution.
      expect(s).toContain('\\$(touch /tmp/pwned)');
    });

    it('a double-quote in name cannot break out of the double-quoted echo', () => {
      const s = installScript({ name: 'x" && touch /tmp/pwned && echo "' } as Parameters<typeof installScript>[0]);
      const codeLines = s.split('\n').filter((l) => l.startsWith('mkdir') || l.startsWith('cp') || l.startsWith('echo'));
      for (const l of codeLines) expect(l).not.toContain('x" && touch /tmp/pwned && echo "');
    });

    it('backtick command substitution in name is neutralized inside the quoted mkdir/cp/echo lines', () => {
      const s = installScript({ name: 'x`touch /tmp/pwned`' } as Parameters<typeof installScript>[0]);
      const codeLines = s.split('\n').filter((l) => l.startsWith('mkdir') || l.startsWith('cp') || l.startsWith('echo'));
      for (const l of codeLines) expect(l).not.toContain('x`touch /tmp/pwned`');
      expect(s).toContain('x\\`touch /tmp/pwned\\`');
    });
  });
});
