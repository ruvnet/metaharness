// SPDX-License-Identifier: MIT
//
// @metaharness/host-codex — OpenAI Codex CLI host adapter.
//
// Verified integration surface (from research):
//   - Repo: https://github.com/openai/codex
//   - Docs: https://developers.openai.com/codex/config-basic
//           https://developers.openai.com/codex/mcp
//   - Config: TOML at ~/.codex/config.toml (user) or .codex/config.toml
//     (project, only honored for "trusted" projects)
//   - MCP under [mcp_servers.<name>] tables: command/args/[env] OR url +
//     bearer_token_env_var for Streamable HTTP
//   - Programmatic: `codex mcp add <name> --env K=V -- <stdio-cmd>`
//
// Known quirks vs Claude Code:
//   1. TOML not JSON
//   2. "Trusted project" gate — known footgun (codex#3441)
//   3. NO first-class hooks system. The kernel's hook events that have no
//      Codex analog must be approximated through MCP tool calls or simply
//      no-op (the kernel returns Ok(()) silently).

import type { HostAdapter, HarnessSpec, McpServerSpec } from '@metaharness/kernel';

export const HOST_NAME = 'codex' as const;

/**
 * ADR-044: emit AGENTS.md from the harness system prompt, description, and
 * agent roster. Codex reads repo-root AGENTS.md for project instructions; the
 * adapter previously dropped `spec.systemPrompt` and `spec.agents` entirely.
 */
export function agentsMarkdown(spec: HarnessSpec): string {
  const lines: string[] = [`# ${spec.name}`, ''];
  if (spec.description) lines.push(spec.description, '');
  if (spec.systemPrompt) lines.push(spec.systemPrompt, '');
  if (spec.agents && spec.agents.length > 0) {
    lines.push('## Agents', '');
    for (const a of spec.agents) lines.push(`### ${a.name}`, '', a.systemPrompt ?? '', '');
  }
  return lines.join('\n');
}

/**
 * Escape a string for inclusion in a TOML basic string literal.
 * TOML basic strings allow common escapes (\", \\, \n, etc.).
 */
export function tomlEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Render a single MCP server entry as a TOML table.
 */
export function serverToToml(s: McpServerSpec): string {
  const lines: string[] = [`[mcp_servers.${s.name}]`];
  if (s.command && s.command.length > 0) {
    lines.push(`command = "${tomlEscape(s.command[0]!)}"`);
    if (s.command.length > 1) {
      const args = s.command.slice(1).map(a => `"${tomlEscape(a)}"`).join(', ');
      lines.push(`args = [${args}]`);
    }
  } else if (s.url) {
    lines.push(`url = "${tomlEscape(s.url)}"`);
  }
  if (s.env && s.env.length > 0) {
    lines.push(`[mcp_servers.${s.name}.env]`);
    for (const [k, v] of s.env) {
      lines.push(`${k} = "${tomlEscape(v)}"`);
    }
  }
  return lines.join('\n');
}

/**
 * Render the full config.toml content for a harness's MCP servers.
 */
export function configToml(spec: HarnessSpec): string {
  return (spec.mcpServers ?? []).map(serverToToml).join('\n\n') + '\n';
}

/**
 * Build the `codex mcp add` command lines for the harness's MCP servers.
 * Useful for users on the programmatic-install path.
 */
export function mcpAddCommands(spec: HarnessSpec): string[] {
  return (spec.mcpServers ?? []).map(s => {
    const env = (s.env ?? []).map(([k, v]) => `--env ${k}=${v}`).join(' ');
    if (s.command) {
      return `codex mcp add ${env} ${s.name} -- ${s.command.join(' ')}`.replace(/\s+/g, ' ');
    }
    if (s.url) {
      return `codex mcp add ${env} ${s.name} --url ${s.url}`.replace(/\s+/g, ' ');
    }
    return `# (skipped: ${s.name} has neither command nor url)`;
  });
}

export const adapter: HostAdapter = {
  name: HOST_NAME,
  generateConfig: (spec: HarnessSpec) => {
    const out: Record<string, string> = {
      '.codex/config.toml': configToml(spec),
      'install-mcp.sh': mcpAddCommands(spec).join('\n') + '\n',
    };
    // ADR-044: emit AGENTS.md (system prompt + agent roster).
    if (spec.systemPrompt || spec.description || (spec.agents?.length ?? 0) > 0) {
      out['AGENTS.md'] = agentsMarkdown(spec);
    }
    return out;
  },
};

export default adapter;
