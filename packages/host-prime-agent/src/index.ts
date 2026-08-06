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
//   - Autonomous invocation: --autonomous --autonomous-gate "<cmd>"
//     --autonomous-max-turns <n>, plus /goal and /heartbeat.
//
// CRITICAL DESIGN NOTE: like pi, Prime Agent ships NO MCP — "no MCP" is a
// stated non-goal upstream. Instead of MCP config, we generate one
// project-scoped, Python-backed skill per kernel-exposed tool whose shim
// dispatches to the kernel (the Python mirror of host-pi-dev's
// `pi.registerTool` extensionSource pattern).
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

  return name || 'tool';
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
  for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
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
    'This skill is generated by @metaharness/host-prime-agent (ADR-242). It is',
    `Python-backed: import \`${pyPackageName(name)}\` in the kernel and call`,
    '`run(**kwargs)` with arguments matching the input schema below. The shim',
    'dispatches to the harness kernel; it does not implement the tool locally.',
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

/**
 * Minimal valid pyproject.toml for one skill's Python backing package.
 */
export function pyprojectToml(tool: ToolSpec, resolvedName?: string): string {
  const pkg = pyPackageName(resolvedName ?? normalizeSkillName(tool.name));
  const description = (tool.description ?? `Harness tool ${tool.name}`).slice(0, 200);
  return [
    '[project]',
    `name = ${quoted(pkg)}`,
    'version = "0.1.0"',
    `description = ${quoted(description)}`,
    'requires-python = ">=3.10"',
    '',
    '[build-system]',
    'requires = ["setuptools>=68"]',
    'build-backend = "setuptools.build_meta"',
    '',
    '[tool.setuptools.packages.find]',
    'where = ["src"]',
  ].join('\n') + '\n';
}

/**
 * Python module source for src/<pkg>/__init__.py — the skill shim. Mirrors
 * host-pi-dev's kernel.invokeTool delegation, but in Python: run(**kwargs)
 * shells out to the harness kernel CLI with a JSON payload on stdin and
 * parses JSON from stdout. Stdlib only; no network.
 */
export function skillShimPy(tool: ToolSpec): string {
  // JSON string literals are valid Python string literals for our charset.
  const toolName = JSON.stringify(tool.name);
  return [
    '# SPDX-License-Identifier: MIT',
    '# Auto-generated by @metaharness/host-prime-agent (ADR-242).',
    "# Edit @metaharness/kernel's tool registry; do not edit this file directly.",
    '#',
    '# Skill shim: dispatches to the harness kernel CLI (JSON in / JSON out),',
    "# the Python mirror of host-pi-dev's pi.registerTool delegation. Stdlib",
    '# only; no network access of its own.',
    '',
    'import json',
    'import subprocess',
    '',
    `TOOL_NAME = ${toolName}`,
    '',
    '',
    'def run(**kwargs):',
    '    """Invoke this harness tool via the kernel CLI and return its result."""',
    '    payload = json.dumps({"tool": TOOL_NAME, "args": kwargs})',
    '    proc = subprocess.run(',
    '        ["npx", "--yes", "@metaharness/kernel", "invoke-tool"],',
    '        input=payload,',
    '        capture_output=True,',
    '        text=True,',
    '        check=True,',
    '    )',
    '    return json.loads(proc.stdout)',
  ].join('\n') + '\n';
}

/**
 * Supplemental prompt file (.prime/agent/skills/harness-prompt.md) from the
 * harness system prompt. Prime Agent's base prompt is not replaceable; this
 * lands in the project skill/prompt surface as durable state instead.
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

/**
 * Reusable sub-agent spec file at .prime/agent/agents/<name>.md, one per
 * spec.agents entry.
 */
export function subAgentSpec(agent: AgentSpec): string {
  const name = normalizeSkillName(agent.name);
  return [
    `# Sub-agent: ${name}`,
    '',
    'Generated by @metaharness/host-prime-agent (ADR-242). Use this spec when',
    'delegating work to a sub-agent session for this role.',
    '',
    '## System prompt',
    '',
    agent.systemPrompt ?? `Agent: ${agent.name}`,
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
 * Install runbook (`install-prime-agent.md`): install command, where the
 * skills land, precedence note, MCP availability (Prime Agent has no MCP —
 * every spec.mcpServers entry is listed as unavailable as MCP on this host),
 * and — when the ADR-241 autonomous block is present — the exact autonomous
 * invocation snippet. Opens with the sandbox warning when the deny-list is
 * non-empty (ADR-242 §2.2).
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
    'curl -fsSL https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/main/install.sh | bash',
    'prime-agent --version',
    '```',
    '',
    '## Where the skills land',
    '',
    'This harness emits project-scoped skills under `.prime/agent/skills/`,',
    'one directory per tool (`SKILL.md` + `pyproject.toml` +',
    '`src/<pkg>/__init__.py`), plus sub-agent specs under',
    '`.prime/agent/agents/`. Run `prime-agent` from the harness repo root so',
    'the project scope is picked up.',
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
    lines.push('This harness declares no MCP servers; nothing is unavailable.', '');
  } else {
    lines.push(
      'Prime Agent has **no MCP support** (a stated upstream non-goal). The',
      'following MCP servers from this harness spec are **unavailable as MCP',
      'on this host**; their capabilities are reachable only where wrapped as',
      'skill shims via the harness tool registry:',
      '',
      ...servers.map((s) => `- \`${s.name}\` — not emitted as MCP; ${s.url ? 'remote server, unavailable on this host' : 'reachable only via the generated skill shims'}`),
      '',
    );
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
    if (autonomous.gateCommand) cli.push(`--autonomous-gate "${autonomous.gateCommand}"`);
    if (autonomous.maxTurns !== undefined) cli.push(`--autonomous-max-turns ${autonomous.maxTurns}`);
    if (autonomous.goal?.text) cli.push(`"${autonomous.goal.text}"`);
    lines.push('## Autonomous invocation (ADR-241)', '', '```bash', cli.join(' '), '```', '');
    if (autonomous.goal?.tokenBudget !== undefined) {
      lines.push(`Inside a session, set the goal budget with \`/goal --budget ${autonomous.goal.tokenBudget}\`.`, '');
    }
    if (autonomous.heartbeat) {
      lines.push(
        `Configure the heartbeat with \`/heartbeat\` at cadence \`${autonomous.heartbeat.cadence}\`:`,
        '',
        `> ${autonomous.heartbeat.instruction}`,
        '',
      );
    } else {
      lines.push('Use `/heartbeat` to keep long-running autonomous work checkpointed.', '');
    }
  }

  return lines.join('\n');
}

export const adapter: HostAdapter = {
  name: HOST_NAME,
  generateConfig: (spec: HarnessSpec) => {
    const out: Record<string, string> = {};
    // One project-scoped, Python-backed skill per tool (ADR-242 §2.1);
    // collision-safe so every spec.tools entry keeps its own directory.
    const usedSkillNames = new Set<string>();
    for (const t of spec.tools ?? []) {
      const name = uniqueSkillName(t.name, usedSkillNames);
      const pkg = pyPackageName(name);
      out[`.prime/agent/skills/${name}/SKILL.md`] = skillMd(t, spec, name);
      out[`.prime/agent/skills/${name}/pyproject.toml`] = pyprojectToml(t, name);
      out[`.prime/agent/skills/${name}/src/${pkg}/__init__.py`] = skillShimPy(t);
    }
    // Supplemental prompt (only when a system prompt is declared).
    if (spec.systemPrompt) {
      out['.prime/agent/skills/harness-prompt.md'] = supplementalPrompt(spec);
    }
    // Sub-agent specs (same collision discipline as skills).
    const usedAgentNames = new Set<string>();
    for (const a of spec.agents ?? []) {
      out[`.prime/agent/agents/${uniqueSkillName(a.name, usedAgentNames)}.md`] = subAgentSpec(a);
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
