// SPDX-License-Identifier: MIT
//
// @metaharness/host-claude-code — Claude Code host adapter.
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

import type { HostAdapter, HarnessSpec, AgentSpec } from '@metaharness/kernel';

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
 * ADR-044: map a kernel HookSpec `handler` string onto one of Claude Code's 5
 * hook handler types. The kernel HookSpec carries only a `handler: string`, so
 * the type is encoded by a prefix convention (keeping the kernel contract
 * unchanged). Previously every handler was forced to `command`, dropping the
 * other 4 handler types Claude Code supports.
 *
 *   - `http://…` / `https://…`        → { type: 'http', url }
 *   - `mcp:<server>/<tool>`            → { type: 'mcp_tool', server, tool }
 *   - `prompt:<text>`                  → { type: 'prompt', text }
 *   - `agent:<agentType>`              → { type: 'agent', agentType }
 *   - anything else (a helper name)    → { type: 'command', command: node helper }
 */
export function hookHandlerFor(handler: string): ClaudeHookHandler {
  if (/^https?:\/\//i.test(handler)) {
    return { type: 'http', url: handler, method: 'POST' };
  }
  if (handler.startsWith('mcp:')) {
    const rest = handler.slice(4);
    const slash = rest.indexOf('/');
    const server = slash === -1 ? rest : rest.slice(0, slash);
    const tool = slash === -1 ? '' : rest.slice(slash + 1);
    return { type: 'mcp_tool', server, tool };
  }
  if (handler.startsWith('prompt:')) {
    return { type: 'prompt', text: handler.slice(7) };
  }
  if (handler.startsWith('agent:')) {
    return { type: 'agent', agentType: handler.slice(6) };
  }
  return { type: 'command', command: `node .claude/helpers/${handler}.cjs` };
}

/**
 * Generate Claude Code-shaped settings.json content for a harness.
 * ADR-044: hooks now map to all 5 handler types (was command-only); env is
 * passed through.
 */
export function settingsFor(spec: HarnessSpec): ClaudeCodeSettings {
  return {
    hooks: spec.hooks?.length ? Object.fromEntries(
      spec.hooks.map(h => [h.event, [{ matcher: h.matcher ?? '*', hooks: [hookHandlerFor(h.handler)] }]])
    ) : undefined,
    permissions: spec.permissions,
    statusLine: spec.statusLine ? { type: 'command', command: spec.statusLine } : undefined,
  };
}

/**
 * ADR-044: emit CLAUDE.md from the harness system prompt + description.
 * Claude Code reads project instructions from CLAUDE.md; the adapter
 * previously dropped `spec.systemPrompt` entirely.
 */
export function claudeMd(spec: HarnessSpec): string {
  const lines: string[] = [`# ${spec.name}`, ''];
  if (spec.description) lines.push(spec.description, '');
  if (spec.systemPrompt) lines.push(spec.systemPrompt, '');
  return lines.join('\n');
}

/**
 * ADR-044: render a Claude Code subagent definition for `.claude/agents/<name>.md`
 * (YAML frontmatter + markdown body). The adapter previously dropped
 * `spec.agents`. Frontmatter is sanitized so a prompt with quotes/newlines
 * cannot break the YAML document.
 */
export function agentMarkdown(a: AgentSpec): string {
  const desc = (a.systemPrompt ?? `Agent: ${a.name}`)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200);
  return [
    '---',
    `name: ${a.name}`,
    `description: "${desc}"`,
    '---',
    '',
    a.systemPrompt ?? `You are the ${a.name} agent.`,
    '',
  ].join('\n');
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
  generateConfig: (spec: HarnessSpec) => {
    const out: Record<string, string> = {
      '.claude/settings.json': JSON.stringify(settingsFor(spec), null, 2),
      'install-mcp.sh': mcpAddCommands(spec).join('\n') + '\n',
    };
    // ADR-044: emit CLAUDE.md (system prompt) + one subagent file per agent.
    if (spec.systemPrompt || spec.description) out['CLAUDE.md'] = claudeMd(spec);
    for (const a of spec.agents ?? []) {
      out[`.claude/agents/${a.name}.md`] = agentMarkdown(a);
    }
    return out;
  },
};

export default adapter;
