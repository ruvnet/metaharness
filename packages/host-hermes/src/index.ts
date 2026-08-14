// SPDX-License-Identifier: MIT
//
// @metaharness/host-hermes — Hermes Agent (NousResearch) host adapter.
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

import type { HostAdapter, HarnessSpec, McpServerSpec } from '@metaharness/kernel';

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
 * Escape a string for use as a YAML double-quoted flow scalar. JSON string
 * syntax is a valid subset of YAML double-quoted scalar syntax, so
 * `JSON.stringify` is sufficient and matches this file's existing
 * `args`/`env`-value escaping (below).
 */
function yamlStr(s: string): string {
  return JSON.stringify(s.replace(/[\r\n]+/g, ' '));
}

// YAML 1.1 core-schema bare scalars that a PyYAML-family loader (Hermes is
// Python) resolves to bool/null instead of a string — adversarial-critique
// finding: these match the identifier regex below but are NOT safe to leave
// bare (a personality literally named `true` or `123` would be silently
// mistyped, not a syntax break but a semantic one).
const YAML_RESERVED_BARE = /^(?:null|~|true|false|yes|no|on|off|[+-]?\d+(?:\.\d+)?)$/i;

/**
 * Escape a string for use as a YAML *mapping key*. Values interpolated
 * into a key position (e.g. `agent.personalities.<name>`, an MCP server's
 * `env` var name) are NOT scalar values and were previously written
 * unquoted — a name containing `:`, `#`, or other YAML-significant
 * characters silently corrupts the document or smuggles extra keys.
 * Bare (unquoted) only when the whole string is already a conventional
 * safe identifier and not a YAML-reserved bare scalar; quoted (JSON/YAML
 * double-quote syntax) otherwise.
 */
function yamlKey(s: string): string {
  const isSafeIdentifier = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s);
  return isSafeIdentifier && !YAML_RESERVED_BARE.test(s) ? s : yamlStr(s);
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
      lines.push(`  ${yamlKey(k)}: ${JSON.stringify(v)}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Build cli-config.yaml content — VERIFIED against the authoritative
 * `cli-config.yaml.example` in NousResearch/hermes-agent (ADR-046).
 *
 * The real hermes config is a nested schema (`model:`, `agent:`, `skills:`,
 * `memory:`, …). It has NO `name`/`description`/`system_prompt`/`scrub_*`
 * top-level keys (those were assumed, never real). The harness identity maps
 * onto:
 *   - `model.provider: "auto"`  — auto-detect from credentials (OpenRouter,
 *     Anthropic, …); a generated harness leaves the choice to the user's keys.
 *   - `agent.personalities.<name>` — a name→prompt map. The harness system
 *     prompt + each agent's prompt become named personalities (selectable with
 *     `/personality`).
 * Hermes-4 <think>/<tool_call> scrubbing (scrubHermesBlocks) is RUNTIME logic,
 * not a config key, so it is no longer emitted into the YAML.
 */
export function cliConfigYaml(spec: HarnessSpec): string {
  const lines: string[] = [
    `# Hermes Agent config for ${spec.name} — subset of cli-config.yaml.example.`,
    'model:',
    '  provider: "auto"  # auto-detect from credentials (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, …)',
    'agent:',
    '  personalities:',
  ];
  // Harness identity → the default personality.
  const persona = spec.systemPrompt ?? spec.description ?? `You are ${spec.name}.`;
  lines.push(`    ${yamlKey(spec.name)}: ${yamlStr(persona)}`);
  for (const a of spec.agents ?? []) {
    lines.push(`    ${yamlKey(a.name)}: ${yamlStr(a.systemPrompt ?? `You are the ${a.name} agent.`)}`);
  }
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
