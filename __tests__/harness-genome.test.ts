// SPDX-License-Identifier: MIT
//
// iter 110 — `harness genome <repo>` (18th subcommand). The user's named
// "strongest next commit": readiness scorecard on top of analyze-repo.
//
// What we lock down here:
//  1. Default text mode produces all 7 sections labelled per the user's spec.
//  2. --json emits ONLY the 6-field scorecard shape the user named.
//  3. --bundle emits an ADR-031 schema-1 envelope.
//  4. --out writes the 6-field scorecard JSON to a file.
//  5. Missing target dir is bundle-formed (ADR-031 rule 3).
//  6. Missing args returns exit 2 with usage.
//  7. The scorers stay deterministic (same input → same output).
//  8. Empty/unknown repo classifies as 'unknown' but doesn't crash.

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '..');

let genomeCmd: (args: string[]) => Promise<{ code: number; lines: string[] }>;
let buildGenomeReport: (dir: string, generatedAt?: string) => any;

beforeAll(async () => {
  const distDir = resolve(REPO_ROOT, 'packages', 'create-agent-harness', 'dist');
  if (!existsSync(join(distDir, 'genome.js'))) throw new Error('build first: cd packages/create-agent-harness && npm run build');
  const mod = await import(`file://${join(distDir, 'genome.js')}`);
  genomeCmd = mod.genomeCmd;
  buildGenomeReport = mod.buildGenomeReport;
});

async function makeNodeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ahg-genome-node-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'demo-repo',
    version: '0.0.0',
    scripts: { build: 'tsc', test: 'vitest run' },
  }), 'utf-8');
  await writeFile(join(dir, 'README.md'), '# demo-repo\n\nA TypeScript SDK for talking to MCP servers.\n', 'utf-8');
  await mkdir(join(dir, '.github', 'workflows'), { recursive: true });
  await writeFile(join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n', 'utf-8');
  return dir;
}

async function makeEmptyRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ahg-genome-empty-'));
}

describe('harness genome (iter 110)', () => {
  it('default text mode produces all 7 sections on a real Node repo', async () => {
    const dir = await makeNodeRepo();
    try {
      const r = await genomeCmd([dir]);
      const out = r.lines.join('\n');
      // The 7 sections, in order, per the user's spec.
      expect(out).toContain('1. Repo profile');
      expect(out).toContain('2. Agent topology');
      expect(out).toContain('3. MCP risk model');
      expect(out).toContain('4. Test confidence');
      expect(out).toContain('5. Release readiness');
      expect(out).toContain('6. Recommended harness plan');
      expect(out).toContain('7. Scorecard');
      // The footer must surface the scaffold command using the iter-108 rename.
      expect(out).toMatch(/npx openharness /);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--json emits ONLY the 6-field scorecard shape', async () => {
    const dir = await makeNodeRepo();
    try {
      const r = await genomeCmd([dir, '--json']);
      const j = JSON.parse(r.lines.join('\n'));
      const keys = Object.keys(j).sort();
      // Exact shape the user named in the roadmap.
      expect(keys).toEqual(['agent_topology', 'mcp_surface', 'publish_readiness', 'repo_type', 'risk_score', 'test_confidence']);
      expect(typeof j.repo_type).toBe('string');
      expect(Array.isArray(j.agent_topology)).toBe(true);
      expect(j.risk_score).toBeGreaterThanOrEqual(0);
      expect(j.risk_score).toBeLessThanOrEqual(1);
      expect(['local_default_deny', 'local_permissive', 'remote', 'off']).toContain(j.mcp_surface);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--bundle emits an ADR-031 schema-1 envelope', async () => {
    const dir = await makeNodeRepo();
    try {
      const r = await genomeCmd([dir, '--bundle']);
      const j = JSON.parse(r.lines.join('\n'));
      expect(j.schema).toBe(1);
      expect(typeof j.generatedAt).toBe('string');
      expect(j.dir).toBeDefined();
      expect(j.genome).toBeDefined();
      expect(j.genome.repo_type).toBeDefined();
      expect(j.profile).toBeDefined();
      expect(j.plan).toBeDefined();
      expect(['ready', 'needs-work', 'blocked']).toContain(j.verdict);
      expect([0, 1, 2]).toContain(j.exitCode);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--out writes the 6-field scorecard JSON to a file', async () => {
    const dir = await makeNodeRepo();
    const outPath = join(dir, 'genome.json');
    try {
      const r = await genomeCmd([dir, '--out', outPath]);
      expect([0, 1, 2]).toContain(r.code);
      expect(existsSync(outPath)).toBe(true);
      const j = JSON.parse(readFileSync(outPath, 'utf-8'));
      // The file gets the 6-field scorecard only, not the full envelope.
      expect(Object.keys(j).sort()).toEqual(['agent_topology', 'mcp_surface', 'publish_readiness', 'repo_type', 'risk_score', 'test_confidence']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('missing target dir is bundle-formed (ADR-031 rule 3)', async () => {
    const r = await genomeCmd(['/nonexistent/path/xyz123', '--bundle']);
    expect(r.code).toBe(2);
    const j = JSON.parse(r.lines.join('\n'));
    expect(j.schema).toBe(1);
    expect(j.error).toBe('not-a-directory');
  });

  it('missing args returns exit 2 with usage', async () => {
    const r = await genomeCmd([]);
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toMatch(/Usage: harness genome/);
  });

  it('scorer is deterministic — same repo, same scorecard', async () => {
    const dir = await makeNodeRepo();
    try {
      const a = buildGenomeReport(dir, '2026-01-01T00:00:00Z');
      const b = buildGenomeReport(dir, '2026-01-01T00:00:00Z');
      expect(a.genome).toEqual(b.genome);
      expect(a.exitCode).toBe(b.exitCode);
      expect(a.verdict).toBe(b.verdict);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('empty repo gets a valid scorecard with repo_type=unknown', async () => {
    const dir = await makeEmptyRepo();
    try {
      const r = await genomeCmd([dir, '--json']);
      const j = JSON.parse(r.lines.join('\n'));
      expect(j.repo_type).toContain('unknown');
      // No tests, no CI → low confidence + readiness, valid bounds.
      expect(j.test_confidence).toBe(0);
      expect(j.publish_readiness).toBeLessThan(0.5);
      // Even an empty repo gets at least the maintainer role.
      expect(j.agent_topology).toContain('maintainer');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
