// SPDX-License-Identifier: MIT
// Regression tests for the atomic writer, incl. GH #42 (Windows EXDEV: staging
// must not depend on os.tmpdir() being on the same drive as the target).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic } from '../src/writer.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'writer-test-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /**/ } });

const files = [
  { path: 'package.json', content: '{"name":"x"}', rendered: false, unresolved: [] },
  { path: 'src/index.ts', content: 'export const x = 1;\n', rendered: false, unresolved: [] },
];

describe('writeAtomic', () => {
  it('writes all files under the target', async () => {
    const target = join(root, 'proj');
    const written = await writeAtomic(target, files);
    expect(written).toEqual(['package.json', 'src/index.ts']);
    expect(readFileSync(join(target, 'package.json'), 'utf-8')).toContain('"name":"x"');
    expect(readFileSync(join(target, 'src/index.ts'), 'utf-8')).toContain('export const x');
  });

  it('GH #42: stages adjacent to the target and leaves no staging residue', async () => {
    const target = join(root, 'proj');
    await writeAtomic(target, files);
    // the staging dir (.create-agent-harness-*) lived in the target's PARENT
    // (same drive), not os.tmpdir(); after success it must be gone (renamed in).
    const residue = readdirSync(root).filter(n => n.startsWith('.create-agent-harness-'));
    expect(residue).toEqual([]);
    expect(existsSync(target)).toBe(true);
  });

  it('refuses to overwrite an existing target without force', async () => {
    const target = join(root, 'proj');
    await writeAtomic(target, files);
    await expect(writeAtomic(target, files)).rejects.toThrow(/already exists/);
  });

  it('overwrites with force and cleans up staging', async () => {
    const target = join(root, 'proj');
    await writeAtomic(target, files);
    const next = [{ path: 'package.json', content: '{"name":"y"}', rendered: false, unresolved: [] }];
    await writeAtomic(target, next, { force: true });
    expect(readFileSync(join(target, 'package.json'), 'utf-8')).toContain('"name":"y"');
    expect(existsSync(join(target, 'src/index.ts'))).toBe(false); // replaced, not merged
    expect(readdirSync(root).filter(n => n.startsWith('.create-agent-harness-'))).toEqual([]);
  });

  it('creates intermediate parent directories of the target', async () => {
    const target = join(root, 'a', 'b', 'proj');
    await writeAtomic(target, files);
    expect(existsSync(join(target, 'package.json'))).toBe(true);
  });

  // Regression: RenderedFile.path is produced by whatever assembled the
  // RenderedFile[] (walkTemplate today; host-adapter generateConfig() output
  // in future wiring per ADR-046's injection-bug class), and writeAtomic
  // previously trusted it verbatim. A `../`-shaped path escaped the staging
  // dir via `join()`'s normalization and could write outside the intended
  // target directory entirely.
  describe('path traversal (ADR-046 bug class)', () => {
    it('refuses a file path that escapes the target directory', async () => {
      const target = join(root, 'proj');
      const escapee = randomTraversalName();
      const malicious = [
        { path: `../../../${escapee}`, content: 'pwned', rendered: false, unresolved: [] },
      ];
      await expect(writeAtomic(target, malicious)).rejects.toThrow(/outside the target directory/);
      expect(existsSync(join(root, escapee))).toBe(false);
      expect(existsSync(join(target, '..', '..', escapee))).toBe(false);
    });

    it('refuses a mixed batch (one safe file, one traversal) without writing either to the final target', async () => {
      const target = join(root, 'proj');
      const escapee = randomTraversalName();
      const mixed = [
        { path: 'package.json', content: '{"name":"x"}', rendered: false, unresolved: [] },
        { path: `../${escapee}`, content: 'pwned', rendered: false, unresolved: [] },
      ];
      await expect(writeAtomic(target, mixed)).rejects.toThrow(/outside the target directory/);
      expect(existsSync(target)).toBe(false);
      expect(existsSync(join(root, escapee))).toBe(false);
    });

    it('refuses an absolute path (never silently re-rooted inside the target)', async () => {
      const target = join(root, 'proj');
      const absolute = [
        { path: '/etc/passwd-not-really', content: 'pwned', rendered: false, unresolved: [] },
      ];
      await expect(writeAtomic(target, absolute)).rejects.toThrow(/outside the target directory/);
      expect(existsSync(target)).toBe(false);
    });

    it.each([
      ['Windows drive-absolute', 'C:\\Windows\\evil.txt'],
      ['Windows drive-relative', 'C:evil.txt'],
      ['UNC path', '\\\\server\\share\\evil.txt'],
      ['backslash traversal', '..\\..\\evil.txt'],
      ['traversal that normalizes back inside', 'a/../../evil.txt'],
      ['inner dot-dot that stays inside', 'a/../b.txt'],
      ['dot segment', './a.txt'],
      ['empty segment', 'a//b.txt'],
      ['empty path', ''],
      ['dot path', '.'],
      ['trailing dot-dot', 'a/..'],
      ['NUL byte', 'a.txt\0../../evil'],
    ])('refuses %s', async (_label, bad) => {
      const target = join(root, 'proj');
      const batch = [
        { path: 'package.json', content: '{}', rendered: false, unresolved: [] },
        { path: bad, content: 'pwned', rendered: false, unresolved: [] },
      ];
      await expect(writeAtomic(target, batch)).rejects.toThrow(/outside the target directory/);
      expect(existsSync(target)).toBe(false);
      // No staging directory is left behind next to the target either.
      expect(readdirSync(root).filter(n => n.startsWith('.create-agent-harness-'))).toEqual([]);
    });

    it('treats percent-encoded dot-dot as a literal filename (nothing decodes it)', async () => {
      const target = join(root, 'proj');
      await writeAtomic(target, [{ path: '%2e%2e/x.txt', content: 'ok', rendered: false, unresolved: [] }]);
      expect(existsSync(join(target, '%2e%2e', 'x.txt'))).toBe(true);
      expect(existsSync(join(root, 'x.txt'))).toBe(false);
    });
  });
});

function randomTraversalName(): string {
  return `writer-traversal-${Math.random().toString(36).slice(2)}.txt`;
}
