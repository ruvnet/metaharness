// SPDX-License-Identifier: MIT
//
// ADR-045 — the CLI scaffold now emits each non-claude host's native config.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
