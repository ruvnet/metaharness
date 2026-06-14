// SPDX-License-Identifier: MIT
//
// Shared types for the browser-side harness generator. Mirrors the data model
// of packages/create-agent-harness so the UI emits artifacts that the CLI and
// the Claude marketplace would accept verbatim.

export type HostId = 'claude-code' | 'codex' | 'pi-dev' | 'hermes' | 'openclaw' | 'rvm';

// Template ids come from the canonical catalog (e.g. "minimal",
// "vertical:coding"). Kept as a string so adding a template needs no type edit.
export type TemplateId = string;

export type MemoryBackend = 'agentdb' | 'sqlite' | 'in-memory';

export type RoutingStrategy = '3-tier' | 'single-tier';

export type MarketplaceMode = 'powered-by' | 'independent';

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
  agents: string[];
  skills: string[];
  commands: string[];
  primitives: Primitives;
  mcpPolicy: McpPolicy;
}
