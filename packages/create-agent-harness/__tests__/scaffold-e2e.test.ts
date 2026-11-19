// SPDX-License-Identifier: MIT
//
// End-to-end scaffold test. Runs the full pipeline against the minimal and
// vertical:devops templates in a tmp directory, then asserts the output
// has the structure we expect.

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold, detectRufloProject, parseArgs } from '../src/index.js';

async function tmpRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe('scaffold (e2e)', () => {
  it('scaffolds the minimal template into a tmp dir', async () => {
    const root = await tmpRoot('e2e-min-');
    const target = join(root, 'my-bot');
    const r = await scaffold({
      name: 'my-bot',
      template: 'minimal',
      host: 'claude-code',
      description: 'test bot',
      targetDir: target,
      generatorVersion: '0.1.0',
    });

    expect(r.paths.length).toBeGreaterThan(0);
    expect(r.paths).toContain('package.json');
    expect(r.paths).toContain('CLAUDE.md');
    expect(r.paths).toContain('.harness/manifest.json');
    expect(r.paths).toContain('.harness/manifest.sha256');
    expect(r.unresolved).toEqual([]);

    const pkg = await readFile(join(target, 'package.json'), 'utf-8');
    expect(pkg).toContain('"name": "my-bot"');
    expect(pkg).toContain('@metaharness/host-claude-code');

    const claudeMd = await readFile(join(target, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('# my-bot');
    expect(claudeMd).toContain('test bot');

    const manifest = JSON.parse(
      await readFile(join(target, '.harness', 'manifest.json'), 'utf-8'),
    );
    expect(manifest.schema).toBe(1);
    expect(manifest.template).toBe('minimal');
    expect(manifest.vars.name).toBe('my-bot');
    expect(manifest.hosts).toEqual(['claude-code']);
    expect(Object.keys(manifest.files).length).toBeGreaterThan(0);
  });

  it('scaffolds the vertical:devops template with 4 agent files', async () => {
    const root = await tmpRoot('e2e-devops-');
    const target = join(root, 'ops-bot');
    const r = await scaffold({
      name: 'ops-bot',
      template: 'vertical:devops',
      host: 'claude-code',
      targetDir: target,
      generatorVersion: '0.1.0',
    });
    expect(r.paths).toContain('src/agents/responder.ts');
    expect(r.paths).toContain('src/agents/runbook-runner.ts');
    expect(r.paths).toContain('src/agents/escalator.ts');
    expect(r.paths).toContain('src/agents/postmortem.ts');
    expect(r.paths).toContain('runbooks/README.md');

    const responder = await readFile(join(target, 'src/agents/responder.ts'), 'utf-8');
    expect(responder).toContain('on-call responder for ops-bot');

    const settings = JSON.parse(
      await readFile(join(target, '.claude/settings.json'), 'utf-8'),
    );
    expect(settings.mcpServers['ops-bot']).toBeDefined();
    // Only advertise the server actually shipped; no placeholder alert/store services.
    expect(Object.keys(settings.mcpServers)).toEqual(['ops-bot']);
    // Sanity-check the deny list.
    expect(settings.permissions.deny).toContain('Bash(rm *)');
  });

  it('refuses to overwrite an existing dir without --force', async () => {
    const root = await tmpRoot('e2e-noforce-');
    const target = join(root, 'my-bot');
    await scaffold({
      name: 'my-bot', template: 'minimal', host: 'claude-code',
      targetDir: target, generatorVersion: '0.1.0',
    });
    await expect(scaffold({
      name: 'my-bot', template: 'minimal', host: 'claude-code',
      targetDir: target, generatorVersion: '0.1.0',
    })).rejects.toThrow(/already exists/);
  });

  it('overwrites with --force', async () => {
    const root = await tmpRoot('e2e-force-');
    const target = join(root, 'my-bot');
    await scaffold({
      name: 'my-bot', template: 'minimal', host: 'claude-code',
      targetDir: target, generatorVersion: '0.1.0',
    });
    const r = await scaffold({
      name: 'my-bot', template: 'minimal', host: 'claude-code',
      targetDir: target, force: true, generatorVersion: '0.1.0',
    });
    expect(r.paths.length).toBeGreaterThan(0);
  });

  it('rejects an invalid harness name early', async () => {
    const root = await tmpRoot('e2e-bad-');
    await expect(scaffold({
      name: 'BadName',
      template: 'minimal',
      host: 'claude-code',
      targetDir: join(root, 'BadName'),
      generatorVersion: '0.1.0',
    })).rejects.toThrow(/invalid harness name/);
  });

  it('rejects an unknown template', async () => {
    const root = await tmpRoot('e2e-tpl-');
    await expect(scaffold({
      name: 'x',
      template: 'vertical:not-real',
      host: 'claude-code',
      targetDir: join(root, 'x'),
      generatorVersion: '0.1.0',
    })).rejects.toThrow(/unknown template/);
  });
});

// Dream Cycle 2026-10-18 (security-adversarial): ADR-022 requires a
// default-deny `.harness/mcp-policy.json` whenever MCP is on; the CLI
// scaffolder registered every template's self-referential MCP server in
// `.claude/settings.json` but never wrote this file (disclosed-but-unfixed
// since 2026-09-08, issue #297/#298) — confirmed live: a fresh `minimal`
// scaffold scanned HIGH ("MCP server with no policy") via `harness mcp-scan`.
describe('scaffold — ADR-022 default-deny mcp-policy.json (Dream Cycle 2026-10-18)', () => {
  it('emits .harness/mcp-policy.json with the ADR-022 safe-default shape when the harness registers an MCP server', async () => {
    const root = await tmpRoot('e2e-mcp-policy-');
    const target = join(root, 'my-bot');
    const r = await scaffold({
      name: 'my-bot', template: 'minimal', host: 'claude-code',
      targetDir: target, generatorVersion: '0.1.0',
    });
    expect(r.paths).toContain('.harness/mcp-policy.json');

    const settings = JSON.parse(await readFile(join(target, '.claude/settings.json'), 'utf-8'));
    expect(Object.keys(settings.mcpServers ?? {}).length).toBeGreaterThan(0);

    const policy = JSON.parse(await readFile(join(target, '.harness/mcp-policy.json'), 'utf-8'));
    expect(policy).toEqual({
      defaultDeny: true,
      allowNetwork: false,
      allowShell: false,
      allowFileWrite: false,
      requireApprovalForDangerous: true,
      toolTimeoutMs: 30000,
      maxToolCallsPerTurn: 8,
      auditLog: true,
    });

    // The new file must be covered by the manifest's own fingerprint list —
    // same provenance guarantee (ADR-011 witness) as every other rendered file.
    const manifest = JSON.parse(await readFile(join(target, '.harness', 'manifest.json'), 'utf-8'));
    expect(manifest.files['.harness/mcp-policy.json']).toBeDefined();
  });

  it('a freshly scaffolded harness scans clean of the no-policy HIGH finding (mcp-scan, ADR-022 test contract)', async () => {
    const root = await tmpRoot('e2e-mcp-scan-');
    const target = join(root, 'scanned-bot');
    await scaffold({
      name: 'scanned-bot', template: 'minimal', host: 'claude-code',
      targetDir: target, generatorVersion: '0.1.0',
    });
    const { scanMcp } = await import('../src/mcp-scan.js');
    const report = scanMcp(target);
    expect(report.mcpEnabled).toBe(true);
    expect(report.findings.some(f => f.id === 'no-policy')).toBe(false);
    expect(report.worst).not.toBe('high');
  });

  it('omits the policy for a pi-dev harness with no MCP registration', async () => {
    const root = await tmpRoot('e2e-mcp-off-');
    const target = join(root, 'pi-bot');
    const r = await scaffold({
      name: 'pi-bot', template: 'minimal', host: 'pi-dev',
      targetDir: target, generatorVersion: '0.1.0',
    });
    expect(r.paths).not.toContain('.claude/settings.json');
    expect(r.paths).not.toContain('.harness/mcp-policy.json');
  });

  it('every one of the 20 shipped templates scans clean of the no-policy HIGH finding', async () => {
    const { TEMPLATES } = await import('../src/index.js');
    const { scanMcp } = await import('../src/mcp-scan.js');
    for (const t of TEMPLATES) {
      const root = await tmpRoot(`e2e-mcp-all-${t.replace(/[^a-z0-9]/gi, '_')}-`);
      const target = join(root, 'bot');
      await scaffold({
        name: 'bot', template: t, host: 'claude-code',
        targetDir: target, generatorVersion: '0.1.0',
      });
      const report = scanMcp(target);
      expect(report.findings.some(f => f.id === 'no-policy'), `template ${t} still flags no-policy`).toBe(false);
    }
    // 20 full scaffolds to disk in one test: Windows file I/O under parallel test
    // load can exceed the 5 s default, so this test gets an explicit budget.
  }, 30_000);
});

describe('detectRufloProject', () => {
  it('returns found: false on an empty dir', async () => {
    const root = await tmpRoot('e2e-detect-');
    expect(detectRufloProject(root)).toEqual({ found: false, signals: [] });
  });
});

describe('parseArgs — iter 4 additions', () => {
  it('parses --force / -f', () => {
    expect(parseArgs(['x', '-f']).force).toBe(true);
    expect(parseArgs(['x', '--force']).force).toBe(true);
  });

  it('parses --description / -d', () => {
    expect(parseArgs(['x', '-d', 'thing']).description).toBe('thing');
    expect(parseArgs(['x', '--description', 'thing']).description).toBe('thing');
  });

  it('parses --from-existing with an explicit path', () => {
    expect(parseArgs(['--from-existing', '/some/path']).fromExisting).toBe('/some/path');
  });
});
