// SPDX-License-Identifier: MIT
//
// @metaharness/host-prime-agent — Prime Agent (PrimeIntellect-ai/prime-agent)
// host adapter. The 11th host, per ADR-242.
//
// Prime Agent is the Prime Intellect open-source coding/autonomy harness,
// built atop the `pi` framework (badlogic pi-mono) — the direct sibling of
// our host-pi-dev adapter. References:
//   - Source: https://github.com/PrimeIntellect-ai/prime-agent
//   - Skills surface: packages/coding-agent/docs/skills.md (upstream)
//
// Verified integration surface (ADR-242, research doc §3):
//   - Skills discovered (highest precedence first) from user
//     (~/.prime/agent/skills/, ~/.agents/skills/) → project
//     (.prime/agent/skills/, .agents/skills/) → package (skills/ dirs,
//     `pi.skills` in package.json) → CLI --skill <path> → built-in.
//   - A skill = a directory with SKILL.md (YAML frontmatter: `name`
//     lowercase a-z0-9-; `description` ≤ 1024 chars), optionally
//     Python-backed via pyproject.toml + src/<pkg>/__init__.py, importable
//     in the persistent IPython kernel.
//   - Project prompt additions belong in .prime/agent/APPEND_SYSTEM.md.
//   - Remote HTTP MCP integrations are Python-backed skills using
//     rlm.McpIntegration. Local stdio MCP servers are not currently wired.
//   - Autonomous goals use --goal/--goal-token-budget; autonomous policy uses
//     --autonomous-gate and --autonomous-max-turns.
//
// CRITICAL DESIGN NOTE: ToolSpec is declarative metadata only: it has no
// executable handler, command, or MCP binding. Therefore tool entries are
// emitted as instruction-only skills. Generating a callable shim would invent
// an execution target and fail at runtime. Executable integrations are emitted
// only where HarnessSpec provides a real remote HTTP MCP URL.
//
// CRITICAL SECURITY NOTE (ADR-242 §2.2, fail-closed): Prime Agent executes
// model-written Python at user permission level with NO native allow/deny
// enforcement — its own docs say worker/kernel processes "aren't sandboxes".
// When spec.permissions.deny is non-empty, this adapter MUST emit
// SANDBOX-REQUIRED.md and open the install runbook with the same warning.
// Silently dropping the deny-list is the ADR-046 bug class.
//
// All renderers below are pure and byte-deterministic (no dates, no
// randomness) — the golden-file contract test depends on it.

import type { HostAdapter, HarnessSpec, ToolSpec, AgentSpec } from '@metaharness/kernel';

export const HOST_NAME = 'prime-agent' as const;

/** Runbook filename. host-opencode uses `install.md`; this host uses a
 * host-qualified name so multi-host scaffolds don't collide. */
const INSTALL_MD = 'install-prime-agent.md';

/**
 * Normalize an arbitrary tool/agent name to Prime Agent's skill-name charset
 * (`^[a-z0-9-]+$`, per SKILL.md frontmatter rules): lowercase, map every
 * disallowed character to '-', collapse runs, trim edge dashes.
 * Deterministic; an input that normalizes to nothing yields 'tool'.
 */
export function normalizeSkillName(raw: string): string {
  let name = '';
  let separatorPending = false;

  for (const char of raw.toLowerCase()) {
    const code = char.charCodeAt(0);
    const allowed =
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39);

    if (allowed) {
      if (separatorPending && name !== '') name += '-';
      name += char;
      separatorPending = false;
    } else if (name !== '') {
      separatorPending = true;
    }
  }

  // Agent Skills names are capped at 64 characters. Truncate only after
  // normalization so the output remains stable and never ends in a separator.
  return (name.slice(0, 64).replace(/-+$/g, '') || 'tool');
}

/**
 * Distinct names can normalize to the same skill name ('My Tool' and
 * 'my_tool' → 'my-tool'); a flat Record would then silently overwrite the
 * earlier entry — the ADR-046 silent-drop bug class. Disambiguate
 * deterministically in spec order: first keeps the base name, later
 * collisions get '-2', '-3', … (still within the a-z0-9- charset).
 */
function uniqueSkillName(raw: string, used: Set<string>): string {
  const base = normalizeSkillName(raw);
  let name = base;
  for (let n = 2; used.has(name); n++) {
    const suffix = `-${n}`;
    name = `${base.slice(0, 64 - suffix.length).replace(/-+$/g, '')}${suffix}`;
  }
  used.add(name);
  return name;
}

/**
 * Python package name for a skill: normalized name with '-' → '_', prefixed
 * 'mh_' when it would start with a digit (Python identifiers cannot).
 */
function pyPackageName(skillName: string): string {
  const pkg = skillName.replace(/-/g, '_');
  return /^[0-9]/.test(pkg) ? `mh_${pkg}` : pkg;
}

/** Quote one shell argument without permitting flag/command injection. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Truncate to the upstream 1024-char description limit without splitting a
 * surrogate pair (a split pair is an ill-formed lone surrogate in the YAML).
 */
function truncateDescription(raw: string): string {
  let d = raw.slice(0, 1024);
  const last = d.charCodeAt(d.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) d = d.slice(0, -1);
  return d;
}

/** Quote a string for single-line YAML/TOML double-quoted scalars. */
function quoted(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

/**
 * Render SKILL.md for one tool: YAML frontmatter (name normalized to
 * a-z0-9-, description ≤ 1024 chars per upstream limit) plus a body
 * documenting the tool, its input schema, and — when the harness declares
 * allow rules — the intended scope (ADR-242 §2.2: allow entries are
 * projected into the model-facing surface even though enforcement is
 * external).
 */
export function skillMd(tool: ToolSpec, spec: HarnessSpec, resolvedName?: string): string {
  const name = resolvedName ?? normalizeSkillName(tool.name);
  const description = truncateDescription(tool.description ?? `Harness tool ${tool.name}`);
  const allow = spec.permissions?.allow ?? [];
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${quoted(description)}`,
    '---',
    '',
    `# ${name}`,
    '',
    description,
    '',
    'This skill is generated by @metaharness/host-prime-agent (ADR-242). The',
    'HarnessSpec tool entry is a declarative contract, not an executable',
    'binding. Use a host capability or configured MCP integration that exposes',
    `the \`${tool.name}\` operation with the schema below. If none is available,`,
    'say that the operation is unavailable; do not claim it was executed.',
    '',
    '## Input schema',
    '',
    '```json',
    JSON.stringify(tool.inputSchema ?? {}, null, 2),
    '```',
  ];
  if (allow.length > 0) {
    lines.push(
      '',
      '## Intended scope',
      '',
      'The harness permission posture allows only the following (enforcement',
      'is external to Prime Agent — see SANDBOX-REQUIRED.md if present):',
      '',
      ...allow.map((a) => `- \`${a}\``),
    );
  }
  return lines.join('\n') + '\n';
}

/** Prime Agent settings for the remote HTTP MCP servers it can actually load. */
export function settingsJson(spec: HarnessSpec): string {
  const servers = Object.fromEntries(
    (spec.mcpServers ?? [])
      .filter((server) => server.url)
      .map((server) => [server.name, { type: 'http', url: server.url, enabled: true }]),
  );
  return JSON.stringify({ mcpServers: servers }, null, 2) + '\n';
}

/** Skill instructions for one remote HTTP MCP integration. */
export function mcpSkillMd(serverName: string, url: string, resolvedName: string): string {
  const pkg = pyPackageName(resolvedName);
  return [
    '---',
    `name: ${resolvedName}`,
    `description: ${quoted(`Connects to the ${serverName} MCP server and exposes its tools in Prime Agent.`)}`,
    '---',
    '',
    `# ${serverName} MCP integration`,
    '',
    `Remote endpoint: \`${url}\``,
    '',
    `Import \`${pkg}\`, then discover the server contract before calling it:`,
    '',
    '```python',
    `import ${pkg}`,
    `tools = await ${pkg}.list_tools()`,
    `result = await ${pkg}.call_tool("tool-name", {"argument": "value"})`,
    '```',
    '',
    'Never assume tool names or schemas; inspect `list_tools()` first.',
    '',
  ].join('\n');
}

/** Minimal valid pyproject.toml for a Prime Agent MCP integration package. */
export function mcpPyprojectToml(serverName: string, resolvedName: string): string {
  const pkg = pyPackageName(resolvedName);
  return [
    '[project]',
    `name = ${quoted(`prime-agent-skill-${resolvedName}`)}`,
    'version = "0.1.0"',
    `description = ${quoted(`Prime Agent integration for ${serverName}`)}`,
    'requires-python = ">=3.10"',
    'dependencies = ["mcp", "httpx", "prime-agent-runtime"]',
    '',
    '[build-system]',
    'requires = ["hatchling"]',
    'build-backend = "hatchling.build"',
    '',
    '[tool.hatch.build.targets.wheel]',
    `packages = ["src/${pkg}"]`,
  ].join('\n') + '\n';
}

/**
 * Real Prime Agent MCP integration, following upstream's McpIntegration
 * contract. Unlike the removed kernel shim, every target is supplied by the
 * HarnessSpec and exists independently of this generated code.
 */
export function mcpIntegrationPy(serverName: string, url: string): string {
  return [
    '# SPDX-License-Identifier: MIT',
    '# Auto-generated by @metaharness/host-prime-agent (ADR-242).',
    'from rlm import McpIntegration',
    '',
    'class HarnessMcpIntegration(McpIntegration):',
    `    server = ${JSON.stringify(serverName)}`,
    `    url = ${JSON.stringify(url)}`,
    '',
    'integration = HarnessMcpIntegration()',
    '_RESERVED = {"run", "__wrapped__", "__call__"}',
    '',
    'def __getattr__(name):',
    '    if name.startswith("_") or name in _RESERVED:',
    '        raise AttributeError(name)',
    '    return getattr(integration, name)',
  ].join('\n') + '\n';
}

/**
 * Supplemental prompt file (.prime/agent/APPEND_SYSTEM.md) from the harness
 * system prompt. Prime Agent appends this file to its default system prompt.
 * Only emitted when spec.systemPrompt is present.
 */
export function supplementalPrompt(spec: HarnessSpec): string {
  return [
    `# ${spec.name} — harness prompt`,
    '',
    'Supplemental instructions for this harness (generated by',
    "@metaharness/host-prime-agent; supplements Prime Agent's base prompt,",
    'does not replace it).',
    '',
    spec.systemPrompt ?? '',
    '',
  ].join('\n');
}

/** Discoverable skill that delegates through Prime Agent's native rlm API. */
export function agentSkillMd(agent: AgentSpec, resolvedName: string): string {
  const prompt = agent.systemPrompt ?? `Act as the ${agent.name} agent.`;
  return [
    '---',
    `name: ${resolvedName}`,
    `description: ${quoted(`Delegates work to the ${agent.name} role using Prime Agent's native recursive agent runtime.`)}`,
    '---',
    '',
    `# Sub-agent: ${agent.name}`,
    '',
    'Delegate a bounded task through Prime Agent\'s built-in `rlm` callable:',
    '',
    '```python',
    'task = "<concrete task and expected result>"',
    `child = await rlm(${JSON.stringify(`${prompt}\n\nTask: `)} + task, name=${JSON.stringify(normalizeSkillName(agent.name))})`,
    '```',
    '',
    'Give the child the concrete task and expected result in addition to this',
    'role prompt. Children reply through the native agent messaging surface.',
    '',
  ].join('\n');
}

/**
 * SANDBOX-REQUIRED.md — the fail-closed artifact (ADR-242 §2.2). Emitted
 * whenever spec.permissions.deny is non-empty; enumerates every denied
 * capability Prime Agent cannot enforce natively.
 */
export function sandboxRequiredMd(spec: HarnessSpec): string {
  const deny = spec.permissions?.deny ?? [];
  return [
    '# SANDBOX REQUIRED',
    '',
    '> **WARNING: Prime Agent cannot enforce this harness\'s deny-list.**',
    '',
    'Prime Agent executes model-written Python at user permission level with',
    'no native allow/deny enforcement — its own security notes state that',
    'worker/kernel processes are not sandboxes. This harness declares the',
    'following denied capabilities, which **must** be enforced by an external',
    'sandbox (container, RVM per ADR-018, or equivalent) before running',
    'Prime Agent against untrusted input:',
    '',
    ...deny.map((d) => `- \`${d}\``),
    '',
    'Do not run this harness on Prime Agent outside such a sandbox.',
    '',
  ].join('\n');
}

/** The sandbox warning banner shared by the install runbook opening. */
function sandboxBanner(deny: string[]): string[] {
  return [
    '> **WARNING — SANDBOX REQUIRED.** This harness declares a deny-list that',
    '> Prime Agent cannot enforce natively. Run it only inside an external',
    '> sandbox (container / RVM per ADR-018). Denied capabilities:',
    ...deny.map((d) => `> - \`${d}\``),
    '> See `SANDBOX-REQUIRED.md` for details.',
    '',
  ];
}

/**
 * Install runbook (`install-prime-agent.md`): current official install command,
 * skill layout, HTTP-vs-stdio MCP coverage, and the exact autonomous/goal
 * invocation. Opens with the sandbox warning when the deny-list is non-empty.
 */
export function installMd(spec: HarnessSpec): string {
  const name = spec.name ?? 'this harness';
  const deny = spec.permissions?.deny ?? [];
  const servers = spec.mcpServers ?? [];
  const lines: string[] = [];

  lines.push(`# Installing ${name} into Prime Agent`, '');
  if (deny.length > 0) lines.push(...sandboxBanner(deny));

  lines.push(
    '## Install Prime Agent',
    '',
    '```bash',
    'curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh',
    'prime-agent --version',
    '```',
    '',
    '## Where the skills land',
    '',
    'This harness emits project-scoped skills under `.prime/agent/skills/`.',
    'Declarative `tools` entries become instruction-only `SKILL.md` contracts;',
    'remote HTTP MCP servers become executable Python-backed integrations; and',
    'agent roles become skills that delegate through Prime Agent\'s native',
    '`rlm` callable. Run `prime-agent` from the harness repo root so project',
    'skills and `.prime/agent/APPEND_SYSTEM.md` are loaded.',
    '',
    '### Precedence',
    '',
    'Prime Agent discovers skills highest-precedence first: user',
    '(`~/.prime/agent/skills/`, `~/.agents/skills/`) → project',
    '(`.prime/agent/skills/`, `.agents/skills/`) → package (`skills/` dirs,',
    '`pi.skills` in package.json) → CLI `--skill <path>` → built-in. A',
    'user-scoped skill with the same name shadows this harness\'s project',
    'skills.',
    '',
    '## MCP servers',
    '',
  );
  if (servers.length === 0) {
    lines.push('This harness declares no MCP servers.', '');
  } else {
    const remote = servers.filter((server) => server.url);
    const stdio = servers.filter((server) => !server.url);
    if (remote.length > 0) {
      lines.push(
        'Prime Agent supports remote HTTP MCP through Python-backed',
        '`McpIntegration` skills. These servers are configured in',
        '`.prime/agent/settings.json` and emitted as executable integrations:',
        '',
        ...remote.map((server) => `- \`${server.name}\` — ${server.url}`),
        '',
      );
    }
    if (stdio.length > 0) {
      lines.push(
        'Prime Agent does not currently wire local stdio MCP servers into its',
        'kernel. These entries are not emitted as executable integrations:',
        '',
        ...stdio.map((server) => `- \`${server.name}\` — local command \`${(server.command ?? []).join(' ')}\``),
        '',
      );
    }
    const withEnv = servers.filter((server) => (server.env?.length ?? 0) > 0);
    if (withEnv.length > 0) {
      lines.push(
        'HarnessSpec environment pairs are not copied into Prime Agent auth',
        'configuration. Configure these variables in the execution environment:',
        '',
        ...withEnv.flatMap((server) => (server.env ?? []).map(([key]) => `- \`${server.name}\`: \`${key}\``)),
        '',
      );
    }
  }

  // Fields this host has no native surface for are named, never silently
  // ignored (ADR-044 capability-coverage discipline / ADR-242 test contract 5).
  const unsupported: string[] = [];
  if ((spec.hooks ?? []).length > 0) {
    unsupported.push('`hooks` — Prime Agent has no lifecycle-hook surface; hook behavior must live in the harness kernel or an external wrapper.');
  }
  if (spec.statusLine) {
    unsupported.push('`statusLine` — Prime Agent has no status-line surface.');
  }
  if (unsupported.length > 0) {
    lines.push(
      '## Unsupported on this host',
      '',
      'The following harness spec fields have no Prime Agent surface and are',
      '**not** projected (listed here so nothing is silently dropped):',
      '',
      ...unsupported.map((u) => `- ${u}`),
      '',
    );
  }

  // ADR-241 §2.2 autonomous block. Only fields actually present are
  // projected — absent optionals must not fabricate values like
  // `--autonomous-gate ""` or `--autonomous-max-turns 0`.
  const autonomous = spec.autonomous;
  if (autonomous) {
    const cli = ['prime-agent --autonomous'];
    if (autonomous.gateCommand) cli.push(`--autonomous-gate ${shellQuote(autonomous.gateCommand)}`);
    if (autonomous.maxTurns !== undefined) cli.push(`--autonomous-max-turns ${autonomous.maxTurns}`);
    if (autonomous.goal?.text) cli.push(`--goal ${shellQuote(autonomous.goal.text)}`);
    if (autonomous.goal?.tokenBudget !== undefined) {
      cli.push(`--goal-token-budget ${autonomous.goal.tokenBudget}`);
    }
    lines.push('## Autonomous invocation (ADR-241)', '', '```bash', cli.join(' '), '```', '');
    if (autonomous.heartbeat) {
      lines.push(
        'Prime Agent has no direct heartbeat CLI or slash-command surface.',
        `Preserve this requested cadence in the task workflow: \`${autonomous.heartbeat.cadence}\`.`,
        '',
        `> ${autonomous.heartbeat.instruction}`,
        '',
      );
    }
  }

  return lines.join('\n');
}

export const adapter: HostAdapter = {
  name: HOST_NAME,
  generateConfig: (spec: HarnessSpec) => {
    const out: Record<string, string> = {};
    // ToolSpec has no executable binding, so emit honest instruction-only
    // skills. Collision-safe naming prevents silent overwrite.
    const usedSkillNames = new Set<string>();
    for (const t of spec.tools ?? []) {
      const name = uniqueSkillName(t.name, usedSkillNames);
      out[`.prime/agent/skills/${name}/SKILL.md`] = skillMd(t, spec, name);
    }

    // Remote HTTP MCP has a real upstream execution contract. Stdio servers
    // remain explicitly unsupported in the generated runbook.
    const remoteServers = (spec.mcpServers ?? []).filter(
      (server): server is typeof server & { url: string } => Boolean(server.url),
    );
    if (remoteServers.length > 0) out['.prime/agent/settings.json'] = settingsJson(spec);
    for (const server of remoteServers) {
      const name = uniqueSkillName(`mcp-${server.name}`, usedSkillNames);
      const pkg = pyPackageName(name);
      const base = `.prime/agent/skills/${name}`;
      out[`${base}/SKILL.md`] = mcpSkillMd(server.name, server.url, name);
      out[`${base}/pyproject.toml`] = mcpPyprojectToml(server.name, name);
      out[`${base}/src/${pkg}/__init__.py`] = mcpIntegrationPy(server.name, server.url);
    }

    // Supplemental prompt (only when a system prompt is declared).
    if (spec.systemPrompt) {
      out['.prime/agent/APPEND_SYSTEM.md'] = supplementalPrompt(spec);
    }

    // Native recursive-agent roles are discoverable skills using rlm.
    for (const a of spec.agents ?? []) {
      const name = uniqueSkillName(`agent-${a.name}`, usedSkillNames);
      out[`.prime/agent/skills/${name}/SKILL.md`] = agentSkillMd(a, name);
    }
    // Runbook — host-qualified name to avoid colliding with other hosts'
    // install.md in multi-host scaffolds.
    out[INSTALL_MD] = installMd(spec);
    // Fail-closed posture (ADR-242 §2.2): never silently drop the deny-list.
    if ((spec.permissions?.deny ?? []).length > 0) {
      out['SANDBOX-REQUIRED.md'] = sandboxRequiredMd(spec);
    }
    return out;
  },
};

export default adapter;
