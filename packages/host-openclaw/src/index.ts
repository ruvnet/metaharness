// SPDX-License-Identifier: MIT
//
// @ruflo/host-openclaw — OpenClaw host adapter.
//
// OpenClaw is a "Personal AI Assistant" CLI agent gateway — local-first,
// multi-platform (WhatsApp/Telegram/Slack/Discord), MCP-supported.
//
// Verified integration surface (from research):
//   - Install:  `npm install -g openclaw@latest`
//               `openclaw onboard --install-daemon`
//   - Config:   `~/.openclaw/openclaw.json`  (JSON, not TOML)
//   - Skills:   `~/.openclaw/workspace/skills/<skill>/SKILL.md`
//               with YAML frontmatter
//   - Tools:    "First-class tools" — browser, canvas, nodes, cron,
//               sessions; MCP servers register as "external tools"
//   - Quickstart: `openclaw gateway --port 18789 --verbose`
//                 `openclaw agent --message "..." --thinking high`
//   - Node:     >= 22.19 / 24
//   - License:  MIT
//
// This adapter emits the per-harness files OpenClaw needs:
//   - `openclaw.json` config snippet (user merges into their main file)
//   - `SKILL.md` file per kernel skill (placed in the workspace skill dir)
//   - `install-openclaw.sh` runbook script

import type { HostAdapter, HarnessSpec, McpServerSpec } from '@ruflo/kernel';

export const HOST_NAME = 'openclaw' as const;

/**
 * The shape of an entry in `~/.openclaw/openclaw.json`'s mcp_servers map.
 * JSON — NOT TOML (Codex) and NOT YAML (Hermes).
 */
export interface OpenClawMcpServerEntry {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

/**
 * Convert a kernel McpServerSpec to OpenClaw's JSON entry shape.
 * Mirrors Claude Code's MCP entry shape since both speak JSON.
 */
export function serverToOpenClaw(s: McpServerSpec): OpenClawMcpServerEntry {
  const entry: OpenClawMcpServerEntry = {};
  if (s.command && s.command.length > 0) {
    entry.command = s.command[0];
    if (s.command.length > 1) entry.args = s.command.slice(1);
  } else if (s.url) {
    entry.url = s.url;
  }
  if (s.env && s.env.length > 0) {
    entry.env = Object.fromEntries(s.env);
  }
  return entry;
}

/**
 * Render the `openclaw.json` content with the harness's MCP servers
 * registered. OpenClaw's main config file lives at `~/.openclaw/openclaw.
 * json`; users merge this snippet into theirs.
 */
export function configJson(spec: HarnessSpec): string {
  const mcpServers: Record<string, OpenClawMcpServerEntry> = {};
  for (const s of spec.mcpServers ?? []) {
    mcpServers[s.name] = serverToOpenClaw(s);
  }
  return JSON.stringify({ mcp_servers: mcpServers }, null, 2) + '\n';
}

/**
 * Render the SKILL.md content for the harness as an OpenClaw workspace
 * skill. OpenClaw skills follow the same YAML-frontmatter + markdown
 * convention as Claude Code skills.
 */
export function skillMarkdown(spec: HarnessSpec): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`name: ${spec.name}`);
  if (spec.description) {
    // CodeQL js/incomplete-sanitization: escaping only `"` is incomplete —
    // a backslash in the input mis-escapes, and a TRAILING backslash would
    // escape our own closing quote and break the YAML document. Escape the
    // backslash FIRST, then the quote, then flatten raw newlines (illegal in
    // a single-line double-quoted YAML scalar) so no input can break out.
    const desc = spec.description
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/[\r\n]+/g, ' ');
    lines.push(`description: "${desc}"`);
  }
  lines.push('---');
  lines.push('');
  lines.push(`# ${spec.name}`);
  lines.push('');
  if (spec.description) lines.push(spec.description, '');
  if (spec.systemPrompt) {
    lines.push('## System Prompt');
    lines.push('');
    lines.push(spec.systemPrompt);
    lines.push('');
  }
  if (spec.agents && spec.agents.length > 0) {
    lines.push('## Agents');
    lines.push('');
    for (const a of spec.agents) {
      lines.push(`- **${a.name}**: ${a.systemPrompt ?? ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Render the install runbook. Users run this once after generating to
 * register the MCP servers + drop the skill in their workspace.
 */
export function installScript(spec: HarnessSpec): string {
  const lines: string[] = [];
  lines.push('#!/usr/bin/env bash');
  lines.push('# OpenClaw install runbook for harness: ' + spec.name);
  lines.push('set -euo pipefail');
  lines.push('');
  lines.push('# 1. Install OpenClaw if missing');
  lines.push('command -v openclaw >/dev/null 2>&1 || npm install -g openclaw@latest');
  lines.push('');
  lines.push('# 2. Onboard + install daemon (idempotent on re-run)');
  lines.push('openclaw onboard --install-daemon || true');
  lines.push('');
  lines.push('# 3. Merge MCP servers into ~/.openclaw/openclaw.json');
  lines.push('#    Edit the file by hand or use `jq` to merge the snippet shipped at');
  lines.push('#    ./openclaw.json into ~/.openclaw/openclaw.json under "mcp_servers".');
  lines.push('echo "Merge openclaw.json into ~/.openclaw/openclaw.json (manual step)."');
  lines.push('');
  lines.push('# 4. Drop the skill into the workspace');
  lines.push(`mkdir -p "$HOME/.openclaw/workspace/skills/${spec.name}"`);
  lines.push(`cp ./SKILL.md "$HOME/.openclaw/workspace/skills/${spec.name}/SKILL.md"`);
  lines.push('');
  lines.push('echo "Done. Try: openclaw agent --message \\"' + spec.name + ': ping\\""');
  return lines.join('\n') + '\n';
}

export const adapter: HostAdapter = {
  name: HOST_NAME,
  generateConfig: (spec: HarnessSpec) => ({
    'openclaw.json': configJson(spec),
    'SKILL.md': skillMarkdown(spec),
    'install-openclaw.sh': installScript(spec),
  }),
};

export default adapter;
