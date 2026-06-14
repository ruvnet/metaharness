// SPDX-License-Identifier: MIT
//
// @ruflo/host-hermes — Hermes Agent (NousResearch) host adapter.
//
// TWO DISTINCT PROJECTS — do not conflate:
//   1. https://github.com/NousResearch/Hermes-Function-Calling — OLDER
//      function-calling reference for Hermes 2/3 models. Parses
//      <tool_call>{"name":...,"arguments":{...}}</tool_call> ChatML tags.
//      No <think> block handling documented.
//   2. https://github.com/NousResearch/hermes-agent — CURRENT (v0.2+)
//      long-running agent runtime with persistent memory, scheduled
//      automations, and explicit MCP support (optional-mcps/ directory,
//      mcp_serve.py).
//
// This adapter targets (2) the current runtime. Surface:
//   - Docs: https://hermes-agent.nousresearch.com/docs/
//   - Install: curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
//   - Config: `hermes config set` and cli-config.yaml
//
// CRITICAL QUIRK: Hermes-4 models (e.g. NousResearch/Hermes-4-14B) emit
// <think>...</think> reasoning blocks AND occasionally raw <tool_call> text
// instead of using the OpenAI-compatible function-calling channel. See
// https://github.com/NousResearch/hermes-agent/issues/741.
//
// Therefore: scrubbing both <think> and stray <tool_call> text from
// assistant content is MANDATORY for this adapter. This mirrors ruflo's
// existing scrubReasoningBlocks() pattern in
// v3/@claude-flow/cli/src/mcp-tools/hooks-tools.ts.

import type { HostAdapter, HarnessSpec, McpServerSpec } from '@ruflo/kernel';

export const HOST_NAME = 'hermes' as const;

/**
 * Strip <think>...</think> and stray <tool_call>...</tool_call> blocks from
 * Hermes assistant content. Boundary-gated: only well-formed paired tags
 * are stripped, prose that merely mentions the tag names is left alone.
 *
 * Mirrors ruflo's scrubReasoningBlocks(). Per Hermes issue #741.
 */
export function scrubHermesBlocks(text: string): string {
  if (typeof text !== 'string' || text.indexOf('<') === -1) return text;
  // CodeQL js/polynomial-redos: `<think>[\s\S]*?</think>` is O(n²) on an
  // UNCLOSED tag — the lazy `[\s\S]*?` scans to EOF then backtracks looking
  // for the close tag at every position. Replaced with a tempered greedy
  // token `(?:(?!</tag>)[\s\S])*` which consumes each character exactly once
  // (linear) and still stops at the first close tag. An unclosed open tag
  // simply doesn't match (left in place) instead of triggering a backtrack.
  return text
    .replace(/<think>(?:(?!<\/think>)[\s\S])*<\/think>/gi, '')
    .replace(/<thinking>(?:(?!<\/thinking>)[\s\S])*<\/thinking>/gi, '')
    .replace(/<reasoning>(?:(?!<\/reasoning>)[\s\S])*<\/reasoning>/gi, '')
    .replace(/<tool_call>(?:(?!<\/tool_call>)[\s\S])*<\/tool_call>/gi, '');
}

/**
 * Hermes optional-mcps/ directory layout: one YAML file per MCP server
 * with `name`, `command`, `args`, `env`.
 */
export function optionalMcpYaml(server: McpServerSpec): string {
  const lines: string[] = [];
  lines.push(`name: ${server.name}`);
  if (server.command && server.command.length > 0) {
    lines.push(`command: ${server.command[0]}`);
    if (server.command.length > 1) {
      lines.push(`args:`);
      for (const arg of server.command.slice(1)) {
        lines.push(`  - ${JSON.stringify(arg)}`);
      }
    }
  } else if (server.url) {
    lines.push(`url: ${server.url}`);
  }
  if (server.env && server.env.length > 0) {
    lines.push(`env:`);
    for (const [k, v] of server.env) {
      lines.push(`  ${k}: ${JSON.stringify(v)}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Build cli-config.yaml content with the harness's system prompt + agents.
 */
export function cliConfigYaml(spec: HarnessSpec): string {
  const lines: string[] = [];
  lines.push(`name: ${spec.name}`);
  if (spec.description) lines.push(`description: ${JSON.stringify(spec.description)}`);
  if (spec.systemPrompt) lines.push(`system_prompt: ${JSON.stringify(spec.systemPrompt)}`);
  lines.push(`scrub_think_blocks: true`);
  lines.push(`scrub_stray_tool_calls: true`);
  return lines.join('\n') + '\n';
}

export const adapter: HostAdapter = {
  name: HOST_NAME,
  generateConfig: (spec: HarnessSpec) => {
    const out: Record<string, string> = {
      'cli-config.yaml': cliConfigYaml(spec),
    };
    for (const s of spec.mcpServers ?? []) {
      out[`optional-mcps/${s.name}.yaml`] = optionalMcpYaml(s);
    }
    return out;
  },
};

export default adapter;
