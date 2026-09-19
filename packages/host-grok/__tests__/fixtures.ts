// SPDX-License-Identifier: MIT
//
// Shared fixtures for the ADR-280 host-grok contract tests. Kept in a
// non-.test.ts module so the golden-file test, the TOML-parse test and the
// real-grok `inspect` test consume the byte-identical spec.

import type { HarnessSpec } from '@metaharness/kernel';

/** The golden-file fixture: every HarnessSpec surface Grok can carry — 2
 * tools, 1 agent, a system prompt, a stdio server with env plus a remote
 * server, allow + deny rules, three hooks (helper, widened matcher, http),
 * and an autonomous block. */
export const defaultSpec: HarnessSpec = {
  name: 'demo',
  description: 'A repo-aware demo harness.',
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
    { name: 'remote', url: 'https://example.com/mcp' },
  ],
  permissions: {
    allow: ['mcp__codeindex__*', 'Bash(npm run:*)'],
    deny: ['Read(./.env)', 'Bash(rm:*)', 'Bash(git push:*)'],
  },
  hooks: [
    { event: 'SessionStart', handler: 'session-start' },
    { event: 'PreToolUse', matcher: 'Bash(rm *)', handler: 'guard' },
    { event: 'PostToolUse', matcher: 'Edit|Write', handler: 'https://hooks.example.com/grok' },
  ],
  autonomous: {
    goal: { text: 'Keep the test suite green', tokenBudget: 200000 },
    maxTurns: 40,
  },
};

/** Stable stringify used for the committed golden: top-level keys sorted via
 * the array-replacer form of JSON.stringify (values are all strings, so the
 * replacer only orders the top level). Same helper as host-prime-agent. */
export function stableStringify(config: Record<string, string>): string {
  return JSON.stringify(config, Object.keys(config).sort(), 2);
}
