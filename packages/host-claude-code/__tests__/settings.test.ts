// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { settingsFor, mcpAddCommands, hookHandlerFor, claudeMd, agentMarkdown, adapter } from '../src/index.js';

describe('@metaharness/host-claude-code', () => {
  describe('settingsFor', () => {
    it('returns hooks-free settings when no hooks declared', () => {
      const s = settingsFor({ name: 'h' });
      expect(s.hooks).toBeUndefined();
    });

    it('emits the hooks block when hooks are declared', () => {
      const s = settingsFor({
        name: 'h',
        hooks: [
          { event: 'PreToolUse', matcher: 'Bash(*)', handler: 'pre-bash' },
        ],
      });
      expect(s.hooks?.PreToolUse).toHaveLength(1);
      expect(s.hooks?.PreToolUse?.[0]?.matcher).toBe('Bash(*)');
      expect(s.hooks?.PreToolUse?.[0]?.hooks[0]).toMatchObject({
        type: 'command',
        command: expect.stringContaining('pre-bash'),
      });
    });

    it('passes permissions through', () => {
      const s = settingsFor({
        name: 'h',
        permissions: { allow: ['Bash(npm *)'], deny: ['Read(./.env)'] },
      });
      expect(s.permissions?.allow).toEqual(['Bash(npm *)']);
      expect(s.permissions?.deny).toEqual(['Read(./.env)']);
    });
  });

  describe('mcpAddCommands', () => {
    it('emits stdio command form', () => {
      const cmds = mcpAddCommands({
        name: 'h',
        mcpServers: [{ name: 'demo', command: ['npx', '-y', 'demo'] }],
      });
      expect(cmds[0]).toBe('claude mcp add demo -- npx -y demo');
    });

    it('emits http transport form', () => {
      const cmds = mcpAddCommands({
        name: 'h',
        mcpServers: [{ name: 'remote', url: 'https://example.com/mcp' }],
      });
      expect(cmds[0]).toContain('--transport http');
      expect(cmds[0]).toContain('https://example.com/mcp');
    });
  });

  // ADR-044 — all 5 hook handler types reachable from the handler string.
  describe('hookHandlerFor (ADR-044)', () => {
    it('plain name → command helper', () => {
      expect(hookHandlerFor('pre-bash')).toEqual({ type: 'command', command: 'node .claude/helpers/pre-bash.cjs' });
    });
    it('https URL → http handler', () => {
      expect(hookHandlerFor('https://hooks.example/x')).toEqual({ type: 'http', url: 'https://hooks.example/x', method: 'POST' });
    });
    it('mcp:server/tool → mcp_tool handler', () => {
      expect(hookHandlerFor('mcp:memory/store')).toEqual({ type: 'mcp_tool', server: 'memory', tool: 'store' });
    });
    it('prompt: → prompt handler', () => {
      expect(hookHandlerFor('prompt:Summarize the change')).toEqual({ type: 'prompt', text: 'Summarize the change' });
    });
    it('agent: → agent handler', () => {
      expect(hookHandlerFor('agent:reviewer')).toEqual({ type: 'agent', agentType: 'reviewer' });
    });
    it('settingsFor routes a non-command handler through the mapper', () => {
      const s = settingsFor({ name: 'h', hooks: [{ event: 'Stop', handler: 'agent:summarizer' }] });
      expect(s.hooks?.Stop?.[0]?.hooks[0]).toEqual({ type: 'agent', agentType: 'summarizer' });
    });
  });

  // ADR-044 — system prompt + agents emission.
  describe('claudeMd + agents (ADR-044)', () => {
    it('claudeMd carries name, description, system prompt', () => {
      const md = claudeMd({ name: 'demo', description: 'A demo.', systemPrompt: 'Be terse.' } as any);
      expect(md).toContain('# demo');
      expect(md).toContain('A demo.');
      expect(md).toContain('Be terse.');
    });

    it('agentMarkdown emits sanitized YAML frontmatter + body', () => {
      const md = agentMarkdown({ name: 'reviewer', systemPrompt: 'Review "carefully"\nalways' });
      expect(md).toMatch(/^---\nname: reviewer\n/);
      expect(md).toContain('\\"carefully\\"');
      expect(md).not.toMatch(/description: ".*\n.*"/);
    });

    it('generateConfig emits CLAUDE.md + .claude/agents/<name>.md per agent', () => {
      const out = adapter.generateConfig!({
        name: 'demo',
        systemPrompt: 'You are demo.',
        agents: [{ name: 'reviewer', systemPrompt: 'Review.' }, { name: 'tester', systemPrompt: 'Test.' }],
      } as any);
      expect(Object.keys(out)).toContain('CLAUDE.md');
      expect(Object.keys(out)).toContain('.claude/agents/reviewer.md');
      expect(Object.keys(out)).toContain('.claude/agents/tester.md');
      expect(out['CLAUDE.md']).toContain('You are demo.');
    });

    it('no CLAUDE.md / agents when spec declares neither', () => {
      const out = adapter.generateConfig!({ name: 'bare' } as any);
      expect(Object.keys(out)).not.toContain('CLAUDE.md');
      expect(Object.keys(out).some(k => k.startsWith('.claude/agents/'))).toBe(false);
    });
  });
});
