// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import {
  defineAgent,
  defineSkill,
  defineTool,
  defineHook,
  defineMcpServer,
  defineHarness,
  type HookDef,
} from '../src/index.js';

describe('defineAgent', () => {
  it('accepts a well-formed agent', () => {
    const a = defineAgent({ name: 'coder', systemPrompt: 'You code.', tier: 'small' });
    expect(a.name).toBe('coder');
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('rejects bad names', () => {
    expect(() => defineAgent({ name: 'BadName', systemPrompt: 'x', tier: 'small' })).toThrow(/kebab-case/);
    expect(() => defineAgent({ name: '1bad', systemPrompt: 'x', tier: 'small' })).toThrow();
    expect(() => defineAgent({ name: 'bad-', systemPrompt: 'x', tier: 'small' })).toThrow(/hyphen/);
    expect(() => defineAgent({ name: 'bad--name', systemPrompt: 'x', tier: 'small' })).toThrow(/consecutive/);
  });

  it('rejects empty systemPrompt', () => {
    expect(() => defineAgent({ name: 'x', systemPrompt: '', tier: 'small' })).toThrow(/systemPrompt/);
    expect(() => defineAgent({ name: 'x', systemPrompt: '   ', tier: 'small' })).toThrow();
  });

  it('rejects unknown tier', () => {
    expect(() => defineAgent({ name: 'x', systemPrompt: 'p', tier: 'unknown' as 'small' })).toThrow(/tier/);
  });
});

describe('defineSkill', () => {
  it('accepts a well-formed skill', () => {
    const s = defineSkill({ name: 'doc', description: 'docs the docs', body: 'whole body' });
    expect(s.name).toBe('doc');
    expect(Object.isFrozen(s)).toBe(true);
  });

  it('rejects missing description / body', () => {
    expect(() => defineSkill({ name: 'x', description: '', body: 'y' })).toThrow();
    expect(() => defineSkill({ name: 'x', description: 'y', body: '' })).toThrow();
  });
});

describe('defineTool', () => {
  it('accepts a well-formed tool', () => {
    const t = defineTool({
      name: 'store', server: 'memory', description: 'store a thing',
      inputSchema: { type: 'object' },
    });
    expect(t.name).toBe('store');
  });

  it('rejects missing server / description / non-object schema', () => {
    expect(() => defineTool({
      name: 'x', server: '', description: 'd', inputSchema: { type: 'object' },
    })).toThrow();
    expect(() => defineTool({
      name: 'x', server: 's', description: '', inputSchema: { type: 'object' },
    })).toThrow();
    expect(() => defineTool({
      name: 'x', server: 's', description: 'd', inputSchema: null as unknown as Record<string, unknown>,
    })).toThrow();
  });

  it('rejects non-kebab-case names', () => {
    expect(() => defineTool({
      name: 'Bad Name', server: 's', description: 'd', inputSchema: { type: 'object' },
    })).toThrow(/kebab-case/);
  });
});

describe('defineMcpServer', () => {
  it('accepts stdio form', () => {
    const s = defineMcpServer({ name: 'demo', command: ['npx', '-y', 'demo'] });
    expect(s.name).toBe('demo');
  });

  it('accepts url form', () => {
    const s = defineMcpServer({ name: 'remote', url: 'https://example.com/mcp' });
    expect(s.url).toBe('https://example.com/mcp');
  });

  it('rejects neither and both', () => {
    expect(() => defineMcpServer({ name: 'x' })).toThrow(/either command or url/);
    expect(() => defineMcpServer({ name: 'x', command: ['y'], url: 'https://z' })).toThrow(/cannot have both/);
  });

  it('rejects non-kebab-case names', () => {
    expect(() => defineMcpServer({ name: 'Bad Name', url: 'https://z' })).toThrow(/kebab-case/);
  });
});

describe('defineHarness', () => {
  it('composes a well-formed harness', () => {
    const a = defineAgent({ name: 'a1', systemPrompt: 'p', tier: 'small' });
    const a2 = defineAgent({ name: 'a2', systemPrompt: 'p', tier: 'frontier' });
    const h = defineHarness({
      name: 'my-bot',
      description: 'desc',
      agents: [a, a2],
    });
    expect(h.name).toBe('my-bot');
    expect(h.agents.length).toBe(2);
    expect(Object.isFrozen(h)).toBe(true);
    expect(Object.isFrozen(h.agents)).toBe(true);
  });

  it('detects agent name collision', () => {
    const a1 = defineAgent({ name: 'dup', systemPrompt: 'p', tier: 'small' });
    const a2 = defineAgent({ name: 'dup', systemPrompt: 'q', tier: 'frontier' });
    expect(() => defineHarness({ name: 'h', description: 'd', agents: [a1, a2] })).toThrow(/agent name collision/);
  });

  it('detects skill name collision', () => {
    const s1 = defineSkill({ name: 'dup', description: 'd', body: 'b' });
    const s2 = defineSkill({ name: 'dup', description: 'd2', body: 'b2' });
    expect(() => defineHarness({ name: 'h', description: 'd', skills: [s1, s2] })).toThrow(/skill name collision/);
  });

  it('detects tool name collision', () => {
    const t1 = defineTool({ name: 'dup', server: 's', description: 'd', inputSchema: { type: 'object' } });
    const t2 = defineTool({ name: 'dup', server: 's2', description: 'd2', inputSchema: { type: 'object' } });
    expect(() => defineHarness({ name: 'h', description: 'd', tools: [t1, t2] })).toThrow(/tool name collision/);
  });

  it('detects mcp server name collision', () => {
    const m1 = defineMcpServer({ name: 'dup', url: 'https://a' });
    const m2 = defineMcpServer({ name: 'dup', url: 'https://b' });
    expect(() => defineHarness({ name: 'h', description: 'd', mcpServers: [m1, m2] })).toThrow(/mcp server name collision/);
  });

  it('rejects harness with bad name', () => {
    expect(() => defineHarness({ name: 'BadName', description: 'd' })).toThrow(/kebab-case/);
  });

  it('preserves optional descriptions but rejects explicitly empty descriptions', () => {
    expect(defineHarness({ name: 'h' }).description).toBeUndefined();
    expect(() => defineHarness({ name: 'h', description: '' })).toThrow(/description/);
    expect(() => defineHarness({ name: 'h', description: '   ' })).toThrow(/description/);
  });

  it('defaults all optional sections to empty arrays', () => {
    const h = defineHarness({ name: 'h', description: 'd' });
    expect(h.agents).toEqual([]);
    expect(h.skills).toEqual([]);
    expect(h.tools).toEqual([]);
    expect(h.hooks).toEqual([]);
    expect(h.mcpServers).toEqual([]);
  });
});

describe('defineHook', () => {
  it('accepts a well-formed hook', () => {
    const h = defineHook({ event: 'PreToolUse', matcher: 'Bash(rm *)', handler: 'block-rm' });
    expect(h.event).toBe('PreToolUse');
    expect(Object.isFrozen(h)).toBe(true);
  });

  it('accepts every documented Claude Code hook event (33, re-verified 2026-11-14 against the live official docs — see ADR-004)', () => {
    const events = [
      'SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion',
      'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUse',
      'PostToolUseFailure', 'PostToolBatch', 'Notification', 'MessageDisplay',
      'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted',
      'Stop', 'StopFailure', 'TeammateIdle', 'InstructionsLoaded',
      'ConfigChange', 'CwdChanged', 'DirectoryAdded', 'FileChanged',
      'WorktreeCreate', 'WorktreeRemove', 'PreCompact', 'PostCompact',
      'PreModelSwitch', 'PostModelSwitch', 'Elicitation', 'ElicitationResult',
      'SessionEnd',
    ] as const;
    expect(events.length).toBe(33);
    for (const event of events) {
      expect(defineHook({ event, handler: 'h' }).event).toBe(event);
    }
  });

  it('rejects missing handler', () => {
    expect(() => defineHook({ event: 'PreToolUse', handler: '' })).toThrow();
  });

  it('rejects an unknown/typo\'d event instead of letting it reach a host adapter silently', () => {
    expect(() => defineHook({
      event: 'PreToolUser' as HookDef['event'], handler: 'block-rm',
    })).toThrow(/hook event must be one of/);
    expect(() => defineHook({
      event: 'onPreToolUse' as HookDef['event'], handler: 'block-rm',
    })).toThrow(/PreToolUse/);
  });
});
