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
}

export interface HostAdapter {
  name: string;
  /** Return a map of file-path -> file-content for the host's config. */
  generateConfig(spec: HarnessSpec): Record<string, string>;
}
