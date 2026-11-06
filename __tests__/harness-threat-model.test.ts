// SPDX-License-Identifier: MIT
//
// iter 112 — `harness threat-model <path>` (20th subcommand). Priority 5
// from the user's roadmap, labelled "enterprise gold." Renders the existing
// mcp-scan findings as a clean scannable threat-model artifact ready for
// a PR or compliance review.

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '..');

let threatModelCmd: (args: string[]) => Promise<{ code: number; lines: string[] }>;

beforeAll(async () => {
  const distDir = resolve(REPO_ROOT, 'packages', 'create-agent-harness', 'dist');
  if (!existsSync(join(distDir, 'threat-model.js'))) throw new Error('build first');
  const mod = await import(`file://${join(distDir, 'threat-model.js')}`);
  threatModelCmd = mod.threatModelCmd;
});

async function makeNoMcpRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ahg-tm-nomcp-'));
}

async function makeSafePolicyRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ahg-tm-safe-'));
  await mkdir(join(dir, '.harness'), { recursive: true });
  await writeFile(join(dir, '.harness', 'mcp-policy.json'), JSON.stringify({
    defaultDeny: true,
    auditLog: true,
    allowShell: false,
    allowNetwork: false,
    allowFileWrite: false,
    requireApprovalForDangerous: true,
    maxToolCallsPerTurn: 8,
    toolTimeoutMs: 30000,
  }), 'utf-8');
  await mkdir(join(dir, '.claude'), { recursive: true });
  await writeFile(join(dir, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['Read(./src/**)'], deny: ['Read(./.env*)'] },
  }), 'utf-8');
  return dir;
}

async function makeRiskyPolicyRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ahg-tm-risky-'));
  await mkdir(join(dir, '.harness'), { recursive: true });
  // High-severity: shell on + default-deny off.
  await writeFile(join(dir, '.harness', 'mcp-policy.json'), JSON.stringify({
    defaultDeny: false,
    auditLog: false,
    allowShell: true,
    allowNetwork: true,
    allowFileWrite: true,
  }), 'utf-8');
  await mkdir(join(dir, '.claude'), { recursive: true });
  await writeFile(join(dir, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['Read(./**)', 'Bash(rm:*)'], deny: [] },
  }), 'utf-8');
  return dir;
}

describe('harness threat-model (iter 112)', () => {
  it('safe policy grades CLEAN with exit 0', async () => {
    const dir = await makeSafePolicyRepo();
    try {
      const r = await threatModelCmd([dir]);
      expect(r.code).toBe(0);
      const out = r.lines.join('\n');
      expect(out).toContain('MCP Threat Model');
      expect(out).toContain('Verdict: clean');
      expect(out).toContain('Shell access:         no');
      expect(out).toContain('Default-deny policy:  yes');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('risky policy grades HIGH with exit 2 + dangerous count surfaces', async () => {
    const dir = await makeRiskyPolicyRepo();
    try {
      const r = await threatModelCmd([dir]);
      expect(r.code).toBe(2);
      const out = r.lines.join('\n');
      expect(out).toContain('Verdict: high');
      expect(out).toContain('Shell access:         yes');
      // shell + network + file-write + secrets-reachable + default-deny-off → 5
      expect(out).toMatch(/Dangerous permissions: [3-5]/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('no MCP in use → clean, "MCP is not in use" copy', async () => {
    const dir = await makeNoMcpRepo();
    try {
      const r = await threatModelCmd([dir]);
      expect(r.code).toBe(0);
      const out = r.lines.join('\n');
      expect(out).toContain('MCP is not in use');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--json emits the full ThreatModel envelope', async () => {
    const dir = await makeSafePolicyRepo();
    try {
      const r = await threatModelCmd([dir, '--json']);
      const j = JSON.parse(r.lines.join('\n'));
      expect(j.schema).toBe(1);
      expect(j.mcpInUse).toBe(true);
      expect(j.policyDefaultDeny).toBe(true);
      expect(j.shellAccess).toBe(false);
      expect(j.verdict).toBe('clean');
      expect(j.exitCode).toBe(0);
      expect(Array.isArray(j.findings)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--bundle emits an ADR-031 schema-1 envelope on a risky scaffold', async () => {
    const dir = await makeRiskyPolicyRepo();
    try {
      const r = await threatModelCmd([dir, '--bundle']);
      const j = JSON.parse(r.lines.join('\n'));
      expect(j.schema).toBe(1);
      expect(typeof j.generatedAt).toBe('string');
      expect(j.exitCode).toBe(2);
      expect(j.verdict).toBe('high');
      expect(j.shellAccess).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--out writes the JSON artifact to a file', async () => {
    const dir = await makeSafePolicyRepo();
    const outPath = join(dir, 'threat-model.json');
    try {
      const r = await threatModelCmd([dir, '--out', outPath]);
      expect(r.code).toBe(0);
      expect(existsSync(outPath)).toBe(true);
      const j = JSON.parse(readFileSync(outPath, 'utf-8'));
      expect(j.schema).toBe(1);
      expect(j.verdict).toBe('clean');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('missing target dir is bundle-formed (ADR-031 rule 3)', async () => {
    const r = await threatModelCmd(['/nonexistent/path/xyz999', '--bundle']);
    expect(r.code).toBe(2);
    const j = JSON.parse(r.lines.join('\n'));
    expect(j.schema).toBe(1);
    expect(j.error).toBe('not-a-directory');
  });

  it('missing args returns exit 2 with usage', async () => {
    const r = await threatModelCmd([]);
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toMatch(/Usage: harness threat-model/);
  });
});
