// SPDX-License-Identifier: MIT
//
// Tests the MCP security scanner against a generated-style harness tree.

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanMcp, mcpScanCmd } from '../src/mcp-scan.js';

async function makeHarness(opts: {
  policy?: Record<string, unknown> | null;
  allow?: string[];
  deny?: string[];
  servers?: Record<string, unknown>;
  deps?: Record<string, string>;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-scan-'));
  await mkdir(join(dir, '.harness'), { recursive: true });
  await mkdir(join(dir, '.claude'), { recursive: true });
  if (opts.policy !== null) {
    await writeFile(join(dir, '.harness', 'mcp-policy.json'), JSON.stringify(opts.policy ?? {}), 'utf-8');
  }
  await writeFile(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify({
      permissions: { allow: opts.allow ?? [], deny: opts.deny ?? ['Read(./.env)'] },
      mcpServers: opts.servers ?? { bot: { command: 'npx' } },
    }),
    'utf-8',
  );
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'bot', dependencies: opts.deps ?? {} }), 'utf-8');
  return dir;
}

const SAFE = {
  defaultDeny: true,
  allowNetwork: false,
  allowShell: false,
  allowFileWrite: false,
  requireApprovalForDangerous: true,
  toolTimeoutMs: 30000,
  maxToolCallsPerTurn: 8,
  auditLog: true,
};

describe('scanMcp', () => {
  it('passes a safe default-deny harness', async () => {
    const dir = await makeHarness({ policy: SAFE, allow: ['mcp__bot__*'], deps: { '@metaharness/kernel': '0.1.0' } });
    const r = scanMcp(dir);
    expect(r.mcpEnabled).toBe(true);
    expect(r.worst).toBe('info');
    expect(r.findings.some((f) => f.id === 'clean')).toBe(true);
  });

  it('flags an MCP server with no policy as HIGH', async () => {
    const dir = await makeHarness({ policy: null, allow: ['mcp__bot__*'] });
    const r = scanMcp(dir);
    expect(r.worst).toBe('high');
    expect(r.findings.some((f) => f.id === 'no-policy')).toBe(true);
  });

  it('flags shell access, missing default-deny, and wildcard perms', async () => {
    const dir = await makeHarness({
      policy: { ...SAFE, defaultDeny: false, allowShell: true },
      allow: ['mcp__*__*'],
    });
    const r = scanMcp(dir);
    const ids = r.findings.map((f) => f.id);
    expect(ids).toContain('no-default-deny');
    expect(ids).toContain('allow-shell');
    expect(ids).toContain('wildcard-tool-perm');
    expect(r.worst).toBe('high');
  });

  it('flags missing audit/timeout, secret exposure, and unpinned deps', async () => {
    const dir = await makeHarness({
      policy: { ...SAFE, auditLog: false, toolTimeoutMs: 0 },
      deny: [],
      deps: { 'left-pad': '^1.0.0', 'is-odd': 'latest' },
    });
    const r = scanMcp(dir);
    const ids = r.findings.map((f) => f.id);
    expect(ids).toContain('no-audit-log');
    expect(ids).toContain('no-timeout');
    expect(ids).toContain('no-secret-guard');
    expect(ids).toContain('unpinned-deps');
    expect(r.worst).toBe('medium');
  });

  it('reports nothing to scan when MCP is absent', async () => {
    const dir = await makeHarness({ policy: null, servers: {} });
    const r = scanMcp(dir);
    expect(r.mcpEnabled).toBe(false);
  });
});

describe('mcpScanCmd', () => {
  it('exits 1 on a HIGH finding and 0 on a clean harness', async () => {
    const bad = await makeHarness({ policy: null, allow: ['mcp__bot__*'] });
    expect(mcpScanCmd([bad]).code).toBe(1);

    const good = await makeHarness({ policy: SAFE, allow: ['mcp__bot__*'], deps: { '@metaharness/kernel': '0.1.0' } });
    const r = mcpScanCmd([good]);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toContain('Result: INFO');
  });

  // Regression for issue #16: --json must emit the structured report (findings[])
  // instead of text, so downstream code can diff findings across runs.
  it('emits structured JSON with findings[] when --json is passed', async () => {
    const bad = await makeHarness({ policy: null, allow: ['mcp__bot__*'] });
    const r = mcpScanCmd([bad, '--json']);
    const parsed = JSON.parse(r.lines.join('\n'));
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(parsed.findings.length).toBeGreaterThan(0);
    expect(r.code).toBe(1);
    // text mode (no --json) must remain non-JSON
    expect(() => JSON.parse(mcpScanCmd([bad]).lines.join('\n'))).toThrow();
  });

  it('resolves the scan path even when --json precedes it', async () => {
    const good = await makeHarness({ policy: SAFE, allow: ['mcp__bot__*'], deps: { '@metaharness/kernel': '0.1.0' } });
    const r = mcpScanCmd(['--json', good]);
    const parsed = JSON.parse(r.lines.join('\n'));
    expect(parsed.dir).toBe(good);
  });
});
