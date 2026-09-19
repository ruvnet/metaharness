// SPDX-License-Identifier: MIT
//
// @metaharness/host-grok — xAI Grok Build CLI (`grok`) host adapter, per
// ADR-280 (proposal: GH #279).
//
// Verified integration surface (grok 1.0.34 (3736acbc8658), macOS arm64,
// 2026-09-19; `grok inspect --json` under a throwaway HOME/GROK_HOME, plus the
// user guide the binary ships, cited as NN-file.md):
//   - Project config: `.grok/config.toml`. Grok reads ONLY `[mcp_servers]`,
//     `[plugins]`, `[permission]` and `[mcp] max_output_bytes` from a project
//     file (26-config-reference.md). `grok mcp add --scope project` writes the
//     same file: `command` + `args` + `enabled = true`, `env`/`headers` as
//     sub-tables, no `type` key for HTTP (`type = "sse"` only for SSE).
//   - `[permission]` takes the compact `allow`/`deny`/`ask` string arrays in
//     Claude Code rule syntax (`Bash(rm:*)`, `Read(./.env)`, `Write(*)`,
//     `mcp__server__*`, `MCPTool(server__*)`); deny > ask > allow across every
//     source (22-permissions-and-safety.md). The exact rule set the CLI
//     scaffold emits loads 7/7. Rules naming a tool Grok does not know
//     (`Task(*)`, `Agent(…)`, `MultiEdit(*)`, `NotebookEdit(*)`, `LS(*)`) load
//     0 rules and are NOT reported as skipped, so they are named in the
//     runbook instead of being silently lost.
//   - Instructions: AGENTS.md (and CLAUDE.md) in every directory from the repo
//     root to the cwd (12-project-rules.md). Skills: `.grok/skills/<n>/SKILL.md`
//     (`name` + `description` frontmatter). Subagents: `.grok/agents/<n>.md`
//     (`name` is required; a file without it is dropped). Hooks:
//     `.grok/hooks/*.json`, the Claude Code three-level JSON shape with
//     `command` and `http` handlers only (10-hooks.md).
//   - FOLDER TRUST: on an untrusted folder Grok loads none of the project's
//     instructions, skills, hooks or `[permission]` rules, and does not start
//     project MCP servers (`grok inspect`: `projectTrusted: false`,
//     `projectInstructions: []`, `hooks: []`, `permissions.loaded: 0`). A
//     fresh scaffold is untrusted by definition. `grok --trust inspect`
//     records trust in `~/.grok/trusted_folders.toml`; `GROK_FOLDER_TRUST=0`
//     turns the gate off for one process; `--deny` flags are always enforced.
//   - MCP tools are namespaced `server__tool` (no `mcp__` prefix). A server
//     name must start with a letter or `_`, use only [A-Za-z0-9_-], contain no
//     `__` and not end in `_`, or its tools never enter the catalog
//     (07-mcp-servers.md "What Grok admits").
//
// FAIL-CLOSED RULE (ADR-280 §2.2, the ADR-046/ADR-247 bug class): because an
// emitted deny-list is inert until the folder is trusted, the install runbook
// OPENS with a trust banner that names every deny rule, and its headless
// invocation repeats each deny rule as a `--deny` flag. Every HarnessSpec
// field without a Grok surface is named in the runbook, never dropped.
//
// All renderers are pure and byte-deterministic (no dates, no randomness);
// the golden-file contract test depends on it.

import type { AgentSpec, HarnessSpec, HookSpec, HostAdapter, McpServerSpec, ToolSpec } from '@metaharness/kernel';

export const HOST_NAME = 'grok' as const;

/** Grok version every VERIFIED claim in this package was observed on. */
export const VERIFIED_GROK_VERSION = '1.0.34';

/** Project config path Grok reads (and `grok mcp add --scope project` writes). */
export const CONFIG_TOML = '.grok/config.toml';

/** Runbook filename — host-qualified so multi-host scaffolds don't collide
 * (host-opencode/host-copilot already own `install.md`; ADR-247 precedent). */
export const INSTALL_MD = 'install-grok.md';

/** The 15 hook events Grok documents (10-hooks.md "Hook Events"). */
export const GROK_HOOK_EVENTS: readonly string[] = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Stop',
  'StopFailure',
  'StopCancelled',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
];

/** Rule strings in Grok's documented permission vocabulary
 * (22-permissions-and-safety.md "Tool Names" + "MCP Rules"). */
const GROK_RULE = /^(?:\*|mcp__[\s\S]*|(?:Bash|Read|Edit|Write|Grep|Glob|MCPTool|WebFetch|WebSearch)(?:\([\s\S]*\))?)$/;

// ---------------------------------------------------------------------------
// Escaping helpers
// ---------------------------------------------------------------------------

/**
 * Render a TOML 1.0 basic string. Escapes `"` and `\`, uses the short forms
 * for \b \t \n \f \r, `\uXXXX` for the other control characters (U+0000–U+001F
 * and U+007F are not allowed raw), and replaces a lone UTF-16 surrogate with
 * U+FFFD (a surrogate is not a Unicode scalar value, so TOML rejects it even
 * escaped). Every spec-derived string value in the emitted TOML goes through
 * here — the host-codex renderer only escaped five characters.
 */
export function tomlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    else if (cp >= 0xd800 && cp <= 0xdfff) out += '\\uFFFD';
    else out += ch;
  }
  return `${out}"`;
}

/** A TOML key: bare when it is a valid bare key, a quoted basic string otherwise. */
export function tomlKey(s: string): string {
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : tomlString(s);
}

/** Make a string safe for a single `#` comment line (TOML forbids control
 * characters other than tab in comments; a newline would end the comment). */
function commentSafe(s: string): string {
  return s.replace(/[\u0000-\u0008\u000a-\u001f\u007f]+/g, ' ');
}

/** Single-line YAML double-quoted scalar (frontmatter). */
function yamlQuoted(s: string): string {
  const flat = s
    .replace(/[\u0000-\u0008\u000a-\u001f\u007f]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `"${flat}"`;
}

/** Truncate without splitting a surrogate pair. */
function truncate(s: string, max: number): string {
  let t = s.slice(0, max);
  const last = t.charCodeAt(t.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
  return t;
}

/** One-line text for a markdown heading or list item. */
function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

/** Markdown inline code that survives backticks in the value. */
function mdCode(s: string): string {
  const flat = oneLine(s);
  const runs = [...flat.matchAll(/`+/g)].map((m) => m[0].length);
  const fence = '`'.repeat(Math.max(0, ...runs) + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/** A fenced markdown block whose fence is longer than any backtick run inside. */
function mdFence(body: string, lang = ''): string[] {
  const runs = [...body.matchAll(/`{3,}/g)].map((m) => m[0].length);
  const fence = '`'.repeat(Math.max(3, Math.max(0, ...runs) + 1));
  return [`${fence}${lang}`, body, fence];
}

/** POSIX single-quote one shell argument. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Normalize a HarnessSpec MCP server name to one Grok admits into its tool
 * catalog (07-mcp-servers.md): characters outside [A-Za-z0-9_-] become `-`,
 * `__` collapses to `_` (it is the `server__tool` delimiter), a leading `-` is
 * dropped, a leading digit gets an `mcp-` prefix, trailing `-`/`_` are
 * trimmed (a trailing `_` would form `___`), and the result is capped at 64
 * characters. Identity for ordinary names (`demo-bot`, `code_index`).
 */
export function normalizeServerName(raw: string): string {
  let s = raw
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/_{2,}/g, '_')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '');
  if (/^[0-9]/.test(s)) s = `mcp-${s}`;
  s = s.slice(0, 64).replace(/[-_]+$/, '');
  return s || 'mcp';
}

/**
 * Normalize a tool/agent name to a skill/agent file name (`^[a-z0-9-]+$`,
 * ≤ 64 characters — Grok's SKILL.md `name` rule, 08-skills.md). Deterministic;
 * an input that normalizes to nothing yields `fallback`.
 */
export function normalizeSkillName(raw: string, fallback = 'tool'): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return s || fallback;
}

/** Collision-safe naming in spec order: the first keeps the base, later
 * collisions get `-2`, `-3`, … (a flat file map would otherwise overwrite). */
function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  for (let n = 2; used.has(name); n++) {
    const suffix = `-${n}`;
    name = `${base.slice(0, 64 - suffix.length).replace(/[-_]+$/, '')}${suffix}`;
  }
  used.add(name);
  return name;
}

// ---------------------------------------------------------------------------
// .grok/config.toml
// ---------------------------------------------------------------------------

/**
 * Header comment for `.grok/config.toml`. Byte-identical with the CLI scaffold
 * (`packages/create-agent-harness/src/host-config.ts`) and the web UI
 * (`apps/web-ui/src/generator/scaffold.ts`) — ADR-027 parity.
 */
export function configHeader(name: string): string {
  return [
    `# ${commentSafe(name)} — Grok Build project config (metaharness host: grok, ADR-280).`,
    '# Grok starts these servers and applies these rules only in a trusted folder; see install-grok.md.',
  ].join('\n');
}

/**
 * Render one MCP server as a `[mcp_servers.<name>]` table in the shape
 * `grok mcp add --scope project` writes. Returns null for a server with
 * neither `command` nor `url` (Grok drops such an entry without a transport,
 * verified: it is absent from `grok mcp list` and `grok inspect`).
 */
export function serverToToml(s: McpServerSpec, name: string = normalizeServerName(s.name)): string | null {
  const key = `mcp_servers.${tomlKey(name)}`;
  const lines = [`[${key}]`];
  if (s.command && s.command.length > 0) {
    lines.push(`command = ${tomlString(s.command[0]!)}`);
    if (s.command.length > 1) lines.push(`args = [${s.command.slice(1).map(tomlString).join(', ')}]`);
  } else if (s.url) {
    // No `type` key: Grok infers HTTP from `url` and writes none itself.
    lines.push(`url = ${tomlString(s.url)}`);
  } else {
    return null;
  }
  lines.push('enabled = true');
  if (s.env && s.env.length > 0) {
    // A repeated key is a TOML error; keep the last value (shell semantics).
    const env = new Map<string, string>();
    for (const [k, v] of s.env) env.set(k, v);
    lines.push('', `[${key}.env]`);
    for (const [k, v] of env) lines.push(`${tomlKey(k)} = ${tomlString(v)}`);
  }
  return lines.join('\n');
}

/** Render `[permission]` with one rule per line; null when both lists are empty. */
export function permissionToml(permissions: HarnessSpec['permissions']): string | null {
  const allow = permissions?.allow ?? [];
  const deny = permissions?.deny ?? [];
  if (allow.length === 0 && deny.length === 0) return null;
  const lines = ['[permission]'];
  const list = (key: string, rules: string[]) => {
    if (rules.length > 0) lines.push(`${key} = [`, ...rules.map((r) => `  ${tomlString(r)},`), ']');
  };
  list('allow', allow);
  list('deny', deny);
  return lines.join('\n');
}

interface ServerPlan {
  spec: McpServerSpec;
  name: string;
  toml: string | null;
}

function planServers(spec: HarnessSpec): ServerPlan[] {
  const used = new Set<string>();
  return (spec.mcpServers ?? []).map((s) => {
    const name = uniqueName(normalizeServerName(s.name), used);
    return { spec: s, name, toml: serverToToml(s, name) };
  });
}

/** The full `.grok/config.toml`: header, MCP server tables, `[permission]`. */
export function configToml(spec: HarnessSpec): string {
  const blocks = [configHeader(spec.name)];
  for (const p of planServers(spec)) if (p.toml) blocks.push(p.toml);
  const perm = permissionToml(spec.permissions);
  if (perm) blocks.push(perm);
  return `${blocks.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// Hooks — .grok/hooks/<harness>.json
// ---------------------------------------------------------------------------

export type GrokHookHandler =
  | { type: 'command'; command: string }
  | { type: 'http'; url: string };

/** Helper names that are safe to splice into a shell command line. */
const SAFE_HELPER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Map a kernel HookSpec `handler` onto a Grok hook handler. Grok supports
 * `command` and `http` only (10-hooks.md), so the ADR-044 prefix handlers
 * host-claude-code maps (`mcp:`, `prompt:`, `agent:`) have no Grok analogue.
 * A plain helper name resolves to the SAME user-supplied file host-claude-code
 * references (`.claude/helpers/<name>.cjs`), so one helper serves both hosts;
 * the path is anchored at `$GROK_WORKSPACE_ROOT` (injected into every hook
 * process) because how Grok resolves a relative path inside an inline command
 * is undocumented. Returns `{ unsupported }` with the reason otherwise.
 */
export function hookHandlerFor(handler: string): GrokHookHandler | { unsupported: string } {
  if (/^https?:\/\//i.test(handler)) return { type: 'http', url: handler };
  const prefix = /^(mcp|prompt|agent):/.exec(handler);
  if (prefix) {
    return { unsupported: `\`${prefix[1]}:\` handlers have no Grok hook type (Grok runs \`command\` and \`http\` hooks only)` };
  }
  if (!SAFE_HELPER.test(handler) || handler.includes('..')) {
    return { unsupported: 'the helper name is not a plain file name ([A-Za-z0-9._-]), so it is not spliced into a shell command' };
  }
  return { type: 'command', command: `node "$GROK_WORKSPACE_ROOT/.claude/helpers/${handler}.cjs"` };
}

/**
 * Translate a kernel matcher into Grok's: Grok compiles `matcher` as a regular
 * expression over the tool name (aliasing Claude names such as `Bash`), and an
 * empty or omitted matcher matches everything. So `*`/empty are omitted, and a
 * permission-rule-style `Tool(args)` keeps only `Tool` — the argument
 * predicate cannot be expressed and is reported as widened.
 */
export function grokMatcher(matcher: string | undefined): { matcher?: string; droppedPredicate?: string } {
  if (matcher === undefined) return {};
  const t = matcher.trim();
  if (t === '' || t === '*') return {};
  const call = /^([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/.exec(t);
  if (call) return { matcher: call[1]!, droppedPredicate: call[2]! };
  return { matcher: t };
}

interface HookPlan {
  json: string | null;
  count: number;
  unsupported: string[];
  widened: string[];
}

function planHooks(hooks: HookSpec[]): HookPlan {
  const events: Record<string, Array<{ matcher?: string; hooks: GrokHookHandler[] }>> = {};
  const unsupported: string[] = [];
  const widened: string[] = [];
  let count = 0;
  for (const h of hooks) {
    const event = h.event === 'SubagentEnd' ? 'SubagentStop' : h.event; // documented alias
    const label = `${mdCode(h.event)} → ${mdCode(h.handler)}`;
    if (!GROK_HOOK_EVENTS.includes(event)) {
      unsupported.push(`${label}: Grok has no ${mdCode(h.event)} hook event.`);
      continue;
    }
    const handler = hookHandlerFor(h.handler);
    if ('unsupported' in handler) {
      unsupported.push(`${label}: ${handler.unsupported}.`);
      continue;
    }
    const m = grokMatcher(h.matcher);
    if (m.droppedPredicate !== undefined) {
      widened.push(`${label}: matcher ${mdCode(h.matcher!)} is emitted as ${mdCode(m.matcher!)}; the argument predicate ${mdCode(m.droppedPredicate)} cannot be expressed in a Grok matcher, so the hook runs for every ${mdCode(m.matcher!)} call and the helper must filter.`);
    }
    (events[event] ??= []).push(m.matcher !== undefined ? { matcher: m.matcher, hooks: [handler] } : { hooks: [handler] });
    count++;
  }
  return { json: count > 0 ? `${JSON.stringify({ hooks: events }, null, 2)}\n` : null, count, unsupported, widened };
}

/** `.grok/hooks/<harness>.json` content, or null when no hook maps to Grok. */
export function hooksJson(spec: HarnessSpec): string | null {
  return planHooks(spec.hooks ?? []).json;
}

// ---------------------------------------------------------------------------
// Instructions, agents, skills
// ---------------------------------------------------------------------------

/**
 * AGENTS.md: harness name, description, system prompt and agent roster (the
 * host-codex ADR-044 shape), plus how Grok names the harness MCP tools.
 */
export function agentsMarkdown(spec: HarnessSpec, serverNames: string[] = planServers(spec).filter((p) => p.toml).map((p) => p.name)): string {
  const lines: string[] = [`# ${oneLine(spec.name)}`, ''];
  if (spec.description) lines.push(spec.description, '');
  if (spec.systemPrompt) lines.push(spec.systemPrompt, '');
  if (spec.agents && spec.agents.length > 0) {
    lines.push('## Agents', '');
    for (const a of spec.agents) lines.push(`### ${oneLine(a.name)}`, '', a.systemPrompt ?? '', '');
  }
  if (serverNames.length > 0) {
    lines.push(
      '## MCP tools',
      '',
      'Grok exposes MCP tools as `<server>__<tool>` (no `mcp__` prefix). Find',
      'them with `search_tool` and call them with `use_tool`. This harness',
      'registers:',
      '',
      ...serverNames.map((n) => `- ${mdCode(`${n}__*`)}`),
      '',
    );
  }
  return lines.join('\n');
}

/** `.grok/agents/<name>.md` — a Grok subagent definition (`name` is required). */
export function agentMd(a: AgentSpec, resolvedName: string = normalizeSkillName(a.name, 'agent')): string {
  const description = truncate(oneLine(a.systemPrompt ?? `Agent: ${a.name}`), 200);
  return [
    '---',
    `name: ${resolvedName}`,
    `description: ${yamlQuoted(description)}`,
    '---',
    '',
    a.systemPrompt ?? `You are the ${oneLine(a.name)} agent.`,
    '',
  ].join('\n');
}

/**
 * `.grok/skills/<name>/SKILL.md` — instruction-only (ADR-247 doctrine):
 * `ToolSpec` is declarative metadata with no execution binding, so the skill
 * documents the contract and never claims to execute it.
 */
export function skillMd(tool: ToolSpec, resolvedName: string = normalizeSkillName(tool.name)): string {
  const description = truncate(oneLine(tool.description ?? `Harness tool ${tool.name}`), 1024);
  return [
    '---',
    `name: ${resolvedName}`,
    `description: ${yamlQuoted(description)}`,
    '---',
    '',
    `# ${resolvedName}`,
    '',
    description,
    '',
    'Generated by @metaharness/host-grok (ADR-280). The HarnessSpec tool entry',
    'is a declarative contract, not an executable binding. Use a harness MCP',
    `tool (\`<server>__<tool>\`, found with \`search_tool\`) or another available`,
    `capability that implements ${mdCode(tool.name)} with the schema below. If none is`,
    'available, say that the operation is unavailable; do not claim it ran.',
    '',
    '## Input schema',
    '',
    ...mdFence(JSON.stringify(tool.inputSchema ?? {}, null, 2), 'json'),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// install-grok.md
// ---------------------------------------------------------------------------

interface RunbookContext {
  servers: ServerPlan[];
  hooks: HookPlan;
  hookFile: string | null;
  agentFiles: string[];
  skillFiles: string[];
  agentsMd: boolean;
}

/** The trust banner: what stays inert until the folder is trusted. */
function trustBanner(spec: HarnessSpec, ctx: RunbookContext): string[] {
  const inert: string[] = [];
  if (ctx.agentsMd) inert.push('`AGENTS.md` instructions');
  if (ctx.servers.some((p) => p.toml)) inert.push('the `[mcp_servers]` in `.grok/config.toml`');
  if (permissionToml(spec.permissions)) inert.push('the `[permission]` rules in `.grok/config.toml`');
  if (ctx.skillFiles.length > 0) inert.push('`.grok/skills/`');
  if (ctx.hookFile) inert.push(`\`${ctx.hookFile}\``);
  if (inert.length === 0) return [];
  const deny = spec.permissions?.deny ?? [];
  const lines = [
    '> **ACTION REQUIRED: trust this folder before relying on it.** Grok Build',
    '> loads a project\'s instructions, skills, hooks and `[permission]` rules,',
    '> and starts its MCP servers, only after the folder is trusted. Verified',
    `> on grok ${VERIFIED_GROK_VERSION}: on a fresh checkout \`grok inspect\` reports`,
    '> `projectTrusted: false` and loads none of them. Inert until trusted:',
    ...inert.map((i) => `> - ${i}`),
  ];
  if (deny.length > 0) {
    lines.push(
      '>',
      '> Until then these deny rules are **not enforced** (pass them as `--deny`',
      '> flags, section 4, to enforce them without trust):',
      ...deny.map((d) => `> - ${mdCode(d)}`),
    );
  }
  lines.push('>', '> Review the files, then trust the folder (section 2).', '');
  return lines;
}

/** `--deny` flags for every deny rule, shell-quoted. */
function denyFlags(spec: HarnessSpec): string {
  return (spec.permissions?.deny ?? []).map((d) => ` --deny ${shellQuote(d)}`).join('');
}

/**
 * Install runbook: install, trust, verify with `grok inspect`, run (headless
 * with `--deny` flags), then every surface that is renamed, widened or not
 * projected. Opens with the trust banner (ADR-280 §2.2).
 */
export function installMd(spec: HarnessSpec): string {
  return buildPlan(spec).files[INSTALL_MD]!;
}

function renderInstallMd(spec: HarnessSpec, ctx: RunbookContext): string {
  const name = oneLine(spec.name);
  const allow = spec.permissions?.allow ?? [];
  const deny = spec.permissions?.deny ?? [];
  const emitted = ctx.servers.filter((p) => p.toml);
  const lines: string[] = [`# Installing ${name} into Grok Build`, ''];
  lines.push(...trustBanner(spec, ctx));

  lines.push(
    '## 1. Install Grok Build',
    '',
    '```bash',
    'curl -fsSL https://x.ai/cli/install.sh | bash',
    `grok --version   # this adapter was verified against grok ${VERIFIED_GROK_VERSION}`,
    'grok login',
    '```',
    '',
    '## 2. Trust the folder and check what loaded',
    '',
    'From the harness root (after reviewing `.grok/` and `AGENTS.md`):',
    '',
    '```bash',
    'grok --trust inspect',
    '```',
    '',
    '`--trust` records the folder in `~/.grok/trusted_folders.toml`; `inspect`',
    'then lists what Grok loaded without starting a session. You can also',
    'grant trust inside the TUI with `/hooks-trust`. For CI, `GROK_FOLDER_TRUST=0`',
    'turns the folder-trust gate off for that one process.',
    '',
    'Expected in the `grok inspect` output:',
    '',
  );
  const expect: string[] = [];
  if (ctx.agentsMd) expect.push('Project Instructions: `AGENTS.md` (printed as `Agents.md` on a case-insensitive disk), plus `CLAUDE.md` if the harness has one; Grok loads both');
  for (const p of emitted) expect.push(`MCP Servers: ${mdCode(p.name)} (${p.spec.command && p.spec.command.length > 0 ? 'stdio' : 'http'})`);
  const known = [...allow, ...deny].filter((r) => GROK_RULE.test(r)).length;
  if (allow.length + deny.length > 0) expect.push(`Permissions: source \`.grok/config.toml\`, ${known} loaded`);
  for (const f of ctx.agentFiles) expect.push(`Agents: ${mdCode(f.replace(/^\.grok\/agents\//, '').replace(/\.md$/, ''))}`);
  for (const f of ctx.skillFiles) expect.push(`Skills: ${mdCode(f.replace(/^\.grok\/skills\//, '').replace(/\/SKILL\.md$/, ''))}`);
  if (ctx.hookFile) expect.push(`Hooks: ${ctx.hooks.count} from \`.grok/hooks\``);
  if (expect.length === 0) expect.push('Nothing harness-specific: this spec declares no Grok surfaces.');
  lines.push(...expect.map((e) => `- ${e}`), '');

  lines.push('## 3. MCP servers', '');
  if (emitted.length === 0 && ctx.servers.length === 0) {
    lines.push('This harness declares no MCP servers.', '');
  } else {
    if (emitted.length > 0) {
      lines.push(
        'Registered in `.grok/config.toml`. Grok names their tools',
        '`<server>__<tool>`; `grok mcp doctor <server>` starts a server and checks',
        'its handshake.',
        '',
        ...emitted.map((p) => `- ${mdCode(p.name)}: ${p.spec.command && p.spec.command.length > 0 ? `stdio, ${mdCode(p.spec.command.join(' '))}` : `http, ${mdCode(p.spec.url!)}`}`),
        '',
      );
    }
    const renamed = ctx.servers.filter((p) => p.name !== p.spec.name);
    if (renamed.length > 0) {
      lines.push(
        'Renamed so Grok admits their tools (server names use `[A-Za-z0-9_-]`,',
        'start with a letter or `_`, contain no `__` and do not end in `_`).',
        'Permission rules and prompts must use the new names:',
        '',
        ...renamed.map((p) => `- ${mdCode(p.spec.name)} → ${mdCode(p.name)}`),
        '',
      );
    }
    const skipped = ctx.servers.filter((p) => !p.toml);
    if (skipped.length > 0) {
      lines.push(
        'Not emitted (neither `command` nor `url`; Grok drops such entries):',
        '',
        ...skipped.map((p) => `- ${mdCode(p.spec.name)}`),
        '',
      );
    }
    const withEnv = emitted.filter((p) => (p.spec.env?.length ?? 0) > 0);
    if (withEnv.length > 0) {
      lines.push(
        '`env` values are written verbatim into `.grok/config.toml`, which is',
        'meant to be committed. Put secrets in the environment and reference',
        'them as `${VAR}` (Grok expands `${VAR}` in `env` at load time);',
        '`grok mcp list --json` prints `env` values in cleartext.',
        '',
        ...withEnv.map((p) => `- ${mdCode(p.name)}: ${(p.spec.env ?? []).map(([k]) => mdCode(k)).join(', ')}`),
        '',
      );
    }
  }

  lines.push('## 4. Permissions and headless runs', '');
  if (allow.length + deny.length > 0) {
    lines.push(
      `\`.grok/config.toml\` carries ${allow.length} allow and ${deny.length} deny rules in the`,
      '`[permission]` table. Grok merges rules from every trusted source and',
      'evaluates `deny` before `ask` before `allow`.',
      '',
    );
    const unknown = [...allow, ...deny].filter((r) => !GROK_RULE.test(r));
    if (unknown.length > 0) {
      lines.push(
        'These rules name tools outside Grok\'s rule vocabulary (`Bash`, `Read`,',
        '`Edit`, `Write`, `Grep`, `Glob`, `MCPTool`, `WebFetch`, `WebSearch`,',
        `\`mcp__…\`, \`*\`). On grok ${VERIFIED_GROK_VERSION} such rules load nothing and are not`,
        'reported as skipped, so enforce them another way (a `PreToolUse` hook or',
        'the sandbox):',
        '',
        ...unknown.map((r) => `- ${mdCode(r)}`),
        '',
      );
    }
  } else {
    lines.push('This harness declares no permission rules.', '');
  }
  lines.push(
    '`--deny` flags are enforced whether or not the folder is trusted, so a',
    'headless run should repeat the deny rules:',
    '',
    '```bash',
    `grok -p '<task>'${denyFlags(spec)}`,
    '```',
    '',
  );

  if (ctx.hookFile || ctx.hooks.unsupported.length > 0) {
    lines.push('## 5. Hooks', '');
    if (ctx.hookFile) {
      lines.push(
        `\`${ctx.hookFile}\` registers ${ctx.hooks.count} hook(s). Command hooks run`,
        '`node "$GROK_WORKSPACE_ROOT/.claude/helpers/<name>.cjs"`, the same helper',
        'file the Claude Code adapter references; supply it yourself. Grok sends',
        'the event as JSON on stdin and fails open on a crash or timeout, so a',
        'guard must print an explicit `{"decision": "deny", "reason": "…"}`.',
        'If the harness also ships `.claude/settings.json` hooks, Grok loads',
        'those too; set `GROK_CLAUDE_HOOKS_ENABLED=false` to run only these.',
        '',
      );
    }
    if (!ctx.hookFile) {
      lines.push('No declared hook maps to a Grok hook; each is listed under "Unsupported on this host".', '');
    }
    if (ctx.hooks.widened.length > 0) {
      lines.push('Widened matchers:', '', ...ctx.hooks.widened.map((w) => `- ${w}`), '');
    }
  }

  lines.push(
    '## Claude Code files in the same harness',
    '',
    'Grok\'s `[compat.claude]` layer (on by default) also loads, once the folder',
    'is trusted: `CLAUDE.md` next to `AGENTS.md`, `.claude/skills/*/SKILL.md`,',
    '`.claude/commands/*.md`, and the `permissions` and `hooks` of',
    '`.claude/settings.json`. It does **not** read `mcpServers` from',
    '`.claude/settings.json`, which is why the MCP servers live in',
    '`.grok/config.toml`.',
    '',
  );

  // Fields with no Grok surface are named, never silently dropped (ADR-044
  // capability coverage; ADR-247 test contract 5).
  const unsupported: string[] = [...ctx.hooks.unsupported.map((u) => `hook ${u}`)];
  if (spec.statusLine) {
    unsupported.push(`\`statusLine\` (${mdCode(spec.statusLine)}): Grok's status line is user-level only (\`[ui.status_line]\` in \`~/.grok/config.toml\`, \`type = "command"\`, \`command = …\`); a project config cannot set it.`);
  }
  if (unsupported.length > 0) {
    lines.push(
      '## Unsupported on this host',
      '',
      'These harness spec fields have no Grok surface and are **not** projected',
      '(listed so nothing is silently dropped):',
      '',
      ...unsupported.map((u) => `- ${u}`),
      '',
    );
  }

  // ADR-246 §2.2 autonomous block: project what Grok has, disclose the rest.
  const auto = spec.autonomous;
  if (auto) {
    lines.push('## Autonomous mode (ADR-246)', '');
    if (auto.maxTurns !== undefined) {
      lines.push(
        '`maxTurns` maps to `--max-turns`:',
        '',
        '```bash',
        `grok -p ${shellQuote(auto.goal?.text ?? '<task>')} --max-turns ${auto.maxTurns}${denyFlags(spec)}`,
        '```',
        '',
      );
    }
    if (auto.goal) {
      const budget = auto.goal.tokenBudget !== undefined ? ` --budget ${auto.goal.tokenBudget}` : '';
      lines.push('`goal` maps to Grok\'s goal mode; in the TUI run:', '', ...mdFence(`/goal ${oneLine(auto.goal.text)}${budget}`), '');
    }
    if (auto.heartbeat) {
      lines.push('`heartbeat` maps to `/loop [interval] <prompt>`; in the TUI run:', '', ...mdFence(`/loop ${oneLine(auto.heartbeat.cadence)} ${oneLine(auto.heartbeat.instruction)}`), '');
    }
    if (auto.maxTurns === undefined && !auto.goal && !auto.heartbeat && !auto.gateCommand) {
      lines.push('The `autonomous` block declares no fields; nothing to project.', '');
    }
    if (auto.gateCommand) {
      lines.push(
        `\`gateCommand\` (${mdCode(auto.gateCommand)}) is **not projected** (documented no-op).`,
        'A Grok `Stop` hook can keep a turn going, but only exit code 2 or a',
        '`{"decision": "block"}` answer blocks; any other failure fails open, so',
        'a plain gate command cannot be wired as a hook without a wrapper.',
        '',
      );
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function buildPlan(spec: HarnessSpec): { ctx: RunbookContext; files: Record<string, string> } {
  const files: Record<string, string> = {};
  const servers = planServers(spec);
  files[CONFIG_TOML] = configToml(spec);

  const emittedNames = servers.filter((p) => p.toml).map((p) => p.name);
  const agentsMd = Boolean(spec.systemPrompt || spec.description || (spec.agents?.length ?? 0) > 0 || emittedNames.length > 0);
  if (agentsMd) files['AGENTS.md'] = agentsMarkdown(spec, emittedNames);

  const usedAgents = new Set<string>();
  const agentFiles: string[] = [];
  for (const a of spec.agents ?? []) {
    const n = uniqueName(normalizeSkillName(a.name, 'agent'), usedAgents);
    const path = `.grok/agents/${n}.md`;
    files[path] = agentMd(a, n);
    agentFiles.push(path);
  }

  const usedSkills = new Set<string>();
  const skillFiles: string[] = [];
  for (const t of spec.tools ?? []) {
    const n = uniqueName(normalizeSkillName(t.name), usedSkills);
    const path = `.grok/skills/${n}/SKILL.md`;
    files[path] = skillMd(t, n);
    skillFiles.push(path);
  }

  const hooks = planHooks(spec.hooks ?? []);
  const hookFile = hooks.json ? `.grok/hooks/${normalizeSkillName(spec.name, 'harness')}.json` : null;
  if (hookFile) files[hookFile] = hooks.json!;

  const ctx: RunbookContext = { servers, hooks, hookFile, agentFiles, skillFiles, agentsMd };
  files[INSTALL_MD] = renderInstallMd(spec, ctx);
  return { ctx, files };
}

export const adapter: HostAdapter = {
  name: HOST_NAME,
  generateConfig: (spec: HarnessSpec) => buildPlan(spec).files,
};

export default adapter;
