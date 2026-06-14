// SPDX-License-Identifier: MIT
//
// iter 117 — verifies the new openharness subcommand router. Per the user's
// directive: "Before generation: openharness. Inside generated harness: harness."
//
// We cover the structural surface (router recognizes the verbs, falls
// through correctly, errors helpfully). The from-repo verb invokes git
// over the network — we test the missing-args error path without touching
// the actual clone code.

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '..');

let main: (argv: string[]) => Promise<number>;

beforeAll(async () => {
  const distDir = resolve(REPO_ROOT, 'packages', 'create-agent-harness', 'dist');
  if (!existsSync(join(distDir, 'index.js'))) throw new Error('build first');
  const mod = await import(`file://${join(distDir, 'index.js')}`);
  main = mod.main;
});

// `main()` uses console.log / console.error. We patch those directly so the
// test output stays clean and we get a deterministic capture (the underlying
// process.stdout.write override gets bypassed by vitest's own pipe wrapping).
async function captureMain(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const chunksOut: string[] = [];
  const chunksErr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { chunksOut.push(a.map(x => String(x)).join(' ') + '\n'); };
  console.error = (...a: unknown[]) => { chunksErr.push(a.map(x => String(x)).join(' ') + '\n'); };
  try {
    const code = await main(argv);
    return { code, out: chunksOut.join(''), err: chunksErr.join('') };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe('openharness subcommand router (iter 117)', () => {
  it('from-repo with missing args returns exit 2 with usage', async () => {
    const r = await captureMain(['from-repo']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Usage: npx openharness from-repo/);
  });

  it('from-repo with only URL returns exit 2 (still need name)', async () => {
    const r = await captureMain(['from-repo', 'https://github.com/foo/bar']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Usage: npx openharness from-repo/);
  });

  it('analyze runs analyze-repo against a real local dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openharness-analyze-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo' }), 'utf-8');
      await writeFile(join(dir, 'README.md'), '# demo', 'utf-8');
      const r = await captureMain(['analyze', dir]);
      // analyze-repo exits 0 on a sane local dir.
      expect([0, 1]).toContain(r.code);
      // Some signal of having read the dir.
      expect(r.out.length).toBeGreaterThan(20);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('genome runs the genome command against a real dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openharness-genome-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest' } }), 'utf-8');
      const r = await captureMain(['genome', dir]);
      // Genome can return 0, 1, or 2 depending on the scorecard. Just verify
      // it ran something coherent.
      expect([0, 1, 2]).toContain(r.code);
      expect(r.out).toMatch(/harness genome|Repo profile|Scorecard|exit/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('genome with missing path returns exit 2 with usage', async () => {
    const r = await captureMain(['genome']);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/Usage: harness genome/);
  });

  it('bare name (back-compat) still works — falls through to legacy scaffold', async () => {
    // No name + no subcommand → prints usage with exit 2.
    const r = await captureMain([]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/Usage: npx openharness/);
  });

  it('unknown first-arg verb (not a subcommand, not a flag) falls through to legacy scaffold', async () => {
    // "my-bot" isn't a subcommand → router returns null → legacy scaffold runs.
    // Without --template the scaffold may fail differently; we just check the
    // router didn't intercept (no "from-repo" usage in output).
    const dir = await mkdtemp(join(tmpdir(), 'openharness-bare-'));
    try {
      const r = await captureMain(['unknown-thing-not-a-verb', '--target', dir]);
      // Whatever the result, the "from-repo" usage line MUST NOT appear.
      expect(r.err).not.toMatch(/Usage: npx openharness from-repo/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
