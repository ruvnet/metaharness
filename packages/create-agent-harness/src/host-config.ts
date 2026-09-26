// SPDX-License-Identifier: MIT
//
// ADR-045: per-host config emission for the CLI scaffold path.
//
// Until now `npx metaharness <name> --host <X>` recorded the host in the
// manifest but emitted only the claude-shaped template tree — the
// `@metaharness/host-*` adapters were never reached. This module closes that
// gap. It is intentionally DEPENDENCY-FREE (no import of the adapter packages)
// so the published `metaharness` CLI stays standalone, and it mirrors the
// browser generator's apps/web-ui/src/generator/scaffold.ts host logic
// byte-for-byte so the two surfaces stay in parity (ADR-027).
//
// claude-code is intentionally NOT handled here — the templates already emit a
// richer .claude/ tree (settings.json, commands, plugin manifest). This module
// emits the OTHER ten hosts' native config.

// YAML 1.1 core-schema bare scalars a PyYAML-family loader (hermes) would
// resolve to bool/null/int instead of a string, even though they match the
// bare-identifier shape below.
const YAML_RESERVED_BARE = /^(?:null|~|true|false|yes|no|on|off|[+-]?\d+(?:\.\d+)?)$/i;

/**
 * Escape a string for YAML *mapping-key* position (kept in lockstep with
 * `@metaharness/host-hermes`'s `yamlKey()` — this module is intentionally
 * dependency-free so it can't import that package, see header). `cfg.name`
 * is unconstrained at this type's level and lands in
 * `agent.personalities.<name>` key position for the hermes case below; a
 * name containing `:`/`#`/etc previously corrupted the emitted YAML.
 */
function yamlKey(s: string): string {
  const isSafeIdentifier = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s);
  return isSafeIdentifier && !YAML_RESERVED_BARE.test(s) ? s : JSON.stringify(s.replace(/[\r\n]+/g, ' '));
}

export interface HostConfigInput {
  name: string;
  description: string;
  /** Whether the harness ships an MCP surface (templates default to local). */
  mcp: 'off' | 'local' | 'remote';
  /** Default-deny posture knobs (ADR-022). */
  allowShell?: boolean;
  allowFileWrite?: boolean;
}

export interface HostFile {
  path: string;
  content: string;
}

/** The MCP server entry a host registers, or null when MCP is off. */
function mcpServerEntry(cfg: HostConfigInput): Record<string, unknown> | null {
  if (cfg.mcp === 'off') return null;
  if (cfg.mcp === 'remote') {
    return { type: 'http', url: 'https://localhost:8787/mcp', headers: { Authorization: 'Bearer ${HARNESS_MCP_TOKEN}' } };
  }
  return { command: 'npx', args: ['-y', `${cfg.name}@latest`, 'mcp', 'start'] };
}

/** Derive a Claude-Code-style allow/deny posture (mirrors the web UI). */
function policyLists(cfg: HostConfigInput): { allow: string[]; deny: string[] } {
  const allow: string[] = [];
  if (cfg.mcp !== 'off') allow.push(`mcp__${cfg.name}__*`);
  if (cfg.allowShell) allow.push('Bash(*)');
  const deny: string[] = ['Read(./.env)', 'Read(./.env.*)', 'Bash(rm:*)', 'Bash(git push:*)'];
  if (!cfg.allowFileWrite) deny.push('Write(*)', 'Edit(*)');
  return { allow, deny };
}

function ghaSlug(name: string): string {
  return (name || 'harness').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'harness';
}

/**
 * Escape a string for interpolation inside a *double-quoted* bash string in
 * a generated `run:` line. `cfg.name` is unconstrained at the
 * `HostConfigInput` type level; this module's sole production caller,
 * `scaffold()`, already validates it via `validateHarnessName` before
 * calling here, so this isn't reachable via the CLI today — but the
 * function itself enforces nothing on its own, and `@metaharness/host-
 * github-actions` (a separately published package with no such gate) emits
 * byte-parity-equivalent output, so the same escaping is applied here too
 * (ADR-027). Only `\`, `"`, `` ` ``, and `$` are special inside bash double
 * quotes; newlines are stripped too since they'd otherwise inject a new
 * line into the surrounding `.join('\n')` YAML block. NOTE: this alone does
 * NOT make a plain-scalar `run: echo "..."` YAML line safe — `:`/`#` are
 * still YAML-significant there. The `run:` sites below use a `|` block
 * literal instead, where `shellDq()`'s escaped output is the only special
 * thing left to interpret (by bash, not YAML).
 */
function shellDq(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/[\\"$`]/g, '\\$&');
}

/**
 * Strip newlines from a string destined for a YAML `#`-comment line. A
 * literal `#` or `:` inside the value is harmless there (the whole line is
 * already a comment) but a newline lets the value "escape" onto new lines —
 * the same class of gap `yamlKey()`'s hermes fix (2026-08-14, #188) closed
 * for YAML *key* position, recurring here for comment position.
 */
function yamlCommentSafe(s: string): string {
  return s.replace(/[\r\n]+/g, ' ');
}

// ADR-280 — Grok Build helpers, kept byte-for-byte in lockstep with
// `@metaharness/host-grok` (tomlString/tomlKey/normalizeServerName/
// configHeader/permissionToml) and apps/web-ui/src/generator/scaffold.ts
// (ADR-027 parity; this module stays dependency-free, see header).

/** TOML 1.0 basic string: escapes `"`, `\`, control chars, DEL; lone surrogate → U+FFFD. */
function grokTomlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    else if (cp >= 0xd800 && cp <= 0xdfff) out += '\\uFFFD';
    else out += ch;
  }
  return `${out}"`;
}

function grokTomlKey(s: string): string {
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : grokTomlString(s);
}

/** A server name Grok admits into its tool catalog (identity for kebab-case
 * names; not length-capped — the 64-char budget is for `search_tool`/`use_tool`
 * function names, not catalog keys, and truncating would desynchronize the
 * harness's own `mcp__<name>__*` allow rule from the table name). */
function grokServerName(raw: string): string {
  let s = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/_{2,}/g, '_').replace(/-{2,}/g, '-').replace(/^-+/, '');
  if (/^[0-9]/.test(s)) s = `mcp-${s}`;
  s = s.replace(/[-_]+$/, '');
  return s || 'mcp';
}

/** `.grok/config.toml`: header comment, the harness MCP server, `[permission]`. */
function grokConfigToml(name: string, server: Record<string, unknown> | null, allow: string[], deny: string[]): string {
  const blocks = [[
    `# ${name.replace(/[\u0000-\u0008\u000a-\u001f\u007f]+/g, ' ')} — Grok Build project config (metaharness host: grok, ADR-280).`,
    '# Grok starts these servers and applies these rules only in a trusted folder; see install-grok.md.',
  ].join('\n')];
  if (server) {
    const key = `mcp_servers.${grokTomlKey(grokServerName(name))}`;
    const lines = [`[${key}]`];
    if (typeof server.url === 'string') {
      // Grok infers HTTP from `url`; no `type` key (unlike the codex arm).
      lines.push(`url = ${grokTomlString(server.url)}`, 'enabled = true');
      const headers = server.headers as Record<string, string> | undefined;
      if (headers && Object.keys(headers).length > 0) {
        lines.push('', `[${key}.headers]`, ...Object.entries(headers).map(([k, v]) => `${grokTomlKey(k)} = ${grokTomlString(v)}`));
      }
    } else {
      const args = (server.args as string[] | undefined) ?? [];
      lines.push(`command = ${grokTomlString(String(server.command))}`);
      if (args.length > 0) lines.push(`args = [${args.map(grokTomlString).join(', ')}]`);
      lines.push('enabled = true');
    }
    blocks.push(lines.join('\n'));
  }
  if (allow.length + deny.length > 0) {
    const lines = ['[permission]'];
    if (allow.length > 0) lines.push('allow = [', ...allow.map((r) => `  ${grokTomlString(r)},`), ']');
    if (deny.length > 0) lines.push('deny = [', ...deny.map((r) => `  ${grokTomlString(r)},`), ']');
    blocks.push(lines.join('\n'));
  }
  return `${blocks.join('\n\n')}\n`;
}

/**
 * Emit the config files for a single host. Returns [] for claude-code (handled
 * by the templates) and for any unknown host id.
 */
export function hostConfigFiles(host: string, cfg: HostConfigInput): HostFile[] {
  const server = mcpServerEntry(cfg);
  switch (host) {
    case 'claude-code':
      return []; // templates own the .claude/ tree

    case 'codex': {
      const toml = cfg.mcp === 'off'
        ? `# ${cfg.name} — MCP disabled at scaffold time.\n`
        : cfg.mcp === 'remote'
          ? `[mcp_servers.${cfg.name}]\ntype = "http"\nurl = "https://localhost:8787/mcp"\n`
          : `[mcp_servers.${cfg.name}]\ncommand = "npx"\nargs = ["-y", "${cfg.name}@latest", "mcp", "start"]\n`;
      return [
        { path: '.codex/config.toml', content: toml },
        { path: 'AGENTS.md', content: `# ${cfg.name}\n\n${cfg.description}\n\n## Behavioral rules\n\n- Use the harness's MCP tools (\`mcp__${cfg.name}__*\`) for orchestration.\n- Defer destructive operations to the user.\n` },
      ];
    }

    case 'pi-dev':
      return [
        { path: 'AGENTS.md', content: `# ${cfg.name}\n\n${cfg.description}\n\nThis pi.dev extension registers tools via \`pi.registerTool()\`.\n` },
        { path: 'SYSTEM.md', content: `You are ${cfg.name}. ${cfg.description}\n` },
        { path: 'trust.json', content: JSON.stringify({ schema: 1, trusted_extensions: [{ name: cfg.name, source: `npm:${cfg.name}`, ...policyLists(cfg) }] }, null, 2) + '\n' },
      ];

    case 'hermes': {
      // ADR-046 — verified against hermes cli-config.yaml.example: nested
      // `model:` + `agent.personalities` schema; no name/description/scrub keys.
      const persona = (cfg.description || `You are ${cfg.name}.`).replace(/[\r\n]+/g, ' ');
      const files: HostFile[] = [
        { path: 'cli-config.yaml', content: `# Hermes Agent config for ${cfg.name} — subset of cli-config.yaml.example.\nmodel:\n  provider: "auto"\nagent:\n  personalities:\n    ${yamlKey(cfg.name)}: ${JSON.stringify(persona)}\n` },
      ];
      if (server) files.push({ path: `optional-mcps/${cfg.name}.json`, content: JSON.stringify({ [cfg.name]: server }, null, 2) + '\n' });
      return files;
    }

    case 'openclaw': {
      // ADR-046 — verified against real openclaw 2026.6.8: MCP nests under
      // `mcp.servers` with an `enabled` flag (NOT top-level `mcp_servers`);
      // no top-level allow/deny permissions concept.
      const servers = server ? { [cfg.name]: { enabled: true, command: 'npx', args: ['-y', `${cfg.name}@latest`, 'mcp', 'start'] } } : {};
      return [{ path: '.openclaw/openclaw.json', content: JSON.stringify({ mcp: { servers } }, null, 2) + '\n' }];
    }

    case 'rvm': {
      const { allow } = policyLists(cfg);
      const caps = allow.map((pattern) => {
        const rights = pattern === '*' ? ['READ', 'WRITE', 'EXECUTE'] : pattern.startsWith('Read') ? ['READ'] : ['EXECUTE'];
        return { rights, resource: pattern, proof_tier: rights.includes('EXECUTE') ? 'P2' : 'P1', expires_at: 0 };
      });
      return [
        { path: 'rvm.manifest.toml', content: `[harness]\nname = "${cfg.name}"\nisolation = "hardware"\nwitness = "ed25519"\n` },
        { path: 'capability-table.json', content: JSON.stringify(caps, null, 2) + '\n' },
      ];
    }

    case 'copilot': {
      const body = server ? { servers: { [cfg.name]: server }, mcpServers: { [cfg.name]: server } } : { servers: {}, mcpServers: {} };
      return [
        { path: '.vscode/mcp.json', content: JSON.stringify(body, null, 2) + '\n' },
        { path: 'install.md', content: `# Installing ${cfg.name} into GitHub Copilot (VSCode)\n\n1. Open this folder in VSCode 1.99+ and trust the workspace.\n2. Open the Copilot Chat panel and run \`/mcp\` to verify \`${cfg.name}\` is registered.\n` },
        { path: '.github/copilot-instructions.md', content: `# ${cfg.name}\n\n${cfg.description}\n\n## Behavioral rules\n\n- Use the harness's MCP tools (\`mcp__${cfg.name}__*\`) for orchestration.\n- Defer destructive operations to the user.\n` },
      ];
    }

    case 'opencode':
      // ADR-046 — verified against real opencode 1.17.7: `mcp` is a direct
      // name→{type,command[],enabled} map; permissions live in a top-level
      // `permission` object ("ask"|"allow"|"deny"), NOT under mcp.
      return [
        { path: '.opencode/opencode.json', content: JSON.stringify({
          $schema: 'https://opencode.ai/schema/opencode.json',
          mcp: server ? { [cfg.name]: { type: 'local', command: ['npx', '-y', `${cfg.name}@latest`, 'mcp', 'start'], enabled: true } } : {},
          permission: { edit: cfg.allowFileWrite ? 'allow' : 'ask', bash: { '*': cfg.allowShell ? 'allow' : 'ask', 'rm *': 'deny', 'git push *': 'deny' }, webfetch: 'ask' },
        }, null, 2) + '\n' },
        { path: 'install.md', content: `# Installing ${cfg.name} into OpenCode\n\n1. \`opencode auth login\` to set a model provider.\n2. \`cd\` here and run \`opencode\` — the TUI reads \`.opencode/opencode.json\`.\n3. Inside the TUI run \`/mcp\` to verify \`${cfg.name}\` is registered.\n` },
      ];

    case 'github-actions': {
      const slug = ghaSlug(cfg.name);
      const workflow = [
        `# GitHub Actions harness: ${yamlCommentSafe(cfg.name)}`,
        '# Generated by metaharness (host: github-actions, ADR-033).',
        `name: ${slug}`,
        '',
        'on:',
        '  workflow_dispatch: {}',
        '  issue_comment:',
        '    types: [created]',
        '',
        '# ADR-022 default-deny: contents:read only. Widen via the harness policy.',
        'permissions:',
        '  contents: read',
        '',
        'jobs:',
        `  ${slug}:`,
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        `      - uses: ./.github/actions/${slug}`,
        '        with:',
        '          task: ${{ github.event.comment.body || github.event_name }}',
        '        env:',
        // ADR-044/045: provider-agnostic (was ANTHROPIC-only).
        '          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
        '          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}',
        '          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}',
        '',
      ].join('\n');
      const action = [
        `name: ${slug}`,
        `description: ${JSON.stringify(cfg.description ?? 'Autonomous agent harness')}`,
        'inputs:',
        '  task: { description: The task for the harness., required: true }',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - shell: bash',
        // `|` block literal, not a plain scalar: `#`/`:` are NOT
        // YAML-significant inside a block literal's body, so shellDq()'s
        // bash-level escaping is the only thing left to interpret this
        // line (by bash) — a plain `run: echo "..."` scalar would still let
        // a name containing ` #` truncate the line as a YAML comment, or
        // `: ` corrupt the mapping, before bash ever saw shellDq()'s output.
        '      run: |',
        `        echo "Running ${shellDq(cfg.name)} (non-interactive)…"`,
        '      env: { TASK: "${{ inputs.task }}" }',
        '',
      ].join('\n');
      return [
        { path: `.github/workflows/${slug}.yml`, content: workflow },
        { path: `.github/actions/${slug}/action.yml`, content: action },
        { path: 'install.md', content: `# Installing ${cfg.name} as a GitHub Actions harness\n\n1. Commit \`.github/workflows/${slug}.yml\` + \`.github/actions/${slug}/action.yml\`.\n2. Add your model-provider key as a repo secret — one of \`ANTHROPIC_API_KEY\`, \`OPENROUTER_API_KEY\`, or \`OPENAI_API_KEY\`.\n3. Trigger: Actions → ${slug} → Run workflow, or comment on an issue.\n` },
      ];
    }

    case 'prime-agent': {
      // ADR-247 — Prime Agent uses project skills, supports remote HTTP MCP,
      // and has no native sandbox. Runtime-specific files are emitted by
      // @metaharness/host-prime-agent; scaffold-time emits concise guidance.
      return [
        { path: 'install-prime-agent.md', content: [
          `# Install ${cfg.name} into Prime Agent`,
          '',
          'Prime Agent loads tools from project skills and supports remote HTTP MCP integrations; local stdio MCP is not currently wired.',
          '',
          cfg.mcp === 'off' ? 'MCP: off — nothing further.' : `MCP (${cfg.mcp}): remote HTTP servers are emitted as Python-backed integrations; local stdio servers are listed as unsupported.`,
          '',
          'Sandbox: Prime Agent is not sandboxed. Denied capabilities require an external sandbox (ADR-247).',
        ].join('\n') + '\n' },
        { path: '.prime/agent/skills/README.md', content: `# ${cfg.name} skills\n\nGenerated skill directories land here (one per tool).\n` },
      ];
    }

    case 'grok': {
      // ADR-280 — Grok Build CLI, verified against grok 1.0.34. The project
      // `.grok/config.toml` carries `[mcp_servers]` + `[permission]` (Grok
      // reads only those tables from a project file). Grok ignores
      // AGENTS.md, the config and hooks until the folder is trusted, so the
      // runbook opens with the trust step and repeats the deny rules as
      // `--deny` flags, which Grok enforces regardless of trust (fail-closed).
      // ADR-027 parity contract: byte-identical with
      // apps/web-ui/src/generator/scaffold.ts, and `.grok/config.toml` is
      // byte-identical with @metaharness/host-grok's configToml() for the same
      // server + permissions.
      const { allow, deny } = policyLists(cfg);
      const tools = `${grokServerName(cfg.name)}__*`;
      const quote = (r: string) => `'${r.replace(/'/g, `'"'"'`)}'`;
      return [
        { path: '.grok/config.toml', content: grokConfigToml(cfg.name, server, allow, deny) },
        { path: 'AGENTS.md', content: `# ${cfg.name}\n\n${cfg.description}\n\n## Behavioral rules\n\n${server ? `- Use the harness's MCP tools (\`${tools}\` in Grok; find them with \`search_tool\`, call them with \`use_tool\`) for orchestration.\n` : ''}- Defer destructive operations to the user.\n` },
        { path: 'install-grok.md', content: [
          `# Installing ${cfg.name} into Grok Build`,
          '',
          '> **ACTION REQUIRED: trust this folder.** Grok Build ignores `AGENTS.md`, `.grok/config.toml` (`[mcp_servers]` and `[permission]`) and project skills and hooks until the folder is trusted, so the deny rules below are not enforced until then.',
          '',
          '1. Install: `curl -fsSL https://x.ai/cli/install.sh | bash`, then `grok login`.',
          `2. Review \`.grok/config.toml\` and \`AGENTS.md\`, then from this folder run \`grok --trust inspect\`. It records trust in \`~/.grok/trusted_folders.toml\` and lists what loaded${server ? `: expect the MCP server \`${grokServerName(cfg.name)}\` and` : ': expect'} \`Source: .grok/config.toml\` with \`${allow.length + deny.length} loaded\` rules (more if a \`.claude/settings.json\` is present — Grok loads its permissions too).`,
          `3. Run \`grok\`. Headless: \`grok -p '<task>'${deny.map((d) => ` --deny ${quote(d)}`).join('')}\`; \`--deny\` flags are enforced even without folder trust (that quoting is for bash/zsh/PowerShell; \`cmd.exe\` needs double quotes). For CI, \`GROK_FOLDER_TRUST=0\` turns the trust gate off for one process — only on a checkout you trust, never a fork PR.`,
          '',
        ].join('\n') },
      ];
    }

    default:
      return [];
  }
}
