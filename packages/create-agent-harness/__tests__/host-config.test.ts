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
    expect(json.mcp.permissions.allow).toContain('mcp__demo-bot__*');
    expect(json.mcp.permissions.deny).toContain('Read(./.env)');
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

  it('pi-dev emits trust.json + copilot emits copilot-instructions.md', () => {
    expect(hostConfigFiles('pi-dev', base).map((f) => f.path)).toContain('trust.json');
    expect(hostConfigFiles('copilot', base).map((f) => f.path)).toContain('.github/copilot-instructions.md');
  });

  it('allowShell widens the allow list to Bash(*)', () => {
    const json = JSON.parse(hostConfigFiles('opencode', { ...base, allowShell: true }).find((f) => f.path === '.opencode/opencode.json')!.content);
    expect(json.mcp.permissions.allow).toContain('Bash(*)');
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
    expect(json.mcp.permissions.deny).toContain('Read(./.env)');
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
});
