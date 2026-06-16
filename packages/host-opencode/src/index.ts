// SPDX-License-Identifier: MIT
//
// @metaharness/host-opencode — OpenCode (sst/opencode) host adapter. The 8th host,
// per ADR-036.
//
// Verified integration surface (research from ADR-036):
//   - OpenCode is an open-source terminal AI coding agent by SST.
//   - First-class MCP support via .opencode/opencode.json or
//     ~/.opencode/opencode.json. Schema-compatible with Claude Code's
//     mcpServers — the kernel's src/mcp/server.ts emits the same shape.
//   - Permissions modelled as { allow: string[], deny: string[] } under
//     mcp.permissions — directly compatible with .harness/mcp-policy.json's
//     allow/deny arrays (ADR-022).
//   - Agents defined in .opencode/agents/ as markdown with YAML frontmatter
//     (analogous to Claude Code's .claude/commands/).
//
// Default-deny composition (ADR-036 §Default-deny composition):
//   OpenCode evaluates `deny` BEFORE `allow`. The adapter MUST emit the
//   deny rules from .harness/mcp-policy.json verbatim, so the harness's
//   posture wins through OpenCode's own enforcement gate.

import type { HostAdapter, HarnessSpec, McpServerSpec, AgentSpec } from '@metaharness/kernel';

export const HOST_NAME = 'opencode' as const;

/**
 * OpenCode MCP server entry shape — VERIFIED against a real `opencode` 1.17.7
 * install (ADR-046). `mcp` is a direct name→server map (NOT `mcp.servers`), and
 * each entry is a tagged union:
 *   local:  { "type": "local",  "command": ["bin","arg",…], "enabled": true, "environment": {…} }
 *   remote: { "type": "remote", "url": "https://…",         "enabled": true }
 * The earlier `{ command, args }` shape (no `type`/`enabled`) is REJECTED by
 * real opencode with a schema error.
 */
export function serverToOpencode(s: McpServerSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.command && s.command.length > 0) {
    out.type = 'local';
    out.command = s.command; // full array, incl. binary + args
  } else if (s.url) {
    out.type = 'remote';
    out.url = s.url;
  } else {
    out.type = 'local';
    out.command = [];
  }
  out.enabled = true;
  if (s.env && s.env.length > 0) {
    const env: Record<string, string> = {};
    for (const [k, v] of s.env) env[k] = v;
    out.environment = env; // opencode key is `environment`, not `env`
  }
  return out;
}

/**
 * Map the harness allow/deny posture (ADR-022) onto opencode's top-level
 * `permission` object — VERIFIED against real opencode 1.17.7, which has NO
 * `mcp.permissions` key (it parsed our old one as a malformed MCP server).
 * opencode permission values are "ask" | "allow" | "deny"; `bash` may be a
 * map of glob→decision.
 */
export function permissionBlock(policy: { allow?: string[]; deny?: string[] } | undefined): Record<string, unknown> {
  const allow = policy?.allow ?? [];
  const deny = policy?.deny ?? [];
  const bashAllowsAll = allow.some((a) => /^Bash\(\*\)$/i.test(a));
  const bash: Record<string, string> = { '*': bashAllowsAll ? 'allow' : 'ask' };
  for (const d of deny) {
    const m = /^Bash\(([^)]+)\)$/i.exec(d);
    if (m) bash[m[1]!.replace(/:/g, ' ').trim()] = 'deny';
  }
  // Default-deny: if the policy denies file writes, gate edits to "ask".
  const denyWrite = deny.some((d) => /^(Write|Edit|MultiEdit)\(/i.test(d));
  return {
    edit: denyWrite ? 'deny' : 'ask',
    bash,
    webfetch: 'ask',
  };
}

/**
 * Render the full .opencode/opencode.json content — `$schema` + `mcp` map +
 * top-level `permission`. Verified to load in real opencode 1.17.7 (ADR-046).
 */
export function opencodeJson(spec: HarnessSpec): string {
  const mcp: Record<string, unknown> = {};
  for (const s of spec.mcpServers ?? []) {
    mcp[s.name] = serverToOpencode(s);
  }
  // The kernel contract field is `spec.permissions`; keep `mcpPolicy` as a
  // back-compat fallback for callers still passing it.
  const policy = (spec.permissions ?? (spec as any).mcpPolicy) as {
    allow?: string[];
    deny?: string[];
  } | undefined;
  const cfg: Record<string, unknown> = {
    $schema: 'https://opencode.ai/schema/opencode.json',
    mcp,
    permission: permissionBlock(policy),
  };
  return JSON.stringify(cfg, null, 2) + '\n';
}

/**
 * ADR-044: render an OpenCode agent definition. OpenCode reads agents from
 * `.opencode/agents/<name>.md` as markdown with YAML frontmatter (the host's
 * own header comment documents this surface; the adapter previously dropped
 * `spec.agents` entirely). Frontmatter is sanitized so an agent prompt with
 * quotes/newlines cannot break the YAML document.
 */
export function agentMarkdown(a: AgentSpec): string {
  const desc = (a.systemPrompt ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200);
  return [
    '---',
    `description: "${desc}"`,
    'mode: subagent',
    '---',
    '',
    a.systemPrompt ?? `Agent: ${a.name}`,
    '',
  ].join('\n');
}

/**
 * ADR-044: emit AGENTS.md from `spec.systemPrompt`. OpenCode reads repo-root
 * AGENTS.md for project instructions; the adapter previously dropped the
 * harness system prompt.
 */
export function agentsMarkdown(spec: HarnessSpec): string {
  return [
    `# ${spec.name}`,
    '',
    spec.description ?? '',
    '',
    spec.systemPrompt ?? '',
    '',
  ].join('\n');
}

/**
 * Per-host setup runbook. Walks the user through `opencode auth login`,
 * model-provider selection, and a first-boot smoke.
 */
export function installRunbook(spec: HarnessSpec): string {
  const name = spec.name ?? 'this harness';
  return [
    `# Installing ${name} into OpenCode`,
    '',
    '## Prerequisites',
    '',
    '- OpenCode 1.0 or later (`opencode --version`)',
    '- A model provider configured (Anthropic, OpenAI, local Ollama, etc.)',
    '',
    '## First-boot',
    '',
    '```bash',
    'opencode auth login              # one-time provider setup',
    'cd /path/to/this/harness',
    'opencode                          # boots the TUI; loads .opencode/opencode.json',
    '```',
    '',
    '## Verify MCP servers registered',
    '',
    'Run the slash command `/mcp` inside the OpenCode TUI to list registered',
    'MCP servers. Expected entries:',
    '',
    ...(spec.mcpServers ?? []).map(s => `- \`${s.name}\``),
    '',
    '## Known gotchas',
    '',
    '- OpenCode re-reads `.opencode/opencode.json` on `:reload` but not on',
    '  hot-edit; restart the TUI after schema changes.',
    '- The `mcp.permissions.deny` block is enforced BEFORE `allow`. Adding',
    '  `Bash(rm:*)` to deny will silently override any matching allow rule.',
    '- Provider-specific costs are tracked in `~/.opencode/usage.json`.',
  ].join('\n') + '\n';
}

export const adapter: HostAdapter = {
  name: HOST_NAME,
  generateConfig: (spec: HarnessSpec) => {
    const out: Record<string, string> = {
      '.opencode/opencode.json': opencodeJson(spec),
      'install.md': installRunbook(spec),
    };
    // ADR-044: emit the system prompt + one file per agent.
    if (spec.systemPrompt || spec.description) out['AGENTS.md'] = agentsMarkdown(spec);
    for (const a of spec.agents ?? []) {
      out[`.opencode/agents/${a.name}.md`] = agentMarkdown(a);
    }
    return out;
  },
};

export default adapter;
