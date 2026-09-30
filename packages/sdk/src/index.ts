// SPDX-License-Identifier: MIT
//
// @metaharness/sdk — convenience helpers for harness authors.
//
// You CAN build a harness against @metaharness/kernel directly. This SDK gives
// you typed, validated, named definitions so your IDE catches typos before
// they reach the kernel + you don't have to remember the field names.
//
// Pattern: every define*() returns a frozen object suitable for direct
// inclusion in a HarnessSpec. Compose with `defineHarness({agents, skills,
// tools, mcpServers, hooks})` at the entry point.

export type Tier = 'codemod' | 'small' | 'frontier';

export interface AgentDef {
  readonly name: string;
  readonly systemPrompt: string;
  readonly tier: Tier;
  readonly description?: string;
}

export interface SkillDef {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export interface ToolDef {
  readonly name: string;
  readonly server: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly handler?: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface HookDef {
  readonly event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop' | 'SubagentStart' | 'SubagentStop' | 'FileChanged' | 'Setup';
  readonly matcher?: string;
  readonly handler: string;
}

export interface McpServerDef {
  readonly name: string;
  readonly command?: readonly string[];
  readonly url?: string;
  readonly env?: ReadonlyArray<readonly [string, string]>;
}

export interface HarnessDef {
  readonly name: string;
  readonly description?: string;
  readonly systemPrompt?: string;
  readonly agents: readonly AgentDef[];
  readonly skills: readonly SkillDef[];
  readonly tools: readonly ToolDef[];
  readonly hooks: readonly HookDef[];
  readonly mcpServers: readonly McpServerDef[];
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;

function ensureKebab(name: string, label: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`${label} name must be kebab-case [a-z0-9-], starting with a letter: got "${name}"`);
  }
  if (name.includes('--')) {
    throw new Error(`${label} name must not contain consecutive hyphens: got "${name}"`);
  }
  if (name.endsWith('-')) {
    throw new Error(`${label} name must not end with a hyphen: got "${name}"`);
  }
}

export function defineAgent(def: { name: string; systemPrompt: string; tier: Tier; description?: string }): AgentDef {
  ensureKebab(def.name, 'agent');
  if (!def.systemPrompt || def.systemPrompt.trim().length === 0) {
    throw new Error(`agent "${def.name}" requires a non-empty systemPrompt`);
  }
  if (def.tier !== 'codemod' && def.tier !== 'small' && def.tier !== 'frontier') {
    throw new Error(`agent "${def.name}" tier must be one of codemod|small|frontier: got "${def.tier}"`);
  }
  return Object.freeze({ ...def });
}

export function defineSkill(def: { name: string; description: string; body: string }): SkillDef {
  ensureKebab(def.name, 'skill');
  if (!def.description) throw new Error(`skill "${def.name}" requires a description`);
  if (!def.body) throw new Error(`skill "${def.name}" requires a body`);
  return Object.freeze({ ...def });
}

export function defineTool(def: { name: string; server: string; description: string; inputSchema: Record<string, unknown>; handler?: (args: Record<string, unknown>) => Promise<unknown> }): ToolDef {
  if (!def.name) throw new Error('tool name is required');
  if (!def.server) throw new Error(`tool "${def.name}" requires a server`);
  if (!def.description) throw new Error(`tool "${def.name}" requires a description`);
  if (!def.inputSchema || typeof def.inputSchema !== 'object') {
    throw new Error(`tool "${def.name}" inputSchema must be an object`);
  }
  return Object.freeze({ ...def });
}

export function defineHook(def: HookDef): HookDef {
  if (!def.event) throw new Error('hook event is required');
  if (!def.handler) throw new Error('hook handler is required');
  return Object.freeze({ ...def });
}

export function defineMcpServer(def: { name: string; command?: readonly string[]; url?: string; env?: ReadonlyArray<readonly [string, string]> }): McpServerDef {
  if (!def.name) throw new Error('mcp server name is required');
  if (!def.command && !def.url) throw new Error(`mcp server "${def.name}" requires either command or url`);
  if (def.command && def.url) throw new Error(`mcp server "${def.name}" cannot have both command and url`);
  return Object.freeze({ ...def });
}

export function defineHarness(def: {
  name: string;
  description?: string;
  systemPrompt?: string;
  agents?: readonly AgentDef[];
  skills?: readonly SkillDef[];
  tools?: readonly ToolDef[];
  hooks?: readonly HookDef[];
  mcpServers?: readonly McpServerDef[];
}): HarnessDef {
  ensureKebab(def.name, 'harness');
  // Detect name collisions across agents/skills/tools/mcpServers.
  const agentNames = new Set<string>();
  for (const a of def.agents ?? []) {
    if (agentNames.has(a.name)) throw new Error(`agent name collision: ${a.name}`);
    agentNames.add(a.name);
  }
  const skillNames = new Set<string>();
  for (const s of def.skills ?? []) {
    if (skillNames.has(s.name)) throw new Error(`skill name collision: ${s.name}`);
    skillNames.add(s.name);
  }
  const toolNames = new Set<string>();
  for (const t of def.tools ?? []) {
    if (toolNames.has(t.name)) throw new Error(`tool name collision: ${t.name}`);
    toolNames.add(t.name);
  }
  const mcpServerNames = new Set<string>();
  for (const m of def.mcpServers ?? []) {
    if (mcpServerNames.has(m.name)) throw new Error(`mcp server name collision: ${m.name}`);
    mcpServerNames.add(m.name);
  }
  return Object.freeze({
    name: def.name,
    description: def.description,
    systemPrompt: def.systemPrompt,
    agents: Object.freeze([...(def.agents ?? [])]),
    skills: Object.freeze([...(def.skills ?? [])]),
    tools: Object.freeze([...(def.tools ?? [])]),
    hooks: Object.freeze([...(def.hooks ?? [])]),
    mcpServers: Object.freeze([...(def.mcpServers ?? [])]),
  });
}
