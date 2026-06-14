// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '..');

let compareCmd: (args: string[]) => Promise<{ code: number; lines: string[] }>;
let scaffold: (opts: any) => Promise<any>;

beforeAll(async () => {
  const distDir = resolve(REPO_ROOT, 'packages', 'create-agent-harness', 'dist');
  if (!existsSync(join(distDir, 'compare-cmd.js'))) throw new Error('build first');
  const mod = await import(`file://${join(distDir, 'compare-cmd.js')}`);
  compareCmd = mod.compareCmd;
  const idx = await import(`file://${join(distDir, 'index.js')}`);
  scaffold = idx.scaffold;
});

async function scaffoldMinimal(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `ahg-cmp-${name}-`));
  await scaffold({ name, template: 'minimal', host: 'claude-code', targetDir: dir, force: true, generatorVersion: '0.1.0' });
  return dir;
}

describe('harness compare (iter 105)', () => {
  it('two harnesses with same name + template scaffold IDENTICAL', async () => {
    const a = await scaffoldMinimal('cmp-bot');
    const b = await scaffoldMinimal('cmp-bot');
    try {
      const r = await compareCmd([a, b]);
      expect(r.code).toBe(0);
      expect(r.lines.join('\n')).toContain('IDENTICAL');
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });

  it('two harnesses with different names report DRIFT', async () => {
    const a = await scaffoldMinimal('cmp-a');
    const b = await scaffoldMinimal('cmp-b');
    try {
      const r = await compareCmd([a, b]);
      expect(r.code).toBe(1);
      expect(r.lines.join('\n')).toContain('DRIFT');
      expect(r.lines.join('\n')).toContain('surface:           A=cli B=cli PASS');
      expect(r.lines.join('\n')).toMatch(/changed:\s+\d+ file/);
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });

  it('--bundle emits ADR-031 schema-1 envelope', async () => {
    const a = await scaffoldMinimal('cmp-x');
    const b = await scaffoldMinimal('cmp-y');
    try {
      const r = await compareCmd([a, b, '--bundle']);
      expect(r.code).toBe(1);
      const j = JSON.parse(r.lines.join('\n'));
      expect(j.schema).toBe(1);
      expect(typeof j.generatedAt).toBe('string');
      expect(j.exitCode).toBe(1);
      expect(j.identical).toBe(false);
      expect(j.meta.sameKernel).toBe(true);
      expect(j.files.changed.length).toBeGreaterThan(0);
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });

  it('missing manifest in A emits bundle-formed error (ADR-031 rule 3)', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'ahg-cmp-empty-'));
    const b = await scaffoldMinimal('cmp-real');
    try {
      const r = await compareCmd([empty, b, '--bundle']);
      expect(r.code).toBe(2);
      const j = JSON.parse(r.lines.join('\n'));
      expect(j.schema).toBe(1);
      expect(j.error).toBe('no-manifest-in-a');
    } finally {
      await rm(empty, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });

  it('missing args returns exit 2 with usage', async () => {
    const r = await compareCmd([]);
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toMatch(/Usage: harness compare/);
  });
});
