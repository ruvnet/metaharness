// SPDX-License-Identifier: MIT
//
// Shared types for the browser-side harness generator. Mirrors the data model
// of packages/create-agent-harness so the UI emits artifacts that the CLI and
// the Claude marketplace would accept verbatim.

// iter 127 added 'copilot' (ADR-032); iter 128 added 'opencode' (ADR-036);
// iter 147 added 'github-actions' (ADR-033, first non-interactive host);
// 'prime-agent' added per ADR-247 (skills-only host, no MCP).
export type HostId = 'claude-code' | 'codex' | 'pi-dev' | 'hermes' | 'openclaw' | 'rvm' | 'copilot' | 'opencode' | 'github-actions' | 'prime-agent';

// Template ids come from the canonical catalog (e.g. "minimal",
// "vertical:coding"). Kept as a string so adding a template needs no type edit.
export type TemplateId = string;

export type MemoryBackend = 'agentdb' | 'sqlite' | 'in-memory';

export type RoutingStrategy = '3-tier' | 'single-tier';

export type MarketplaceMode = 'powered-by' | 'independent';

// ADR-171: model-tier configuration. The validated escalation ladder is a blend
// of three model tiers (ADR-154); the Studio lets the author pick each one.
export type ModelId =
  | 'deepseek/deepseek-v4-pro'
  | 'deepseek/deepseek-chat'
  | 'openai/gpt-5-mini'
  | 'openai/gpt-5'
  | 'anthropic/claude-haiku-4.5'
  | 'anthropic/claude-sonnet-4'
  | 'anthropic/claude-sonnet-4.6'
  | 'anthropic/claude-opus-4'
  | 'anthropic/claude-opus-4.8'
  | 'local/ollama';

/** Curated catalog for the model dropdowns: id → human label + one-line role.
 *  All ids verified available on OpenRouter (2026-06-22). */
export const MODEL_CATALOG: ReadonlyArray<{ id: ModelId; label: string; note: string }> = [
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', note: 'cheap, 1M ctx — default base' },
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', note: 'cheapest hosted' },
  { id: 'openai/gpt-5-mini', label: 'GPT-5 Mini', note: 'cheap frontier' },
  { id: 'openai/gpt-5', label: 'GPT-5', note: 'frontier' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', note: 'fast + cheap' },
  { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6', note: 'default Scholar tier' },
  { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4', note: 'prior Scholar' },
  { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8', note: 'default Sage tier — latest frontier' },
  { id: 'anthropic/claude-opus-4', label: 'Claude Opus 4', note: 'prior Sage' },
  { id: 'local/ollama', label: 'Local (Ollama)', note: '$0 — air-gapped, localhost' },
];

/** The three escalation tiers (ADR-148/152/154). */
export interface ModelTiers {
  barbarian: ModelId; // cheap base
  scholar: ModelId; // mid escalation (3-tier only)
  sage: ModelId; // frontier escalation (3-tier only)
}

export const DEFAULT_MODELS: ModelTiers = {
  barbarian: 'deepseek/deepseek-v4-pro',
  scholar: 'anthropic/claude-sonnet-4.6',
  sage: 'anthropic/claude-opus-4.8',
};

// ADR-071 mutation surfaces — the only files a Darwin variant may evolve.
export type MutationSurface =
  | 'planner' | 'contextBuilder' | 'reviewer' | 'retryPolicy'
  | 'toolPolicy' | 'memoryPolicy' | 'scorePolicy';

export const MUTATION_SURFACES: readonly MutationSurface[] = [
  'planner', 'contextBuilder', 'reviewer', 'retryPolicy', 'toolPolicy', 'memoryPolicy', 'scorePolicy',
];

export type DarwinSandbox = 'mock' | 'real' | 'agent';

/** ADR-070/170: Darwin self-evolution config. Frozen model, evolving harness. */
export interface DarwinConfig {
  enabled: boolean;
  surfaces: MutationSurface[];
  generations: number;
  sandbox: DarwinSandbox;
}

export const DEFAULT_DARWIN: DarwinConfig = {
  enabled: false,
  surfaces: ['planner', 'retryPolicy', 'toolPolicy'],
  generations: 10,
  sandbox: 'mock',
};

/** MCP server mode. `off` emits no MCP surface; `local` = stdio; `remote` = Streamable HTTP + auth. */
export type McpMode = 'off' | 'local' | 'remote';

/**
 * Security-first tool-execution policy for the generated MCP server. Every
 * field defaults to the safe option; the harness author opts INTO capability,
 * never out of safety. Emitted as both enforced TS (policy.ts) and inert data
 * (.harness/mcp-policy.json) so it can be scanned, audited, and witnessed.
 */
export interface McpPolicy {
  defaultDeny: boolean;
  allowNetwork: boolean;
  allowShell: boolean;
  allowFileWrite: boolean;
  requireApprovalForDangerous: boolean;
  toolTimeoutMs: number;
  maxToolCallsPerTurn: number;
  auditLog: boolean;
}

/** The composable primitives a harness can switch on (ADR-022). */
export interface Primitives {
  cli: boolean;
  mcp: McpMode;
  memory: boolean;
  learning: boolean;
  witness: boolean;
  releaseGates: boolean;
}

export const SAFE_MCP_POLICY: McpPolicy = {
  defaultDeny: true,
  allowNetwork: false,
  allowShell: false,
  allowFileWrite: false,
  requireApprovalForDangerous: true,
  toolTimeoutMs: 30_000,
  maxToolCallsPerTurn: 8,
  auditLog: true,
};

export const DEFAULT_PRIMITIVES: Primitives = {
  cli: true,
  mcp: 'local',
  memory: true,
  learning: false,
  witness: true,
  releaseGates: true,
};

/** A single file in a generated artifact tree. Path is POSIX, relative to root. */
export interface GenFile {
  path: string;
  content: string;
}

/** A catalog entry the user can toggle on/off (agent / skill / command). */
export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  /** Long-form body used when rendering the markdown artifact. */
  body: string;
  /** Optional tags for filtering / display. */
  tags?: string[];
}

export interface HostInfo {
  id: HostId;
  name: string;
  /** Short integration shape, e.g. "MCP + hooks + settings". */
  shape: string;
  color: string;
}

export interface TemplateInfo {
  id: TemplateId;
  /** Gallery grouping label, e.g. "Engineering", "Growth". */
  category: string;
  name: string;
  domain: string;
  description: string;
  /** Default `description` var when this template is chosen. */
  harnessDesc: string;
  /** One-line "what you get" blurb for the gallery card. */
  quickStart: string;
  tags: string[];
  /** Whether the CLI materialises an on-disk template dir for this id. */
  generate: boolean;
  /** Catalog ids pre-selected when this template is chosen. */
  defaultAgents: string[];
  defaultSkills: string[];
  defaultCommands: string[];
}

/** The full user-facing configuration captured by the form. */
export interface HarnessConfig {
  name: string;
  description: string;
  hosts: HostId[];
  template: TemplateId;
  memory: MemoryBackend;
  routing: RoutingStrategy;
  marketplace: MarketplaceMode;
  models: ModelTiers;
  darwin: DarwinConfig;
  agents: string[];
  skills: string[];
  commands: string[];
  primitives: Primitives;
  mcpPolicy: McpPolicy;
}
