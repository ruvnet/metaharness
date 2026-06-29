// SPDX-License-Identifier: MIT
//
// Builds the full harness file tree from a HarnessConfig — the "Download full
// scaffold" path. The output mirrors packages/create-agent-harness/templates so
// a downloaded zip is `npm install && npm test`-ready and matches what the CLI
// would have produced for the same inputs.

import { AGENTS, COMMANDS, HOSTS, SKILLS, TEMPLATES } from './catalog';
import { buildCommandFile, buildSkillFile } from './artifacts';
import { mcpFiles } from './mcp';
import { render, toPascalCase } from './render';
import type { GenFile, HarnessConfig, HostId } from './types';

const KERNEL_DEP = '@metaharness/kernel';
const KERNEL_VERSION = '^0.1.0';

export function buildScaffold(cfg: HarnessConfig): GenFile[] {
  const files: GenFile[] = [];
  const vars = {
    name: cfg.name,
    description: cfg.description,
    host: cfg.hosts[0] ?? 'claude-code',
    Name: toPascalCase(cfg.name),
  };

  files.push({ path: 'package.json', content: packageJson(cfg) });
  files.push({ path: 'README.md', content: readme(cfg) });
  files.push({ path: 'CLAUDE.md', content: claudeMd(cfg, vars) });
  files.push({ path: 'src/init.ts', content: initTs(cfg) });
  files.push({ path: '.gitignore', content: GITIGNORE });
  files.push({ path: 'LICENSE', content: MIT_LICENSE });

  // Agents -> src/agents/<id>.ts + an index.
  const agents = AGENTS.filter((a) => cfg.agents.includes(a.id));
  for (const a of agents) {
    files.push({ path: `src/agents/${a.id}.ts`, content: agentTs(a.id, a.name, a.description, a.body) });
  }
  if (agents.length) {
    files.push({ path: 'src/agents/index.ts', content: agentIndex(agents.map((a) => a.id)) });
  }

  // Skills -> .claude/skills/<id>/SKILL.md (Claude-ready, host-agnostic copy).
  const skills = SKILLS.filter((s) => cfg.skills.includes(s.id));
  for (const s of skills) {
    const f = buildSkillFile(s);
    files.push({ path: `.claude/skills/${f.path}`, content: f.content });
  }

  // Commands -> .claude/commands/<id>.md.
  const commands = COMMANDS.filter((c) => cfg.commands.includes(c.id));
  for (const c of commands) {
    const f = buildCommandFile(c);
    files.push({ path: `.claude/commands/${f.path}`, content: f.content });
  }

  // MCP primitive (modular, gated, security-first) — only when enabled.
  files.push(...mcpFiles(cfg));

  // Per-host adapter wiring.
  for (const host of cfg.hosts) {
    files.push(...hostFiles(host, cfg));
  }

  // Generator state + provenance stub (the CLI re-signs these on publish).
  files.push({ path: '.harness/manifest.json', content: harnessManifest(cfg) });
  files.push({ path: 'witness.json', content: witnessStub(cfg) });

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// --- file builders ---------------------------------------------------------

function packageJson(cfg: HarnessConfig): string {
  const mcpOn = cfg.primitives.mcp !== 'off';
  const scripts: Record<string, string> = {
    build: 'tsc -b',
    test: 'node --test',
    doctor: `node bin/cli.js doctor`,
  };
  if (mcpOn) scripts.mcp = 'node dist/mcp/server.js';
  const pkg = {
    name: cfg.name,
    version: '0.1.0',
    description: cfg.description,
    type: 'module',
    bin: { [cfg.name]: 'bin/cli.js' },
    scripts,
    dependencies: { [KERNEL_DEP]: KERNEL_VERSION },
    keywords: [
      'agent-harness',
      ...(mcpOn ? ['mcp'] : []),
      ...cfg.hosts,
      cfg.marketplace === 'powered-by' ? 'ruflo' : 'independent',
    ],
    license: 'MIT',
    engines: { node: '>=20.0.0' },
    harness: {
      template: cfg.template,
      memory: cfg.memory,
      routing: cfg.routing,
      marketplace: cfg.marketplace,
      models: cfg.models,
      darwin: cfg.darwin,
      primitives: cfg.primitives,
    },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

const CLAUDE_MD_TMPL = `# {{name}}

{{description}}

## Behavioral rules

- Use the harness's MCP tools (\`mcp__{{name}}__*\`) for orchestration
- Memory and routing are handled by the kernel — you don't need to learn them
- Defer destructive operations to the user

## Commands

After \`{{name}} init\`, the following are available:

| Command | What it does |
|---|---|
| \`{{name}} doctor\` | Health check the install |
| \`{{name}} memory search <query>\` | Semantic search across stored patterns |
| \`{{name}} route <task>\` | Get the routing tier recommendation |

## Architecture

This harness uses [@metaharness/kernel](https://www.npmjs.com/package/@metaharness/kernel) for its primitives. The kernel is a Rust-compiled WASM module with a NAPI-RS native fallback — same code runs identically on every platform.
`;

function claudeMd(_cfg: HarnessConfig, vars: Record<string, string>): string {
  return render(CLAUDE_MD_TMPL, vars).output;
}

function initTs(cfg: HarnessConfig): string {
  return `// SPDX-License-Identifier: MIT
// Entry point for the ${cfg.name} harness.
import { createKernel } from '${KERNEL_DEP}';

export async function init() {
  const kernel = await createKernel({
    namespace: '${cfg.name}',
    memory: '${cfg.memory}',
    routing: '${cfg.routing}',
  });
  return kernel;
}

if (import.meta.url === \`file://\${process.argv[1]}\`) {
  init().then((k) => console.log('${cfg.name} ready:', k.info().version));
}
`;
}

function agentTs(id: string, name: string, description: string, body: string): string {
  const cls = toPascalCase(id);
  const doc = body.split('\n').map((l) => ` * ${l}`.replace(/ $/, '')).join('\n');
  return `// SPDX-License-Identifier: MIT
/**
 * ${name} — ${description}
 *
${doc}
 */
export const ${cls} = {
  id: '${id}',
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(description)},
  systemPrompt: ${JSON.stringify(body)},
} as const;

export default ${cls};
`;
}

function agentIndex(ids: string[]): string {
  const imports = ids.map((id) => `import ${toPascalCase(id)} from './${id}.js';`).join('\n');
  const list = ids.map((id) => `  ${toPascalCase(id)},`).join('\n');
  return `// SPDX-License-Identifier: MIT\n${imports}\n\nexport const agents = [\n${list}\n];\n\nexport default agents;\n`;
}

/**
 * ADR-044 parity: derive a Claude-Code-style allow/deny list from the web-UI's
 * boolean McpPolicy so opencode/openclaw/rvm reflect the harness's real posture
 * instead of hard-coding it. Mirrors the host-adapter capability fixes (the
 * CLI side reads spec.permissions; the web UI derives it from the flags).
 */
function policyLists(cfg: HarnessConfig): { allow: string[]; deny: string[] } {
  const p = cfg.mcpPolicy;
  const mcpOn = cfg.primitives.mcp !== 'off';
  const allow: string[] = [];
  if (mcpOn) allow.push(`mcp__${cfg.name}__*`);
  if (p.allowShell) allow.push('Bash(*)');
  const deny: string[] = ['Read(./.env)', 'Read(./.env.*)', 'Bash(rm:*)', 'Bash(git push:*)'];
  if (!p.allowFileWrite) deny.push('Write(*)', 'Edit(*)');
  return { allow, deny };
}

/**
 * ADR-044 parity: pass-through env block for headless hosts — provider-agnostic
 * so a generated harness can run on OpenRouter/OpenAI, not just Anthropic.
 */
function providerEnvLines(indent: string): string[] {
  return [
    `${indent}ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}`,
    `${indent}OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}`,
    `${indent}OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}`,
  ];
}

/** The MCP server entry a host config registers, or null when MCP is off. */
function mcpServerEntry(cfg: HarnessConfig): Record<string, unknown> | null {
  if (cfg.primitives.mcp === 'off') return null;
  if (cfg.primitives.mcp === 'remote') {
    return { type: 'http', url: `https://localhost:8787/mcp`, headers: { Authorization: 'Bearer ${HARNESS_MCP_TOKEN}' } };
  }
  return { command: 'npx', args: ['-y', `${cfg.name}@latest`, 'mcp', 'start'] };
}

function hostFiles(host: HostId, cfg: HarnessConfig): GenFile[] {
  switch (host) {
    case 'claude-code':
      return [{ path: '.claude/settings.json', content: claudeSettings(cfg) }];
    case 'codex':
      return [
        { path: '.codex/config.toml', content: codexConfig(cfg) },
        // ADR-044 parity: Codex reads repo-root AGENTS.md for instructions.
        { path: 'AGENTS.md', content: `# ${cfg.name}\n\n${cfg.description}\n\n## Behavioral rules\n\n- Use the harness's MCP tools (\`mcp__${cfg.name}__*\`) for orchestration.\n- Defer destructive operations to the user.\n` },
      ];
    case 'pi-dev':
      return [
        { path: 'AGENTS.md', content: `# ${cfg.name}\n\n${cfg.description}\n\nThis pi.dev extension registers tools via \`pi.registerTool()\`.\n` },
        { path: 'SYSTEM.md', content: `You are ${cfg.name}. ${cfg.description}\n` },
      ];
    case 'hermes': {
      // ADR-046 — verified against hermes cli-config.yaml.example: nested
      // `model:` + `agent.personalities`; no name/description/scrub keys.
      const persona = (cfg.description || `You are ${cfg.name}.`).replace(/[\r\n]+/g, ' ');
      const files: GenFile[] = [
        { path: 'cli-config.yaml', content: `# Hermes Agent config for ${cfg.name} — subset of cli-config.yaml.example.\nmodel:\n  provider: "auto"\nagent:\n  personalities:\n    ${cfg.name}: ${JSON.stringify(persona)}\n` },
      ];
      if (cfg.primitives.mcp !== 'off') {
        files.push({ path: `optional-mcps/${cfg.name}.json`, content: JSON.stringify({ [cfg.name]: mcpServerEntry(cfg) }, null, 2) + '\n' });
      }
      return files;
    }
    case 'openclaw': {
      // ADR-046 — verified against real openclaw 2026.6.8: MCP nests under
      // `mcp.servers` with `enabled` (NOT top-level `mcp_servers`); openclaw has
      // no top-level allow/deny permissions concept.
      const servers = mcpServerEntry(cfg) ? { [cfg.name]: { enabled: true, command: 'npx', args: ['-y', `${cfg.name}@latest`, 'mcp', 'start'] } } : {};
      return [{ path: '.openclaw/openclaw.json', content: JSON.stringify({ mcp: { servers } }, null, 2) + '\n' }];
    }
    case 'rvm': {
      // ADR-044 parity: emit a capability table derived from the policy (the
      // web UI previously emitted only the partition manifest — no caps).
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
      // iter 127 — ADR-032: VSCode 1.99+ MCP via .vscode/mcp.json.
      const server = mcpServerEntry(cfg);
      const body = server ? { servers: { [cfg.name]: server }, mcpServers: { [cfg.name]: server } } : { servers: {}, mcpServers: {} };
      return [
        { path: '.vscode/mcp.json', content: JSON.stringify(body, null, 2) + '\n' },
        { path: 'install.md', content: `# Installing ${cfg.name} into GitHub Copilot (VSCode)\n\n1. Open this folder in VSCode 1.99+ and trust the workspace.\n2. Open the Copilot Chat panel and run \`/mcp\` to verify \`${cfg.name}\` is registered.\n` },
        // ADR-044 parity: Copilot reads .github/copilot-instructions.md.
        { path: '.github/copilot-instructions.md', content: `# ${cfg.name}\n\n${cfg.description}\n\n## Behavioral rules\n\n- Use the harness's MCP tools (\`mcp__${cfg.name}__*\`) for orchestration.\n- Defer destructive operations to the user.\n` },
      ];
    }
    case 'opencode': {
      // iter 128 — ADR-036: sst/opencode TUI via .opencode/opencode.json.
      const server = mcpServerEntry(cfg);
      // ADR-046 — verified against real opencode 1.17.7: `mcp` is a direct
      // name→{type,command[],enabled} map; permissions live in a top-level
      // `permission` object, NOT under mcp.
      const body = {
        $schema: 'https://opencode.ai/schema/opencode.json',
        mcp: server ? { [cfg.name]: { type: 'local', command: ['npx', '-y', `${cfg.name}@latest`, 'mcp', 'start'], enabled: true } } : {},
        permission: {
          edit: cfg.mcpPolicy.allowFileWrite ? 'allow' : 'ask',
          bash: { '*': cfg.mcpPolicy.allowShell ? 'allow' : 'ask', 'rm *': 'deny', 'git push *': 'deny' },
          webfetch: 'ask',
        },
      };
      return [
        { path: '.opencode/opencode.json', content: JSON.stringify(body, null, 2) + '\n' },
        { path: 'install.md', content: `# Installing ${cfg.name} into OpenCode\n\n1. \`opencode auth login\` to set a model provider.\n2. \`cd\` here and run \`opencode\` — the TUI reads \`.opencode/opencode.json\`.\n3. Inside the TUI run \`/mcp\` to verify \`${cfg.name}\` is registered.\n` },
      ];
    }
    case 'github-actions': {
      // iter 147 — ADR-033: the first NON-INTERACTIVE host. Emits a trigger
      // workflow + a reusable composite action. Default-deny maps to the
      // workflow `permissions:` block (contents:read by default).
      const slug = (cfg.name || 'harness').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'harness';
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
        // ADR-044 parity: provider-agnostic (was ANTHROPIC-only).
        ...providerEnvLines('          '),
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
        { path: 'install.md', content: `# Installing ${cfg.name} as a GitHub Actions harness\n\n1. Commit \`.github/workflows/${slug}.yml\` + \`.github/actions/${slug}/action.yml\`.\n2. Add your model-provider key as a repo secret — one of \`ANTHROPIC_API_KEY\`, \`OPENROUTER_API_KEY\`, or \`OPENAI_API_KEY\` (the workflow passes all three through; set whichever your harness uses).\n3. Trigger: Actions → ${slug} → Run workflow, or comment on an issue.\n` },
      ];
    }
  }
}

function claudeSettings(cfg: HarnessConfig): string {
  const server = mcpServerEntry(cfg);
  const settings: Record<string, unknown> = {
    permissions: {
      allow: [`Bash(npx ${cfg.name}*)`, ...(server ? [`mcp__${cfg.name}__*`] : [])],
      deny: ['Read(./.env)', 'Read(./.env.*)'],
    },
    ...(server ? { mcpServers: { [cfg.name]: server } } : {}),
  };
  return JSON.stringify(settings, null, 2) + '\n';
}

function codexConfig(cfg: HarnessConfig): string {
  if (cfg.primitives.mcp === 'off') return `# ${cfg.name} — MCP disabled at scaffold time.\n`;
  if (cfg.primitives.mcp === 'remote') {
    return `[mcp_servers.${cfg.name}]\ntype = "http"\nurl = "https://localhost:8787/mcp"\n`;
  }
  return `[mcp_servers.${cfg.name}]\ncommand = "npx"\nargs = ["-y", "${cfg.name}@latest", "mcp", "start"]\n`;
}

function harnessManifest(cfg: HarnessConfig): string {
  return JSON.stringify(
    {
      generator: 'agent-harness-generator/web-ui',
      generatorVersion: '0.1.0',
      template: cfg.template,
      name: cfg.name,
      hosts: cfg.hosts,
      agents: cfg.agents,
      skills: cfg.skills,
      commands: cfg.commands,
      memory: cfg.memory,
      routing: cfg.routing,
      marketplace: cfg.marketplace,
      models: cfg.models,
      darwin: cfg.darwin,
      primitives: cfg.primitives,
      mcpPolicy: cfg.primitives.mcp === 'off' ? null : cfg.mcpPolicy,
      createdAt: '__GENERATED_AT__',
    },
    null,
    2,
  ) + '\n';
}

function witnessStub(cfg: HarnessConfig): string {
  return JSON.stringify(
    {
      schema: 'witness/v1',
      subject: cfg.name,
      note: 'Provenance stub. Run `harness verify-witness` / `publish-harness` to produce the Ed25519-signed manifest.',
      signature: null,
    },
    null,
    2,
  ) + '\n';
}

function readme(cfg: HarnessConfig): string {
  const tmpl = TEMPLATES.find((t) => t.id === cfg.template);
  const hostNames = cfg.hosts.map((h) => HOSTS.find((x) => x.id === h)?.name ?? h).join(', ');
  const agentRows = AGENTS.filter((a) => cfg.agents.includes(a.id))
    .map((a) => `| \`${a.id}\` | ${a.description} |`)
    .join('\n');
  return `# ${cfg.name}

> ${cfg.description}

Generated with the [metaharness](https://github.com/ruvnet/metaharness) web UI.

- **Template:** ${tmpl?.name ?? cfg.template}
- **Hosts:** ${hostNames}
- **Memory:** ${cfg.memory} · **Routing:** ${cfg.routing} · **Mode:** ${cfg.marketplace}

## Quick start

\`\`\`bash
npm install
npm test
node bin/cli.js doctor
\`\`\`

${agentRows ? `## Agents\n\n| Agent | Role |\n|---|---|\n${agentRows}\n` : ''}
## Publish

\`\`\`bash
npm publish            # ship to npm under your own name
npx ${cfg.name} init   # your users bootstrap the harness
\`\`\`

Built on [@metaharness/kernel](https://www.npmjs.com/package/@metaharness/kernel) — a Rust → WASM + NAPI-RS kernel that runs identically on every platform.
`;
}

const GITIGNORE = `node_modules/\ndist/\n*.tgz\n.env\n.env.*\n!.env.example\n.harness/cache/\n`;

const MIT_LICENSE = `MIT License\n\nCopyright (c) ${new Date().getFullYear()}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction...\n`;
