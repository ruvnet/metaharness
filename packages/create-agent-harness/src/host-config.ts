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
// emits the OTHER eight hosts' native config.

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
      const files: HostFile[] = [
        { path: 'cli-config.yaml', content: `name: ${cfg.name}\ndescription: ${cfg.description}\nmcp:\n  enabled: ${cfg.mcp !== 'off'}\n  scrub_think_tags: true\n` },
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
        `# GitHub Actions harness: ${cfg.name}`,
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
        `      run: echo "Running ${cfg.name} (non-interactive)…"`,
        '      env: { TASK: "${{ inputs.task }}" }',
        '',
      ].join('\n');
      return [
        { path: `.github/workflows/${slug}.yml`, content: workflow },
        { path: `.github/actions/${slug}/action.yml`, content: action },
        { path: 'install.md', content: `# Installing ${cfg.name} as a GitHub Actions harness\n\n1. Commit \`.github/workflows/${slug}.yml\` + \`.github/actions/${slug}/action.yml\`.\n2. Add your model-provider key as a repo secret — one of \`ANTHROPIC_API_KEY\`, \`OPENROUTER_API_KEY\`, or \`OPENAI_API_KEY\`.\n3. Trigger: Actions → ${slug} → Run workflow, or comment on an issue.\n` },
      ];
    }

    default:
      return [];
  }
}
