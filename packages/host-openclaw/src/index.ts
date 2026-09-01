// SPDX-License-Identifier: MIT
//
// @metaharness/host-openclaw — OpenClaw host adapter.
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

import type { HostAdapter, HarnessSpec, McpServerSpec } from '@metaharness/kernel';

export const HOST_NAME = 'openclaw' as const;

/**
 * An entry in OpenClaw's `mcp.servers` map — VERIFIED against a real
 * `openclaw` 2026.6.8 install via `openclaw config schema`/`config validate`
 * (ADR-046). Each entry carries an `enabled` flag; `command` is a string +
 * separate `args` array; `env` is an object. (The earlier top-level
 * `mcp_servers` map without `enabled` was REJECTED — `config validate`
 * reported "<root>: Invalid input".)
 */
export interface OpenClawMcpServerEntry {
  enabled: boolean;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

/** Convert a kernel McpServerSpec to OpenClaw's mcp.servers entry shape. */
export function serverToOpenClaw(s: McpServerSpec): OpenClawMcpServerEntry {
  const entry: OpenClawMcpServerEntry = { enabled: true };
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
  const servers: Record<string, OpenClawMcpServerEntry> = {};
  for (const s of spec.mcpServers ?? []) {
    servers[s.name] = serverToOpenClaw(s);
  }
  // ADR-046: real openclaw (2026.6.8) nests MCP under `mcp.servers` (NOT
  // top-level `mcp_servers`), each entry needs `enabled`. OpenClaw has NO
  // top-level allow/deny `permissions` concept — tool gating is the structured
  // `approvals.exec` ({enabled, mode}) / `security.installPolicy`, which does
  // not map to the kernel's allow/deny patterns. Rather than invent a value the
  // schema rejects, we emit only the (verified-valid) `mcp.servers` block and
  // leave security to OpenClaw's own defaults + `openclaw configure`. Verified
  // to pass `openclaw config validate`.
  const cfg: Record<string, unknown> = { mcp: { servers } };
  return JSON.stringify(cfg, null, 2) + '\n';
}

/**
 * Escape a string for use as a double-quoted YAML flow scalar (frontmatter
 * value position). Sibling of #188 (hermes) and #224 (host-rvm): `spec.name`
 * reaches this function unescaped via any caller that bypasses the CLI's
 * kebab-case `validateHarnessName` gate (a direct SDK/adapter call, the
 * web-UI) — a name containing `:`, a raw newline, or leading YAML indicator
 * characters silently corrupts the frontmatter or smuggles in a sibling key.
 * Escape the backslash FIRST, then the quote, then flatten raw newlines
 * (illegal in a single-line double-quoted YAML scalar).
 */
function yamlDq(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
}

// YAML 1.1 core-schema bare scalars a loader would resolve to bool/null/number
// instead of a string. Mirrors host-hermes's `YAML_RESERVED_BARE` (#188).
const YAML_RESERVED_BARE = /^(?:null|~|true|false|yes|no|on|off|[+-]?\d+(?:\.\d+)?)$/i;

/**
 * Render a string as a YAML frontmatter *value*: bare (unquoted, the
 * existing byte-identical output) when it's already a conventional safe
 * identifier and not a reserved bare scalar; quoted + escaped via `yamlDq`
 * otherwise. Bare-when-safe mirrors host-hermes's `yamlKey()` (#188).
 */
function yamlValueSafe(s: string): string {
  const isSafeIdentifier = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s);
  return isSafeIdentifier && !YAML_RESERVED_BARE.test(s) ? s : `"${yamlDq(s)}"`;
}

/**
 * Render the SKILL.md content for the harness as an OpenClaw workspace
 * skill. OpenClaw skills follow the same YAML-frontmatter + markdown
 * convention as Claude Code skills.
 */

export function skillMarkdown(spec: HarnessSpec): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`name: ${yamlValueSafe(spec.name)}`);
  if (spec.description) {
    const desc = yamlDq(spec.description);
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
 * Escape a string for safe interpolation inside a double-quoted POSIX/bash
 * string. Plain double-quoting does NOT stop command substitution
 * (`$(...)`, backticks) or variable expansion (`$var`) — an attacker-
 * controlled `spec.name` reaching `installScript()` unescaped can run
 * arbitrary shell commands when the generated `install-openclaw.sh` is
 * executed. Escapes the 4 characters meaningful inside a bash
 * double-quoted string: backslash, double-quote, dollar-sign, backtick.
 * Byte-identical output for any name without those characters. Mirrors
 * host-rvm's `shellDq()` (#224) for the same class of finding.
 */
function shellDq(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

/**
 * Strip CR/LF from a string destined for a raw `#`-comment line. A comment
 * line has no quoting to escape *into*; a literal newline in the source
 * string is the only character that can break out of it and turn the
 * remainder into a live statement. Mirrors host-rvm's `commentSafe()` (#224).
 */
function commentSafe(s: string): string {
  return s.replace(/[\r\n]+/g, ' ');
}

/**
 * Reduce a string to a single path segment for the generated `mkdir`/`cp`
 * lines. `shellDq()` stops command *execution*, not path *traversal*: a name
 * of `../../../x` is a perfectly ordinary double-quoted bash string, so
 * `mkdir -p` happily creates it outside the skills directory and `cp` writes
 * SKILL.md there. Collapse every path separator to `-` and prefix a
 * pure-dots segment, so the result can only ever name a direct child of the
 * skills directory. Byte-identical for any name without a separator.
 *
 * MUST be applied BEFORE `shellDq()` — running it after would rewrite the
 * backslashes `shellDq()` just added and undo the escaping.
 */
function pathSegmentSafe(s: string): string {
  const flat = s.replace(/[\\/]+/g, '-');
  return /^\.+$/.test(flat) ? `_${flat}` : flat;
}

/**
 * Render the install runbook. Users run this once after generating to
 * register the MCP servers + drop the skill in their workspace.
 */
export function installScript(spec: HarnessSpec): string {
  const lines: string[] = [];
  lines.push('#!/usr/bin/env bash');
  lines.push('# OpenClaw install runbook for harness: ' + commentSafe(spec.name));
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
  lines.push(`mkdir -p "$HOME/.openclaw/workspace/skills/${shellDq(pathSegmentSafe(spec.name))}"`);
  lines.push(`cp ./SKILL.md "$HOME/.openclaw/workspace/skills/${shellDq(pathSegmentSafe(spec.name))}/SKILL.md"`);
  lines.push('');
  lines.push('echo "Done. Try: openclaw agent --message \\"' + shellDq(spec.name) + ': ping\\""');
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
