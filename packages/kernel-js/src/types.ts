// SPDX-License-Identifier: MIT
//
// Shared types consumed by the host adapter packages. Defined separately
// from the runtime loader so adapters can `import type` without pulling
// the wasm/native loader into their bundle.

export interface McpServerSpec {
  name: string;
  command?: string[];
  url?: string;
  env?: Array<[string, string]>;
}

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface AgentSpec {
  name: string;
  systemPrompt?: string;
}

export interface HookSpec {
  event: string;
  matcher?: string;
  handler: string;
}

export interface HarnessSpec {
  name: string;
  description?: string;
  systemPrompt?: string;
  mcpServers?: McpServerSpec[];
  tools?: ToolSpec[];
  agents?: AgentSpec[];
  hooks?: HookSpec[];
  permissions?: { allow?: string[]; deny?: string[] };
  statusLine?: string;
  /**
   * Autonomous-mode fields (ADR-241 §2.2). Host adapters must project this
   * block per host or emit an explicit documented no-op — never silently drop.
   */
  autonomous?: {
    goal?: { text: string; tokenBudget?: number };
    heartbeat?: { cadence: string; instruction: string };
    gateCommand?: string;
    maxTurns?: number;
  };
}

export interface HostAdapter {
  name: string;
  /** Return a map of file-path -> file-content for the host's config. */
  generateConfig(spec: HarnessSpec): Record<string, string>;
}
