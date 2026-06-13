// SPDX-License-Identifier: MIT
//
// @ruflo/host-claude-code — Claude Code host adapter.
//
// Verified integration surface (from research, https://code.claude.com/docs):
//   - MCP servers register via `claude mcp add <name> -- <command>`
//   - 3 settings scopes:
//     - ~/.claude/settings.json           (user/global)
//     - .claude/settings.json             (project, committed)
//     - .claude/settings.local.json       (project, gitignored)
//   - Hooks via .claude/settings.json or plugin-supplied hooks/hooks.json
//   - 5 hook handler types: command | http | mcp_tool | prompt | agent
//   - Events: SessionStart, Setup, UserPromptSubmit, PreToolUse, PostToolUse,
//     PostToolUseFailure, Stop, SubagentStart, SubagentStop, FileChanged
//   - Hooks emit JSON to stdout to influence the model:
//     hookSpecificOutput.permissionDecision: "deny|allow|ask|defer"
//     plus additionalContext, updatedInput
//   - Matchers use pseudo-DSL: e.g. "Bash(rm *)"
//   - Three-level shape: event -> matcher -> handler[]

import type { HostAdapter, HarnessSpec } from '@ruflo/kernel';

export interface ClaudeCodeSettings {
  hooks?: Record<string, Array<{ matcher?: string; hooks: ClaudeHookHandler[] }>>;
  permissions?: { allow?: string[]; deny?: string[] };
  statusLine?: { type: 'command'; command: string };
  env?: Record<string, string>;
}

export type ClaudeHookHandler =
  | { type: 'command'; command: string; timeout?: number }
  | { type: 'http'; url: string; method?: 'POST' | 'GET' }
  | { type: 'mcp_tool'; server: string; tool: string }
  | { type: 'prompt'; text: string }
  | { type: 'agent'; agentType: string };

export const HOST_NAME = 'claude-code' as const;

/**
 * Generate Claude Code-shaped settings.json content for a harness.
 * Iteration 2 stub: emits the skeleton; full mapping lands in iter 3.
 */
export function settingsFor(spec: HarnessSpec): ClaudeCodeSettings {
  return {
    hooks: spec.hooks?.length ? Object.fromEntries(
      spec.hooks.map(h => [h.event, [{ matcher: h.matcher ?? '*', hooks: [{ type: 'command', command: `node .claude/helpers/${h.handler}.cjs` }] }]])
    ) : undefined,
    permissions: spec.permissions,
    statusLine: spec.statusLine ? { type: 'command', command: spec.statusLine } : undefined,
  };
}

/**
 * Build the `claude mcp add` command lines for the harness's MCP servers.
 * These run as post-install steps in the harness's own init script.
 */
export function mcpAddCommands(spec: HarnessSpec): string[] {
  return (spec.mcpServers ?? []).map(s => {
    if (s.command) {
      return `claude mcp add ${s.name} -- ${s.command.join(' ')}`;
    }
    if (s.url) {
      return `claude mcp add --transport http ${s.name} ${s.url}`;
    }
    return `# (skipped: ${s.name} has neither command nor url)`;
  });
}

export const adapter: HostAdapter = {
  name: HOST_NAME,
  generateConfig: (spec: HarnessSpec) => ({
    '.claude/settings.json': JSON.stringify(settingsFor(spec), null, 2),
    'install-mcp.sh': mcpAddCommands(spec).join('\n') + '\n',
  }),
};

export default adapter;
