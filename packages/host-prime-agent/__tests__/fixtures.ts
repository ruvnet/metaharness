// SPDX-License-Identifier: MIT
//
// Shared fixtures for the ADR-247 host-prime-agent contract tests. Kept in a
// non-.test.ts module so the golden-file generator and the test suite consume
// the byte-identical spec.

import type { HarnessSpec } from '@metaharness/kernel';

/** The golden-file fixture (ADR-247 test contract 3): 2 tools, 1 agent,
 * systemPrompt, 1 MCP server, allow+deny permissions. */
export const defaultSpec: HarnessSpec = {
  name: 'demo',
  systemPrompt: 'You are demo, a repo-aware agent.',
  tools: [
    {
      name: 'code-search',
      description: 'Search the repository codebase.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
    {
      name: 'run-tests',
      description: 'Run the harness test suite.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  agents: [{ name: 'reviewer', systemPrompt: 'Review code carefully.' }],
  mcpServers: [
    {
      name: 'codeindex',
      command: ['node', './dist/mcp-server.js'],
      env: [['LOG_LEVEL', 'info']],
    },
  ],
  permissions: {
    allow: ['Bash(npm run:*)'],
    deny: ['Bash(rm:*)', 'Bash(git push:*)'],
  },
};

/** Stable stringify used for the committed golden: top-level keys sorted via
 * the array-replacer form of JSON.stringify (values are all strings, so the
 * replacer only orders the top level). */
export function stableStringify(config: Record<string, string>): string {
  return JSON.stringify(config, Object.keys(config).sort(), 2);
}
