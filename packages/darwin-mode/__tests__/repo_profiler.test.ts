// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileRepo } from '../src/repo_profiler.js';

describe('profileRepo', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'darwin-profile-'));
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'demo',
        packageManager: 'pnpm@9.0.0',
        scripts: { test: 'vitest run' },
      }),
      'utf8',
    );
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'index.ts'), 'export const x = 1;', 'utf8');
    await writeFile(join(root, 'README.md'), '# demo', 'utf8');
    await writeFile(join(root, 'notes.txt'), 'ignored extension', 'utf8');
    await writeFile(join(root, 'deploy.yml'), 'risky', 'utf8'); // not a collected ext
    await writeFile(join(root, 'deploy.json'), '{}', 'utf8'); // collected + risk
    await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'dep', 'a.js'), 'skip me', 'utf8');
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'dist', 'out.js'), 'skip me too', 'utf8');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('detects the package manager from the packageManager field', async () => {
    const p = await profileRepo(root);
    expect(p.packageManager).toBe('pnpm');
  });

  it('prefers the pm-scoped test command when a test script exists', async () => {
    const p = await profileRepo(root);
    expect(p.testCommand).toBe('pnpm test');
  });

  it('collects only known extensions, with paths relative to root', async () => {
    const p = await profileRepo(root);
    expect(p.sourceFiles).toContain('src/index.ts');
    expect(p.sourceFiles).toContain('README.md');
    expect(p.sourceFiles).toContain('package.json');
    expect(p.sourceFiles).toContain('deploy.json');
    expect(p.sourceFiles).not.toContain('notes.txt');
    expect(p.sourceFiles).not.toContain('deploy.yml');
  });

  it('skips node_modules and dist', async () => {
    const p = await profileRepo(root);
    expect(p.sourceFiles.some((f) => f.includes('node_modules'))).toBe(false);
    expect(p.sourceFiles.some((f) => f.startsWith('dist/'))).toBe(false);
  });

  it('flags risk files by path pattern', async () => {
    const p = await profileRepo(root);
    expect(p.riskFiles).toContain('deploy.json');
  });

  it('builds a non-empty one-line summary', async () => {
    const p = await profileRepo(root);
    expect(typeof p.summary).toBe('string');
    expect(p.summary.length).toBeGreaterThan(0);
    expect(p.summary).not.toContain('\n');
  });

  it('falls back to npm test and unknown pm when no package.json', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'darwin-bare-'));
    try {
      await writeFile(join(bare, 'a.ts'), 'export {};', 'utf8');
      const p = await profileRepo(bare);
      expect(p.packageManager).toBe('unknown');
      expect(p.testCommand).toBe('npm test');
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('does not throw on a non-existent root', async () => {
    const p = await profileRepo(join(tmpdir(), 'darwin-does-not-exist-xyz'));
    expect(p.sourceFiles).toEqual([]);
  });
});
