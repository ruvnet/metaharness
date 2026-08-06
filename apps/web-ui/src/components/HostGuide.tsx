import { useState } from 'react';
import { Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';

interface HostStep {
  title: string;
  body: string;
  code?: string;
}

interface HostGuide {
  id: 'claude-code' | 'codex' | 'pi-dev' | 'hermes' | 'openclaw' | 'rvm' | 'copilot' | 'opencode' | 'github-actions' | 'prime-agent';
  name: string;
  blurb: string;
  steps: HostStep[];
}

export const GUIDES: HostGuide[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    blurb: 'Anthropic\'s official terminal CLI. The harness drops in via `.claude/settings.json` + `.claude/commands/`.',
    steps: [
      {
        title: '1. Unzip + install',
        body: 'Unzip the downloaded archive, then install dependencies.',
        code: 'unzip my-harness.zip\ncd my-harness\nnpm install',
      },
      {
        title: '2. Run with Claude Code',
        body: 'Open the harness directory in your terminal — Claude Code picks up `.claude/settings.json` automatically.',
        code: 'claude code',
      },
      {
        title: '3. Verify the agents loaded',
        body: 'Claude Code will report the registered slash commands and MCP servers on startup. If you see warnings about missing permissions, the harness\'s allow/deny lists are documented in `.claude/settings.json`.',
      },
    ],
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    blurb: 'OpenAI\'s coding agent. The harness emits a `.codex/config.toml` and matching skills folder.',
    steps: [
      {
        title: '1. Unzip + install',
        body: 'Same as Claude Code.',
        code: 'unzip my-harness.zip\ncd my-harness\nnpm install',
      },
      {
        title: '2. Point Codex at the config',
        body: 'Symlink or copy `.codex/config.toml` to your global Codex config location.',
        code: 'cp .codex/config.toml ~/.codex/config.toml',
      },
      {
        title: '3. Launch',
        body: 'Start a Codex session in the harness directory — the registered tools appear in the agent\'s tool list.',
        code: 'codex',
      },
    ],
  },
  {
    id: 'pi-dev',
    name: 'pi.dev',
    blurb: 'Badlogic\'s pi-mono monorepo agent. Harness drops `AGENTS.md` + matching `.pi/` config.',
    steps: [
      {
        title: '1. Install pi',
        body: 'See the pi-mono README for the latest install instructions.',
        code: 'npm install -g @badlogic/pi',
      },
      {
        title: '2. Run inside the harness',
        body: 'pi auto-discovers `AGENTS.md` and the agents directory.',
        code: 'cd my-harness\npi',
      },
    ],
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    blurb: 'Nous Research\'s open-weights agent runtime. Harness emits `cli-config.yaml`.',
    steps: [
      {
        title: '1. Install Hermes CLI',
        body: 'See the Hermes Agent docs for the latest install.',
      },
      {
        title: '2. Launch',
        body: 'Hermes reads `cli-config.yaml` from the working directory.',
        code: 'cd my-harness\nhermes',
      },
    ],
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    blurb: 'Personal-AI fork. Harness emits OpenClaw policy + plugin manifest.',
    steps: [
      {
        title: '1. Install OpenClaw',
        body: 'Refer to https://github.com/openclaw/openclaw for the current install steps.',
      },
      {
        title: '2. Load the harness',
        body: 'Point OpenClaw at the harness directory; it picks up `.openclaw/policy.yml`.',
        code: 'openclaw run --harness ./my-harness',
      },
    ],
  },
  {
    id: 'rvm',
    name: 'RVM',
    blurb: 'Microhypervisor for hardware-isolated agents. Harness emits an `rvm-partition.toml`.',
    steps: [
      {
        title: '1. Install RVM',
        body: 'See https://github.com/ruvnet/rvm for the install path.',
      },
      {
        title: '2. Launch partition',
        body: 'RVM creates an isolated tenant from the harness manifest.',
        code: 'rvm launch --partition ./rvm-partition.toml',
      },
    ],
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    blurb: 'VSCode 1.99+ with the Copilot Chat extension. Harness emits `.vscode/mcp.json` and an `install.md` runbook (ADR-032).',
    steps: [
      {
        title: '1. Open the harness folder in VSCode',
        body: 'Trust the workspace when prompted — VSCode requires it before loading .vscode/mcp.json.',
        code: 'code ./my-harness',
      },
      {
        title: '2. Verify MCP servers loaded',
        body: 'Open the Copilot Chat panel, run /mcp to list registered MCP servers.',
      },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    blurb: 'sst/opencode — the open-source TUI agent. Harness emits `.opencode/opencode.json` with $schema-anchored MCP config (ADR-036).',
    steps: [
      {
        title: '1. Install OpenCode + log in',
        body: 'See https://opencode.ai for install, then run `opencode auth login` to set a model provider.',
        code: 'opencode auth login',
      },
      {
        title: '2. Boot from the harness folder',
        body: 'OpenCode reads .opencode/opencode.json on startup; /mcp verifies servers loaded.',
        code: 'cd ./my-harness && opencode',
      },
    ],
  },
  {
    id: 'github-actions',
    name: 'GitHub Actions',
    blurb: 'The first non-interactive host (ADR-033). Harness emits `.github/workflows/<name>.yml` + a composite `action.yml` — runs autonomously on the runner, no human at the keyboard.',
    steps: [
      {
        title: '1. Commit the workflow + action',
        body: 'Both files land under .github/. Push them to your default branch to register the workflow.',
        code: 'git add .github && git commit -m "add harness workflow" && git push',
      },
      {
        title: '2. Add your provider key + trigger',
        body: 'Add ANTHROPIC_API_KEY as a repo secret (Settings → Secrets → Actions), then run it from the Actions tab or by commenting on an issue. Default permissions are contents:read (ADR-022 default-deny).',
        code: 'gh workflow run my-harness',
      },
    ],
  },
  {
    id: 'prime-agent',
    name: 'Prime Agent',
    blurb: 'Prime Intellect\'s IPython-based harness. MetaHarness emits project skills, native `rlm` delegation, and remote HTTP MCP integrations (ADR-242).',
    steps: [
      {
        title: '1. Install Prime Agent',
        body: 'Install via the upstream curl installer, then confirm the CLI is on your PATH.',
        code: 'curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh\nprime-agent --version',
      },
      {
        title: '2. Run from the harness repo root',
        body: 'Prime Agent discovers project-scoped skills from `.prime/agent/skills/` — launch it from the repo root so the project scope is picked up.',
        code: 'cd my-harness\nprime-agent',
      },
      {
        title: '3. Heed the sandbox warning',
        body: 'Prime Agent is not sandboxed and cannot enforce a deny-list natively. If your scaffold contains SANDBOX-REQUIRED.md, run only inside an external sandbox (container / RVM) — details in install-prime-agent.md.',
      },
    ],
  },
];

interface HostGuideProps {
  hosts: ReadonlyArray<string>;
}

function StepCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border border-ink-700 bg-ink-950/60 p-3 text-xs text-slate-300">
        {code}
      </pre>
      <button
        aria-label="Copy code"
        onClick={() => {
          navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }).catch(() => {});
        }}
        className="absolute right-2 top-2 rounded-md border border-ink-700 bg-ink-800 p-1 text-slate-400 transition hover:border-ink-600 hover:text-white"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}

function HostGuideCard({ guide }: { guide: HostGuide }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900/40">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start justify-between gap-3 p-4 text-left"
      >
        <div>
          <div className="text-sm font-medium text-white">{guide.name}</div>
          <div className="mt-1 text-xs text-slate-400">{guide.blurb}</div>
        </div>
        <div className="flex-shrink-0 pt-0.5 text-slate-400">
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </button>
      {open && (
        <div className="border-t border-ink-700/60 p-4 pt-3">
          <ol className="space-y-3">
            {guide.steps.map((s, i) => (
              <li key={i} className="text-sm text-slate-300">
                <div className="mb-1 font-medium text-white">{s.title}</div>
                <div className="mb-2 text-xs text-slate-400">{s.body}</div>
                {s.code && <StepCode code={s.code} />}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/** Per-host integration guide. Renders only the hosts the user actually
 *  selected for their harness. */
export function HostGuide({ hosts }: HostGuideProps) {
  const relevant = GUIDES.filter((g) => hosts.includes(g.id));
  if (relevant.length === 0) {
    return null;
  }
  return (
    <div className="mt-6 rounded-xl border border-ink-700 bg-ink-900/50 p-4 sm:p-5">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-white">How to use your harness — per host</h3>
        <p className="mt-1 text-xs text-slate-400">
          You selected {relevant.length} host{relevant.length === 1 ? '' : 's'}. Expand each for the unzip + install + launch flow.
        </p>
      </div>
      <div className="space-y-2">
        {relevant.map((g) => (
          <HostGuideCard key={g.id} guide={g} />
        ))}
      </div>
    </div>
  );
}
