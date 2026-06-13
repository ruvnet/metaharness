// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { settingsFor, mcpAddCommands } from '../src/index.js';

describe('@ruflo/host-claude-code', () => {
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
});
