// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
// @ts-ignore - JS module
import { parseChangelog, renderNotes } from '../scripts/release-notes.mjs';

const execFile = promisify(execFileCb);
const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'release-notes.mjs');

async function runNotes(args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await execFile('node', [SCRIPT, ...args], { cwd: ROOT, windowsHide: true });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('release-notes — parseChangelog', () => {
  it('parses the canonical `### Added — Iter N (YYYY-MM-DD)` header', () => {
    const sample = `
### Added — Iter 35 (2026-06-13)

- A thing
- Another thing

### Fixed — Iter 36 (2026-06-13)

- A fix
`;
    const r = parseChangelog(sample);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ kind: 'Added', iter: 35, date: '2026-06-13' });
    expect(r[1]).toMatchObject({ kind: 'Fixed', iter: 36, date: '2026-06-13' });
    expect(r[0].body.join('\n')).toContain('A thing');
  });

  it('stops a section at the next `## ` heading', () => {
    const sample = `
### Added — Iter 1 (2026-06-01)

- entry one

## Unreleased

(unrelated content that should NOT be in iter 1)
`;
    const r = parseChangelog(sample);
    expect(r).toHaveLength(1);
    expect(r[0].body.join('\n')).not.toContain('unrelated content');
  });

  it('returns [] when no sections match', () => {
    expect(parseChangelog('# No matching headers here\n')).toEqual([]);
  });
});

describe('release-notes — renderNotes', () => {
  it('groups by kind (Added before Fixed)', () => {
    const sections = [
      { kind: 'Fixed', iter: 36, date: '2026-06-13', body: ['- fix1'] },
      { kind: 'Added', iter: 35, date: '2026-06-13', body: ['- add1'] },
    ];
    const out = renderNotes(sections);
    const addedIdx = out.indexOf('## Added');
    const fixedIdx = out.indexOf('## Fixed');
    expect(addedIdx).toBeGreaterThan(-1);
    expect(fixedIdx).toBeGreaterThan(addedIdx);
  });

  it('reports iter range correctly', () => {
    const sections = [
      { kind: 'Added', iter: 33, date: '2026-06-13', body: ['x'] },
      { kind: 'Added', iter: 37, date: '2026-06-13', body: ['y'] },
    ];
    expect(renderNotes(sections)).toMatch(/Iters 33–37 • 2 entries/);
  });

  it('handles the empty selection gracefully', () => {
    expect(renderNotes([])).toMatch(/No CHANGELOG entries/);
  });

  it('honors title when provided', () => {
    const out = renderNotes(
      [{ kind: 'Added', iter: 1, date: '2026-06-01', body: ['x'] }],
      { title: '# Release v0.2.0' }
    );
    expect(out).toContain('# Release v0.2.0');
  });
});

describe('release-notes script', () => {
  it('runs against the live CHANGELOG with --from-iter / --to-iter and exits 0', async () => {
    const r = await runNotes(['--from-iter=30', '--to-iter=35']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Iters 3[0-9]–3[0-9]/);
  }, 30_000);

  it('rejects a non-existent --since tag with non-zero exit', async () => {
    const r = await runNotes(['--since=v999.999.999']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/doesn't exist/);
  }, 30_000);
});
