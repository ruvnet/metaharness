// SPDX-License-Identifier: MIT
//
// @metaharness/host-copilot — GitHub Copilot (VSCode) host adapter. The 7th host,
// per ADR-032.
//
// Verified integration surface (research from ADR-032):
//   - VSCode 1.99+ ships first-class MCP support for the Copilot Chat
//     extension. Config lives in `.vscode/mcp.json` (workspace) or in
//     the user-scoped `settings.json` under the `mcp.servers` key.
//   - The schema is a superset of Claude Code's: `servers` map with
//     either stdio (`command` + `args`) or HTTP (`url`) entries, plus
//     an optional `env` table per server.
//   - Workspace trust: VSCode will refuse to load .vscode/mcp.json
//     unless the user has trusted the workspace. The adapter cannot
//     bypass this; it ships an `install.md` runbook that walks the
//     user through trusting the workspace once.
//
// Known constraints vs Claude Code:
//   1. Workspace trust gate (no programmatic install path inside VSCode)
//   2. No first-class slash-command system equivalent to Claude Code's
//      `.claude/commands/` — Copilot Chat has hardcoded commands plus
//      chat participants registered by extensions. Slash-commands from
//      the harness are surfaced through the MCP server's prompts list.
//   3. No webhook / event surface — the hooks subsystem maps to MCP
//      tool calls instead.

import type { HostAdapter, HarnessSpec, McpServerSpec } from '@metaharness/kernel';

export const HOST_NAME = 'copilot' as const;

/**
 * Render a single MCP server entry as a VSCode mcp.json object.
 *
 * VSCode 1.99 schema (verified iter 127):
 * {
 *   "name": "<name>",         // optional; derived from the map key
 *   "command": "<binary>",    // stdio
 *   "args": ["..."],          // stdio
 *   "url": "https://...",     // HTTP streamable (alternative to command)
 *   "env": { "K": "V" }       // optional
 * }
 */
export function serverToVscode(s: McpServerSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.command && s.command.length > 0) {
    out.command = s.command[0];
    if (s.command.length > 1) out.args = s.command.slice(1);
  } else if (s.url) {
    out.url = s.url;
  }
  if (s.env && s.env.length > 0) {
    const env: Record<string, string> = {};
    for (const [k, v] of s.env) env[k] = v;
    out.env = env;
  }
  return out;
}

/**
 * Render the full .vscode/mcp.json content for a harness. VSCode + Copilot
 * read the `servers` top-level key (newer schema) OR `mcpServers` (older,
 * Claude Code-compatible). We emit `servers` per VSCode 1.99+ but include
 * a compat alias under `mcpServers` so a project that mounts under an
 * older runtime still loads.
 */
export function mcpJson(spec: HarnessSpec): string {
  const servers: Record<string, unknown> = {};
  for (const s of spec.mcpServers ?? []) {
    servers[s.name] = serverToVscode(s);
  }
  const cfg = {
    // ADR-032 §4 — emit both keys for forward + backward compat
    servers,
    mcpServers: servers,
  };
  return JSON.stringify(cfg, null, 2) + '\n';
}

/**
 * Per-host setup runbook surfaced as an `install.md` in the generated
 * harness. Walks the user through the one-time workspace-trust gate +
 * Copilot subscription requirement.
 */
export function installRunbook(spec: HarnessSpec): string {
  const name = spec.name ?? 'this harness';
  return [
    `# Installing ${name} into GitHub Copilot (VSCode)`,
    '',
    '## Prerequisites',
    '',
    '- VSCode 1.99 or later (Copilot Chat MCP support landed in that release)',
    '- An active GitHub Copilot subscription',
    '',
    '## One-time workspace trust',
    '',
    'When you open this folder in VSCode, you will be prompted to **trust the',
    'workspace**. You must accept to allow `.vscode/mcp.json` to load. VSCode',
    'remembers the decision per folder.',
    '',
    '## Verify the MCP servers loaded',
    '',
    '1. Open the Copilot Chat panel.',
    '2. Run the slash command `/mcp` to list registered MCP servers.',
    '3. Expected entries:',
    ...(spec.mcpServers ?? []).map(s => `   - \`${s.name}\``),
    '',
    '## Known gotchas',
    '',
    '- VSCode does not re-read `.vscode/mcp.json` on hot-edit; reload the window',
    '  after any change.',
    '- The Copilot extension scopes MCP tool calls per chat participant; if a',
    '  tool does not appear, switch to the `@workspace` participant.',
    '- Environment variables in `mcp.json` are NOT interpolated against your',
    '  shell — you must paste literal values or use `${env:VAR}` syntax.',
  ].join('\n') + '\n';
}

/**
 * ADR-044: emit `.github/copilot-instructions.md` from the harness system
 * prompt + description. GitHub Copilot reads this file for repo-wide custom
 * instructions; the adapter previously dropped `spec.systemPrompt`.
 */
export function copilotInstructions(spec: HarnessSpec): string {
  const lines: string[] = [`# ${spec.name}`, ''];
  if (spec.description) lines.push(spec.description, '');
  if (spec.systemPrompt) lines.push(spec.systemPrompt, '');
  if (spec.agents && spec.agents.length > 0) {
    lines.push('## Agent roles', '');
    for (const a of spec.agents) lines.push(`- **${a.name}**: ${a.systemPrompt ?? ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

export const adapter: HostAdapter = {
  name: HOST_NAME,
  generateConfig: (spec: HarnessSpec) => {
    const out: Record<string, string> = {
      '.vscode/mcp.json': mcpJson(spec),
      'install.md': installRunbook(spec),
    };
    // ADR-044: emit Copilot custom instructions (system prompt + agent roles).
    if (spec.systemPrompt || spec.description || (spec.agents?.length ?? 0) > 0) {
      out['.github/copilot-instructions.md'] = copilotInstructions(spec);
    }
    return out;
  },
};

export default adapter;
